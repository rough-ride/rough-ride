// One flow run (spec part 3 sections 11.4, 12.1 and 12.6, part 5 section
// 23.1): a fresh context, the steps in order, the ready wait after every full
// page load, and every step settled before the next starts.

import { randomInt } from 'node:crypto';
import type { Browser, BrowserContext, CDPSession, Locator, Page, Request, Route } from 'playwright-core';
import { MAX_BODY, sha256, type BodyKind } from './faults.mjs';
import { abortedHint, type AbortedWrite, type LocalhostGuard } from './guard.mjs';
import { LOOPBACK_ONLY, type HostPolicy } from './hosts.mjs';
import { hasCredentialHeader } from './secrets.mjs';

export const S = 10_000;
export const C = 30_000;
export const QUIET_MS = 500;
export const POLL_MS = 100;
const LOAD_IDLE_MS = 500;
const WORLD = 'rough-ride';

export type LocatorSpec = { role: string; name?: string } | { label: string } | { text: string } | { testId: string };

export type Step =
  | { goto: string }
  | { click: LocatorSpec }
  | { fill: LocatorSpec; value: string }
  | { select: LocatorSpec; value: string }
  | { check: LocatorSpec }
  | { press: LocatorSpec; key: string }
  | { expect: LocatorSpec };

export interface Flow {
  name: string;
  signedIn: boolean;
  steps: Step[];
}

export type StepKind = 'goto' | 'click' | 'fill' | 'select' | 'check' | 'press' | 'expect';

export function stepKind(step: Step): StepKind {
  return (['goto', 'click', 'fill', 'select', 'check', 'press', 'expect'] as const).find((k) => k in step)!;
}

// `button "Save"`, `role "alert"`, `label "Title"`, `text "Saved"`, `testId "save"`.
export function describeLocator(locator: LocatorSpec): string {
  if ('role' in locator) return locator.name === undefined ? `role "${locator.role}"` : `${locator.role} "${locator.name}"`;
  if ('label' in locator) return `label "${locator.label}"`;
  if ('text' in locator) return `text "${locator.text}"`;
  return `testId "${locator.testId}"`;
}

export function describeStep(step: Step): string {
  const kind = stepKind(step);
  if (kind === 'goto') return `goto ${(step as { goto: string }).goto}`;
  return `${kind} ${describeLocator((step as Record<string, LocatorSpec>)[kind]!)}`;
}

const UNIQUE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

// 8 lowercase letters and digits, fresh for every flow run.
export function newUnique(): string {
  let out = '';
  for (let i = 0; i < 8; i++) out += UNIQUE_ALPHABET[randomInt(UNIQUE_ALPHABET.length)];
  return out;
}

export function envNames(value: unknown): string[] {
  const names = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') for (const m of v.matchAll(/\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(m[1]!);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return [...names].sort();
}

export function resolvePlaceholders(text: string, unique: string, env: (name: string) => string | undefined): string {
  return text
    .replace(/\$\{unique\}/g, unique)
    .replace(/\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env(name) ?? '');
}

// The main-frame path as page keys use it: query dropped, percent-decoded, and
// a `#/` or `#!/` hash route appended.
export function normalisedPath(url: string): string {
  const u = new URL(url);
  let p = decodeURIComponent(u.pathname);
  if (u.hash.startsWith('#/') || u.hash.startsWith('#!/')) p += u.hash.split('?')[0];
  return p;
}

// `*` matches within one segment, `**` as a whole segment matches zero or more
// segments, everything else literally and case-sensitively.
export function matchesExclude(pattern: string, pagePath: string): boolean {
  const pat = pattern.split('/').filter(Boolean);
  const segs = pagePath.split('/').filter(Boolean);
  const segMatch = (p: string, s: string) =>
    new RegExp(`^${p.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`).test(s);
  const go = (i: number, j: number): boolean => {
    if (i === pat.length) return j === segs.length;
    if (pat[i] === '**') return go(i + 1, j) || (j < segs.length && go(i, j + 1));
    return j < segs.length && segMatch(pat[i]!, segs[j]!) && go(i + 1, j + 1);
  };
  return go(0, 0);
}

export type ReadyWait = { kind: 'nuxt' } | { kind: 'load' } | { kind: 'expression'; expression: string };

export interface RequestRecord {
  // 1-based index of the step that owns it: the last action step started before it.
  step: number;
  method: string;
  url: string;
  // `METHOD template #n` for fetch and XHR (section 16.4, without OpenAPI templates
  // yet); `METHOD path` for everything else.
  key: string;
  resourceType: string;
  // ms from the owning step's start.
  offsetMs: number;
  // The main frame's navigation request.
  navigation: boolean;
  // The main frame's page key when the request was sent.
  pagePath: string | null;
  // A Next.js server action's `Next-Action` header.
  nextAction?: string;
  status: number | null;
  failure: string | null;
  // For fetch and XHR, from the response after requestfinished.
  mediaType: string | null;
  emptyBody: boolean | null;
  // Still in flight when the flow run ended.
  streaming: boolean;
  jsonRoot: 'array' | 'object' | 'null' | 'scalar' | 'invalid' | 'none' | null;
  credentialed: boolean | null;
  // In memory only: the request body, for finding which request carried a field's value.
  postData: string | null;
  // The body was over 5 MiB and was not parsed.
  oversize: boolean;
  // In memory only: a finished 2xx JSON body, parsed, for the empty-200 rule.
  body?: unknown;
  // The body kind section 20.7 would serve, set once the OpenAPI documents are read.
  bodyKind?: BodyKind | null;
  // SHA-256 of the finished body, for one-write's equal-answer rule.
  bodySha256?: string;
  // The fault served this response or abort; no check counts it as the target's own.
  servedByFault: boolean;
}

export interface ControlFacts {
  tag: string;
  type: string | null;
  role: string | null;
  ariaPressed: string | null;
  ariaChecked: string | null;
  ariaExpanded: string | null;
}

// The labels of the runner's own reload, back and forward steps, and the start
// of a timed-out ready wait's reason (32.2). checks.mts judges by them.
export const RELOAD_LABEL = 'reload';
export const GO_LABEL_PREFIX = 'go ';
export const NOT_READY_PREFIX = 'not ready ';

export interface StepRecord {
  index: number;
  label: string;
  observation?: Observation;
  settled: boolean;
  settleMs: number;
  // The main frame's path (a page key) when the step ended.
  path: string | null;
  // For click and press: the target's facts, read before the action.
  control?: ControlFacts;
  // In memory only: the value a fill or select step used, placeholders resolved.
  value?: string;
  // `scrollWidth - innerWidth` of the page when the step ended, and innerWidth.
  overflowPx?: number;
  innerWidth?: number;
  // In memory only: section 21.4's element facts for fill, select and check steps.
  field?: FieldFacts;
}

export interface FieldFacts {
  tag: string;
  type: string | null;
  inputmode: string | null;
  autocomplete: string | null;
  role: string | null;
  required: boolean;
  ariaRequired: boolean;
  maxlength: number | null;
  minlength: number | null;
  min: string | null;
  max: string | null;
  step: string | null;
  pattern: string | null;
  multiple: boolean;
  readonly: boolean;
  disabled: boolean;
  contenteditable: boolean;
  novalidate: boolean;
  visible: boolean;
  options: { value: string; label: string; disabled: boolean; selected: boolean }[] | null;
  held: string | null;
}

export interface FaultEvent {
  at: number;
  // Monotonic ms from the attack point's request reaching the route.
  offsetMs: number;
  event: string;
  key: string;
  detail?: string;
}

// The response a fault served at the attack point: fixed bodies as they are,
// forwarded bodies only as kind, length and SHA-256.
export type Served =
  | { status: number; headers: Record<string, string>; body: string }
  | { status: number; headers: Record<string, string>; bodyKind: string; length: number; sha256: string }
  | { aborted: string }
  | { held: true }
  | { delayed: number };

export interface FaultState {
  fired: boolean;
  events: FaultEvent[];
  firedAt: number | null;
  // `Not applied: <attack id> (<reason>)`: the reason.
  notApplied: string | null;
  // A request was still held at H.
  pending: boolean;
  // The page gave up on a held or delayed request.
  givenUp: boolean;
  // A one-shot fault that a client retry got past with a real 2xx.
  absorbed: boolean;
  served: Served | null;
  holdMs: number;
}

export interface TextSample {
  at: number;
  lines: string[];
  live: string[];
}

export interface Observation {
  // Per step: the snapshot when it started, samples while it settled, the snapshot when it ended.
  before: Snapshot;
  samples: TextSample[];
  after: Snapshot;
  // The busy reason when the step did not settle.
  unsettled: string | null;
  windowEndedAt: number;
  startedAt: number;
}

export interface PageEvent {
  step: number;
  at: number;
  kind: 'exception' | 'pageerror' | 'console' | 'overlay';
  text: string;
}

export interface PageEntry {
  path: string;
  step: number;
  entry: 'full-load' | 'in-app';
  // Keys without #n of GET and HEAD fetch or XHR requests to own origins that the entry step sent.
  requests: string[];
  previous: string | null;
  // For a full-load entry: the method of its main-frame navigation request.
  method: string | null;
}

export interface FlowRunResult {
  passed: boolean;
  failure: { step: number; label: string; message: string } | null;
  // A flow run that navigated under an exclude pattern is stopped there.
  excluded: string | null;
  // A loopback origin that refused connections during the run.
  refused: string | null;
  steps: StepRecord[];
  requests: RequestRecord[];
  pages: PageEntry[];
  durationMs: number;
  dialogs: string[];
  unique: string;
  // Locators of fields filled from ${env...}, for screenshot masks.
  envFilled: LocatorSpec[];
  // Browser writes the localhost guard aborted during this run.
  aborted: AbortedWrite[];
  // Uncaught errors, page errors, dev overlays and Vue or React error lines, by step.
  pageEvents: PageEvent[];
  // A void flow run: the dev server reloaded the page, or a target request failed at network level.
  voided: 'dev server reloaded' | 'target unstable' | 'stopped at the hard stop' | null;
  fault: FaultState | null;
  // The attack ended after the attacked step's window (no recovery before ticket 20).
  endedAfterWindow: boolean;
  // A timing attack: when the doubled action started, and the step a later failure stopped the flow at.
  timing: { actionAt: number; action: 'double-clicked' | 'pressed twice' } | null;
  stoppedAt: number | null;
  // Fault recovery after the window: what the runner did, and whether the flow reached its goal.
  recovery: { action: string | null; passed: boolean; detail: string | null } | null;
  // In memory only: the page when each chosen step's window ended, fields filled from ${env} masked.
  shots: Map<number, Buffer>;
  // Native submit events and invalid events, by owning step (22.2).
  formEvents: {
    submits: { step: number; novalidate: boolean; formnovalidate: boolean }[];
    invalids: { step: number; id: number; visible: boolean; flags: string[]; browser: boolean }[];
  };
  badInput: BadInputResult | null;
  outOfOrder: OutOfOrderResult | null;
  pageTiming: PageTimingResult | null;
  // values-survive: each field filled before the attacked click, right before it and when the window ended.
  values: { field: string; before: string | null; after: string | null; password: boolean }[] | null;
  // The context's storageState, kept in memory only (the sign-in flow's session).
  storageState: Awaited<ReturnType<BrowserContext['storageState']>> | null;
  // An untrusted run's guard hit (44.5): the write or navigation it aborted.
  untrustedStop: string | null;
}

export interface RunFlowOptions {
  browser: Browser;
  baseURL: string;
  flow: Flow;
  storageState?: FlowRunResult['storageState'];
  env: (name: string) => string | undefined;
  ready: ReadyWait;
  exclude?: string[];
  // The Target's host rules; only loopback is its own without them.
  hosts?: HostPolicy;
  unique?: string;
  keepStorageState?: boolean;
  // Called at the failing step, with the page still open (baseline screenshots).
  onFailure?: (page: Page, masks: Locator[]) => Promise<void>;
  // Called after the last step of a run that did not fail, with the page still open (snapshots).
  onFinish?: (page: Page) => Promise<void>;
  timeouts?: { S?: number; C?: number };
  // The localhost guard, attached to the whole browser; it also turns the HTTP cache off.
  guard?: LocalhostGuard;
  // `METHOD template` for a request from the OpenAPI documents, or null to fall
  // back to the {} rules (with this run's own token and returned values).
  templateOf?: (method: string, url: string) => string | null;
  // Templates the baseline run repeated at a steady interval: left out of the settle tests.
  pollingKeys?: Set<string>;
  // Credential strings from the sign-in session (section 20.6).
  credentials?: string[];
  // The attack kind this flow run applies, if any; see AttackKind.
  kind?: AttackKind;
  // Screenshots kept in memory when a step's window ends: every step, or only these.
  shots?: 'all' | number[];
  // The hard stop (50.3): a flow run still going at this time (ms since the epoch) is void.
  deadline?: number;
  // A regression test's pinned time zone and locale (25.4); attacks never set them.
  pin?: { timezone: string; locale: string };
  // repro --keep-open (14.6, 14.8): run in this context and leave it open, keep the
  // fault armed after the window, and leave dialogs open for the MCP.
  context?: BrowserContext;
  keepArmed?: boolean;
  keepDialogs?: boolean;
  // flow save baseline runs and snapshot steps (44.5): abort writes to records this
  // run did not create and main-frame navigations to other sites.
  untrusted?: boolean;
  // App-specific checks (45.7): called with the live page after each step settles,
  // before a fault clears or a recovery starts, and once after the last step of a
  // run that completed every step. `locate` resolves ${unique} as the steps do.
  onPoint?: (page: Page, locate: (spec: LocatorSpec) => Locator, point: { step: number; end: boolean; recovery: boolean; requests: number; records: number }) => Promise<void>;
}

// An attack kind as the flow run engine sees it. The engine owns the step
// queue, the recovery queue, settling and the Observation window, request
// recording, routes and Not applied; a kind adds its own rules at fixed points.
export interface AttackKind {
  // The flow run's viewport; 1280 x 800 otherwise.
  viewport?: { width: number; height: number };
  // Added to every action and expect timeout.
  actionMs?: number;
  // Called once the page and its instrumentation exist, before the first step.
  start(engine: FlowRunEngine): KindHooks | Promise<KindHooks>;
}

// A step as the engine hands it to a kind.
export interface StepAt {
  index: number;
  step: Step;
  kind: StepKind;
  label: string;
  startedAt: number;
}

// What a kind's own action did: when the Observation window starts (the
// step's start otherwise), when its ceiling counts from (the window's start
// otherwise), and the value the step record keeps.
export interface Acted {
  windowFrom?: number;
  ceilingFrom?: number;
  value?: string;
}

// A step's Observation window once it ended.
export interface StepWindow {
  before: Snapshot;
  samples: TextSample[];
  after: Snapshot;
  // The main frame's page key when the step ended.
  path: string | null;
}

// How the attack goes on after a step's window (23.6): the flow goes on, the
// attack ends there, or these steps run as its recovery (23.7).
export type WindowEnd =
  // `skip`: a later step the kind already ran.
  | { then: 'continue'; skip?: number }
  // `unrecovered`: a recovery was due but has no step to run.
  | { then: 'end'; unrecovered?: string }
  | { then: 'recover'; steps: { index: number; step: Step }[]; action: string };

// The attack could not be applied: the engine ends the flow run there, and the
// kind's notApplied hook records the reason.
export class NotApplied extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

// The points of a flow run where a kind's rules apply. Step hooks run only
// until a recovery starts; recovery steps are the flow's own.
export interface KindHooks {
  // Before the step's action, and before its page snapshot.
  beforeStep?(at: StepAt): Promise<void>;
  // In place of a click, press, check, fill or select step's own action, or
  // undefined to leave the step to the engine. A NotApplied ends the attack.
  act?(at: StepAt, locator: Locator, before: Snapshot): Promise<Acted | undefined>;
  // Whether to keep a screenshot of this step when its window ends, beyond the run's `shots`.
  wantsShot?(after: Snapshot): boolean;
  // Facts the kind adds to the step record when the step's window ends.
  stepFacts?(after: Snapshot): Partial<StepRecord>;
  // After a step's window ended and its page entry was recorded.
  afterWindow?(at: StepAt, window: StepWindow): Promise<WindowEnd>;
  // The reason of a NotApplied thrown from a hook.
  notApplied?(reason: string): void;
  // A fetch or XHR request finished, with its status read.
  responded?(request: Request, record: RequestRecord): void;
  // Any request of the flow run failed.
  requestFailed?(request: Request, failure: string): void;
  // Read while a step settles: a Pending request ends the window, a held one
  // keeps it open past S, and these events start grace periods (23.2, 23.3).
  settling?(): { pending: boolean; holding: boolean; events: { at: number; key: string }[] };
  // An own-origin request that failed without the page aborting it, which
  // otherwise voids the run as target unstable: whether the kind caused it.
  excusesFailure?(record: RequestRecord | undefined): boolean;
  // A later step failed: whether that stops the flow after the attack
  // (`Faulted; flow stopped at step <n>`) rather than failing the flow run.
  stopsFlow?(index: number): boolean;
  // When the flow run ends, before its context closes.
  close?(): Promise<void>;
}

// What the engine hands a kind: this flow run's result, page and primitives.
export interface FlowRunEngine {
  // The kind writes only its own slots.
  readonly result: FlowRunResult;
  readonly flow: Flow;
  readonly unique: string;
  // repro --keep-open (14.8): the attack stays applied after its window.
  readonly keepArmed: boolean;
  // The step that owns requests now: the last action step started.
  owner(): number;
  // A response or abort the attack served, which no check counts as the target's own.
  markServed(request: Request): void;
  // Awaits the response bodies still being read.
  responses(): Promise<void>;
  readonly page: Page;
  readonly context: BrowserContext;
  // The step timeout S, the action and expect timeout, and the load timeout C.
  readonly timeouts: { step: number; action: number; load: number };
  readonly readyKind: ReadyWait['kind'];
  // Credential strings from the sign-in session (20.6).
  readonly credentials: string[];
  ownHost(url: string): boolean;
  // `METHOD template` of a request, as attack points key it.
  templateFor(method: string, url: string): string;
  // Resolves a flow locator, ${unique} and ${env} included, on this run's page.
  locate(spec: LocatorSpec): Locator;
  resolve(text: string): string;
  // The page's state from the isolated world.
  snapshot(): Promise<Snapshot>;
  // The values of these fill, select and check steps' fields now.
  fieldValues(indices: number[]): Promise<{ field: string; value: string | null; password: boolean }[]>;
  // The method of the request that loaded the document now showing.
  documentMethod(): string;
  // Deletes the cookies of the Target's own hosts.
  clearOwnCookies(): Promise<void>;
  // Adds a route handler on this run's context, consulted before the ones
  // added earlier; the returned function removes this handler only.
  route(handler: (route: Route, request: Request) => Promise<unknown>): Promise<() => Promise<void>>;
  // The runner's own reload, back or forward at step `index` (32.2), settled
  // like an action step and recorded as its own step. `arrived` sees the
  // navigation's outcome once it committed, before the ready wait and settle.
  navigate(index: number, what: 'reload' | 'back' | 'forward', notes: NavigationNotes): Promise<{ path: string | null; ready: boolean }>;
}

export interface NavigationNotes {
  // A beforeunload dialog the navigation raised was accepted.
  beforeUnload(): void;
  arrived(nav: { status: number | null; error: string | null; redirected: string | null; path: string | null }): void;
}

export interface PageTimingResult {
  notApplied: string | null;
  events: { at: number; event: string; detail?: string }[];
  // Main-frame document status and navigation error after the runner's own navigation.
  documentStatus: number | null;
  navigationError: string | null;
  // Credentials removed or refused, for signed-out-reload.
  removed: number;
  served401: number;
}

export interface OutOfOrderResult {
  notApplied: string | null;
  aborted: boolean;
  releasedAt: number | null;
  // Visible lines just before the release.
  linesBefore: string[];
  // String leaves of at least 4 characters with a letter that only one answer carried; null when an answer isn't JSON.
  olderOnly: string[] | null;
  newerOnly: string[] | null;
}

export interface BadInputResult {
  notApplied: string | null;
  held: string | null;
  // The page's visible lines right before the bad fill.
  linesBefore: string[];
  reference: { field: string; value: string | null; password: boolean }[];
  after: { field: string; value: string | null; password: boolean }[];
  submitDisabled: boolean;
  submittedAt: number | null;
  outcome: BadOutcome | null;
  carrying: { method: string; path: string; status: number | null; failure: string | null } | null;
}

export type BadOutcome = 'crashed' | 'inconclusive' | 'rejected' | 'blocked-by-browser' | 'blocked-by-app' | 'silent-refusal' | 'accepted';

// Runs in an isolated world the page can't reach: counts DOM mutations and
// reads busy indicators and disabled controls.
// It also records native submit events and invalid events (22.2): an invalid
// counts as browser-raised when, at the next task, focus sits on its control,
// which a native submit, requestSubmit() and reportValidity() do and
// checkValidity() doesn't. Open shadow roots get the same listeners.
const OBSERVER = `(() => {
  const state = { mutations: 0 };
  globalThis.__roughRide = state;
  // Events reach the runner through a CDP binding, so a form post's submit
  // survives the navigation it starts.
  const send = (event) => { try { globalThis.__roughRideEvent(JSON.stringify(event)); } catch {} };
  let invalidId = 0;
  const FLAGS = ['valueMissing', 'typeMismatch', 'patternMismatch', 'tooLong', 'tooShort', 'rangeUnderflow', 'rangeOverflow', 'stepMismatch', 'badInput', 'customError'];
  const roots = new WeakSet();
  const listen = (root) => {
    if (roots.has(root)) return;
    roots.add(root);
    root.addEventListener('submit', (e) => {
      const form = e.target;
      send({ t: 'submit', novalidate: !!form.noValidate, formnovalidate: !!(e.submitter && e.submitter.formNoValidate) });
    }, true);
    root.addEventListener('invalid', (e) => {
      const el = e.target;
      const id = ++invalidId;
      send({ t: 'invalid', id, visible: el.checkVisibility ? el.checkVisibility() : true, flags: FLAGS.filter((f) => el.validity && el.validity[f]) });
      setTimeout(() => {
        let a = document.activeElement;
        while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
        if (a === el) send({ t: 'invalid-browser', id });
      }, 0);
    }, true);
  };
  listen(window);
  const scan = (node) => {
    if (node.shadowRoot) listen(node.shadowRoot);
    if (node.querySelectorAll) for (const el of node.querySelectorAll('*')) if (el.shadowRoot) listen(el.shadowRoot);
  };
  const start = () => {
    scan(document);
    new MutationObserver((list) => {
      state.mutations += list.length;
      for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n);
    }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})()`;

// The facts section 21.4 reads from the element a fill, select or check step resolved to.
const FIELD_FACTS = `(el) => {
  const attr = (n) => el.getAttribute(n);
  const num = (n) => (el.hasAttribute(n) ? Number(attr(n)) : null);
  const form = el.form || el.closest('form');
  return {
    tag: el.tagName.toLowerCase(),
    type: el.tagName === 'INPUT' ? (el.type || 'text') : null,
    inputmode: attr('inputmode'),
    autocomplete: attr('autocomplete'),
    role: attr('role'),
    required: !!el.required,
    ariaRequired: attr('aria-required') === 'true',
    maxlength: el.hasAttribute('maxlength') ? Number(attr('maxlength')) : null,
    minlength: el.hasAttribute('minlength') ? Number(attr('minlength')) : null,
    min: attr('min'),
    max: attr('max'),
    step: attr('step'),
    pattern: attr('pattern'),
    multiple: !!el.multiple,
    readonly: !!el.readOnly,
    disabled: !!el.disabled,
    contenteditable: !!el.isContentEditable,
    novalidate: !!(form && form.noValidate),
    visible: el.checkVisibility ? el.checkVisibility() : true,
    options: el.tagName === 'SELECT' ? [...el.options].map((o) => ({ value: o.value, label: o.label, disabled: o.disabled, selected: o.selected })) : null,
    held: el.isContentEditable ? el.innerText : ('value' in el ? String(el.value) : null),
  };
}`;

const SNAPSHOT = `(() => {
  const visible = (el) => el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true;
  const busyEls = [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"], [class*="spin" i], [class*="loading" i], [class*="loader" i]')].filter(visible);
  const controls = [...document.querySelectorAll('button, input, select, textarea, [role="button"]')];
  const disabled = controls.map((el, i) => (el.disabled || el.getAttribute('aria-disabled') === 'true') && visible(el) ? i + ':' + (el.name || el.textContent || '').trim().slice(0, 40) : null).filter(Boolean);
  const overlaySel = 'nuxt-error-overlay, vite-error-overlay';
  const overlay = !!document.querySelector(overlaySel);
  const body = document.body;
  let lines = [];
  if (body) {
    // Visible text, without dev overlays, one entry per line.
    const text = body.innerText || '';
    lines = text.split('\\n').map((l) => l.trim()).filter(Boolean);
  }
  const live = [...document.querySelectorAll('[role="alert"], [role="status"], [aria-live]:not([aria-live="off"])')]
    .filter(visible).map((el) => (el.innerText || '').trim()).filter(Boolean);
  const labels = [...document.querySelectorAll('label, button, [role="button"], a')].filter(visible).map((el) => (el.innerText || '').trim()).filter(Boolean);
  return {
    busy: busyEls.length > 0,
    busyWhat: busyEls.slice(0, 1).map((el) => (el.getAttribute('aria-label') || el.className || el.tagName).toString().slice(0, 60))[0] || null,
    disabled, overlay, lines, live, labels,
    overflow: document.documentElement.scrollWidth - innerWidth,
    innerWidth,
    mutations: (globalThis.__roughRide && globalThis.__roughRide.mutations) || 0,
  };
})()`;

export interface Snapshot {
  busy: boolean;
  busyWhat: string | null;
  disabled: string[];
  overlay: boolean;
  lines: string[];
  live: string[];
  labels: string[];
  overflow: number;
  innerWidth: number;
  mutations: number;
}

const EMPTY_SNAPSHOT: Snapshot = { busy: false, busyWhat: null, disabled: [], overlay: false, lines: [], live: [], labels: [], overflow: 0, innerWidth: 0, mutations: 0 };

class StepError extends Error {}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The dev server's own files (Nuxt's /_nuxt/ base, Vite's /@vite/ client, Nuxt
// dev endpoints): never entry requests and never attack points.
export function isFrameworkInternal(url: string): boolean {
  try {
    const p = new URL(url).pathname;
    return p.startsWith('/_nuxt/') || p.startsWith('/@vite/') || p.startsWith('/@id/') || p.startsWith('/@fs/') || p.startsWith('/__nuxt');
  } catch {
    return false;
  }
}

// The main frame's path as a page key: {} rules for segments and the hash route.
export function pagePath(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    let p = templatePath(u.pathname, '', new Set());
    if (u.hash.startsWith('#/') || u.hash.startsWith('#!/')) {
      const hashPath = u.hash.slice(u.hash.indexOf('/')).split('?')[0]!;
      p += `#${u.hash.startsWith('#!') ? '!' : ''}${templatePath(hashPath, '', new Set())}`;
    }
    return p;
  } catch {
    return null;
  }
}

function templateSegment(segment: string, unique: string, returned: Set<string>): string {
  const dot = segment.lastIndexOf('.');
  const value = dot > 0 ? segment.slice(0, dot) : segment;
  const ext = dot > 0 ? segment.slice(dot) : '';
  const isValue = (v: string) =>
    /^\d+$/.test(v) || UUID.test(v) || /^[0-9a-f]{16,}$/i.test(v) || (unique !== '' && v.includes(unique)) || returned.has(v);
  if (isValue(segment)) return '{}';
  if (ext && isValue(value)) return `{}${ext}`;
  return segment;
}

export function templatePath(pathname: string, unique: string, returned: Set<string>): string {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Keep the raw path.
  }
  return decoded.split('/').map((s) => (s === '' ? s : templateSegment(s, unique, returned))).join('/');
}

// `METHOD template` (section 16.4) without OpenAPI templates, which ticket 17 adds.
export function requestTemplate(method: string, url: string, unique: string, returned: Set<string>): string {
  try {
    return `${method} ${templatePath(new URL(url).pathname, unique, returned)}`;
  } catch {
    return `${method} ${url}`;
  }
}

function jsonRootOf(body: Buffer, mediaType: string | null): RequestRecord['jsonRoot'] {
  if (body.length === 0) return 'none';
  if (mediaType !== null && !/json/.test(mediaType)) return 'none';
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value === 'object' ? 'object' : 'scalar';
  } catch {
    return 'invalid';
  }
}

function collectLeaves(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 8 || into.size > 5000) return;
  // Only values that look like ids or slugs: a returned "open" or "notes" must not
  // turn /api/tasks/open into /api/tasks/{}.
  const idLike = (v: string) => v.length <= 200 && !/\s/.test(v) && (/\d/.test(v) || v.length >= 8);
  if (typeof value === 'string' && idLike(value)) into.add(value);
  else if (typeof value === 'number' && Number.isFinite(value)) into.add(String(value));
  else if (Array.isArray(value)) value.forEach((v) => collectLeaves(v, into, depth + 1));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectLeaves(v, into, depth + 1));
}

async function controlFacts(locator: Locator, timeout: number): Promise<ControlFacts | undefined> {
  try {
    return await locator.evaluate(
      (el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        role: el.getAttribute('role'),
        ariaPressed: el.getAttribute('aria-pressed'),
        ariaChecked: el.getAttribute('aria-checked'),
        ariaExpanded: el.getAttribute('aria-expanded'),
      }),
      undefined,
      { timeout },
    );
  } catch {
    return undefined;
  }
}

export async function runFlow(options: RunFlowOptions): Promise<FlowRunResult> {
  const stepTimeout = options.timeouts?.S ?? S;
  const actionTimeout = stepTimeout + (options.kind?.actionMs ?? 0);
  const loadTimeout = options.timeouts?.C ?? C;
  const unique = options.unique ?? newUnique();
  const resolve = (text: string) => resolvePlaceholders(text, unique, options.env);
  const ownHost = (options.hosts ?? LOOPBACK_ONLY).ownHost;

  const result: FlowRunResult = {
    passed: false,
    failure: null,
    excluded: null,
    refused: null,
    steps: [],
    requests: [],
    pages: [],
    durationMs: 0,
    dialogs: [],
    unique,
    envFilled: [],
    aborted: [],
    pageEvents: [],
    voided: null,
    fault: null,
    endedAfterWindow: false,
    timing: null,
    stoppedAt: null,
    recovery: null,
    pageTiming: null,
    outOfOrder: null,
    badInput: null,
    shots: new Map(),
    formEvents: { submits: [], invalids: [] },
    values: null,
    storageState: null,
    untrustedStop: null,
  };

  const context = options.context ?? await options.browser.newContext({
    baseURL: options.baseURL,
    serviceWorkers: 'block',
    viewport: options.kind?.viewport ?? { width: 1280, height: 800 },
    ...(options.pin ? { timezoneId: options.pin.timezone, locale: options.pin.locale } : {}),
    ...(options.storageState ? { storageState: options.storageState } : {}),
  });
  const page = await context.newPage();
  const cdp: CDPSession = await context.newCDPSession(page);
  if (!options.guard) {
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  }
  const targetInfo = (await cdp.send('Target.getTargetInfo')) as { targetInfo: { browserContextId?: string } };
  const browserContextId = targetInfo.targetInfo.browserContextId ?? '';
  await cdp.send('Page.enable');
  const tree = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
  const mainFrameId = tree.frameTree.frame.id;
  let worldId: number | null = null;
  cdp.on('Runtime.executionContextCreated', (event: { context: { id: number; name: string; auxData?: { frameId?: string } } }) => {
    if (event.context.name === WORLD && event.context.auxData?.frameId === mainFrameId) worldId = event.context.id;
  });
  cdp.on('Runtime.executionContextsCleared', () => {
    worldId = null;
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Runtime.addBinding', { name: '__roughRideEvent', executionContextName: WORLD });
  cdp.on('Runtime.bindingCalled', (event: { name: string; payload: string }) => {
    if (event.name !== '__roughRideEvent') return;
    let e: { t: string; id?: number; visible?: boolean; flags?: string[]; novalidate?: boolean; formnovalidate?: boolean };
    try {
      e = JSON.parse(event.payload);
    } catch {
      return;
    }
    if (e.t === 'submit') result.formEvents.submits.push({ step: owner, novalidate: !!e.novalidate, formnovalidate: !!e.formnovalidate });
    else if (e.t === 'invalid') result.formEvents.invalids.push({ step: owner, id: e.id ?? 0, visible: !!e.visible, flags: e.flags ?? [], browser: false });
    else if (e.t === 'invalid-browser') {
      const rec = result.formEvents.invalids.find((x) => x.id === e.id && x.step === owner);
      if (rec) rec.browser = true;
    }
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER, worldName: WORLD });
  // Uncaught errors come from CDP, which page code can't replace; console lines
  // whose source is the network (Failed to load resource) never count.
  cdp.on('Runtime.exceptionThrown', (event: { exceptionDetails: { text?: string; exception?: { description?: string } } }) => {
    const d = event.exceptionDetails;
    result.pageEvents.push({ step: owner, at: Date.now(), kind: 'exception', text: (d.exception?.description ?? d.text ?? 'exception').split('\n')[0]!.slice(0, 200) });
  });
  await cdp.send('Log.enable').catch(() => {});
  if (options.guard) await cdp.send('Network.enable').catch(() => {});
  cdp.on('Network.responseReceivedExtraInfo', (event: { requestId: string; statusCode?: number }) => {
    if (event.statusCode !== undefined) extraStatus.set(event.requestId, event.statusCode);
  });

  const snapshot = async (): Promise<Snapshot> => {
    if (worldId === null) return EMPTY_SNAPSHOT;
    try {
      const reply = (await cdp.send('Runtime.evaluate', { expression: SNAPSHOT, contextId: worldId, returnByValue: true })) as {
        result: { value?: Snapshot };
      };
      return reply.result.value ?? EMPTY_SNAPSHOT;
    } catch {
      return EMPTY_SNAPSHOT;
    }
  };

  let owner = 0;
  let stepStartedAt = Date.now();
  let navigated = false;
  let navigationMethod: string | null = null;
  let lastRequestAt = Date.now();
  const runStartedAt = Date.now();
  const inflight = new Set<Request>();
  const byRequest = new Map<Request, RequestRecord>();
  const keyCounts = new Map<string, number>();
  // Values earlier responses returned, so ids in later paths become {}.
  const returned = new Set<string>();
  // Values own-origin 2xx responses returned: records this flow run created (44.5).
  const created = new Set<string>();
  const pendingResponses: Promise<void>[] = [];
  const faulted = new Set<Request>();
  const extraStatus = new Map<string, number>();
  const polling = options.pollingKeys ?? new Set<string>();
  const templateFor = (method: string, url: string) => options.templateOf?.(method, url) ?? requestTemplate(method, url, unique, returned);

  page.on('pageerror', (error) => {
    result.pageEvents.push({ step: owner, at: Date.now(), kind: 'pageerror', text: String(error.message ?? error).split('\n')[0]!.slice(0, 200) });
  });
  page.on('console', (message) => {
    const text = message.text();
    if (text.startsWith('[Vue warn]: Unhandled error') || text.startsWith('Uncaught')) {
      result.pageEvents.push({ step: owner, at: Date.now(), kind: 'console', text: text.split('\n')[0]!.slice(0, 200) });
    }
  });
  // The dev server's channel: a Vite full-reload or update voids the run.
  page.on('websocket', (ws) => {
    ws.on('framereceived', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload)) as { type?: string };
        if (message.type === 'full-reload' || message.type === 'update') result.voided ??= 'dev server reloaded';
      } catch {
        // Not a Vite message.
      }
    });
  });
  let hooks: KindHooks = {};
  // Set while the runner's own reload, back or forward runs.
  let ownNavigation: NavigationNotes | null = null;
  // The method of the request that loaded the document now showing.
  let documentMethod = 'GET';
  page.on('dialog', (dialog) => {
    // A beforeunload raised by the runner's own reload, back or forward is accepted (32.2).
    if (ownNavigation && dialog.type() === 'beforeunload') {
      ownNavigation.beforeUnload();
      dialog.accept().catch(() => {});
      return;
    }
    result.dialogs.push(`${dialog.type()}: ${dialog.message().slice(0, 200)}`);
    if (!options.keepDialogs) dialog.dismiss().catch(() => {});
  });
  // Context events cover every page, popup, iframe and worker of the flow run.
  context.on('request', (request) => {
    lastRequestAt = Date.now();
    let mainNavigation = false;
    try {
      mainNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame();
    } catch {
      // A service worker's request has no frame.
    }
    if (mainNavigation) {
      navigated = true;
      navigationMethod = request.method();
      documentMethod = request.method();
    }
    const url = request.url();
    const type = request.resourceType();
    let key = url;
    if (type === 'fetch' || type === 'xhr') {
      const template = requestTemplate(request.method(), url, unique, returned);
      const n = (keyCounts.get(template) ?? 0) + 1;
      keyCounts.set(template, n);
      key = `${template} #${n}`;
    } else {
      try {
        key = `${request.method()} ${new URL(url).pathname}`;
      } catch {
        // A data: or blob: URL keeps its text.
      }
    }
    const record: RequestRecord = {
      step: owner,
      method: request.method(),
      url,
      key,
      resourceType: type,
      offsetMs: Date.now() - stepStartedAt,
      navigation: mainNavigation,
      pagePath: mainNavigation ? pagePath(url) : pagePath(page.url()),
      ...(request.headers()['next-action'] ? { nextAction: request.headers()['next-action'] } : {}),
      status: null,
      failure: null,
      mediaType: null,
      emptyBody: null,
      streaming: false,
      jsonRoot: null,
      credentialed: null,
      postData: request.postData(),
      oversize: false,
      servedByFault: faulted.has(request),
    };
    byRequest.set(request, record);
    result.requests.push(record);
    if (ownHost(url) && (type === 'fetch' || type === 'xhr')) inflight.add(request);
  });
  context.on('requestfinished', (request) => {
    inflight.delete(request);
    const record = byRequest.get(request);
    if (!record) return;
    pendingResponses.push(
      (async () => {
        const response = await request.response().catch(() => null);
        record.status = response?.status() ?? null;
        if (record.resourceType !== 'fetch' && record.resourceType !== 'xhr') return;
        const headers = await request.allHeaders().catch(() => ({}) as Record<string, string>);
        record.credentialed = Boolean(headers.cookie) || hasCredentialHeader(headers, options.credentials ?? []);
        record.mediaType = (response?.headers()['content-type'] ?? '').split(';')[0]!.trim().toLowerCase() || null;
        hooks.responded?.(request, record);
        const size = Number(response?.headers()['content-length'] ?? 0);
        if (!response || size > MAX_BODY) {
          record.jsonRoot = 'none';
          record.oversize = size > MAX_BODY;
          return;
        }
        const body = await response.body().catch(() => null);
        if (body === null || body.length > MAX_BODY) {
          record.jsonRoot = 'none';
          record.oversize = body !== null;
          return;
        }
        record.emptyBody = body.length === 0;
        record.bodySha256 = sha256(body);
        record.jsonRoot = jsonRootOf(body, record.mediaType);
        if (record.jsonRoot === 'array' || record.jsonRoot === 'object' || record.jsonRoot === 'null') {
          try {
            const value = JSON.parse(body.toString('utf8')) as unknown;
            collectLeaves(value, returned);
            if (record.status !== null && record.status >= 200 && record.status < 300 && ownHost(record.url)) collectLeaves(value, created);
            if (record.status !== null && record.status >= 200 && record.status < 300 && !record.servedByFault) record.body = value;
          } catch {
            // jsonRootOf already said invalid.
          }
        }
      })(),
    );
  });
  context.on('requestfailed', (request) => {
    inflight.delete(request);
    const record = byRequest.get(request);
    const failure = request.failure()?.errorText ?? 'failed';
    if (record) record.failure = failure;
    hooks.requestFailed?.(request, failure);
    if (/ERR_CONNECTION_REFUSED/.test(failure) && ownHost(request.url()) && result.refused === null) {
      result.refused = new URL(request.url()).origin;
    }
    // An unfaulted request to the target that failed without the page aborting it.
    if (!faulted.has(request) && !hooks.excusesFailure?.(record) && ownHost(request.url()) && !/ERR_ABORTED|ERR_CONNECTION_REFUSED|ERR_BLOCKED_BY_CLIENT/.test(failure)) {
      result.voided ??= 'target unstable';
    }
  });

  const markServed = (request: Request) => {
    faulted.add(request);
    const record = byRequest.get(request);
    if (record) record.servedByFault = true;
  };
  const clearOwnCookies = async () => {
    const domains = new Set((await context.cookies()).map((c) => c.domain));
    for (const domain of domains) {
      if (ownHost(`http://${domain.replace(/^\./, '')}/`)) await context.clearCookies({ domain }).catch(() => {});
    }
  };
  const engine: FlowRunEngine = {
    result,
    flow: options.flow,
    unique,
    keepArmed: options.keepArmed ?? false,
    owner: () => owner,
    markServed,
    responses: async () => {
      await Promise.all(pendingResponses);
    },
    page,
    context,
    timeouts: { step: stepTimeout, action: actionTimeout, load: loadTimeout },
    readyKind: options.ready.kind,
    credentials: options.credentials ?? [],
    ownHost,
    templateFor,
    locate: (spec) => locate(spec),
    resolve,
    snapshot,
    fieldValues: (indices) => fieldValuesOf(indices),
    documentMethod: () => documentMethod,
    clearOwnCookies,
    route: async (handler) => {
      // Its own matcher, so unrouting it never removes another handler.
      const matcher = () => true;
      await context.route(matcher, handler);
      return () => context.unroute(matcher, handler).catch(() => {});
    },
    navigate: (index, what, notes) => runnerNavigation(index, what, notes),
  };
  if (options.kind) hooks = await options.kind.start(engine);
  // Untrusted runs (44.5).
  if (options.untrusted) {
    // A path segment, with or without its extension, that an earlier response returned.
    const holdsCreated = (url: string) => {
      let pathname = new URL(url).pathname;
      try {
        pathname = decodeURIComponent(pathname);
      } catch {
        // Keep the raw path.
      }
      return pathname.split('/').some((s) => s !== '' && (created.has(s) || created.has(s.replace(/\.[^.]*$/, ''))));
    };
    await context.route(() => true, async (route, request) => {
      const url = request.url();
      let main = false;
      try {
        main = request.isNavigationRequest() && request.frame().parentFrame() === null;
      } catch {
        // A service worker's request has no frame.
      }
      if (main && /^https?:$/.test(new URL(url).protocol) && !ownHost(url)) {
        result.untrustedStop ??= `step ${owner} opens another site: ${new URL(url).hostname}`;
        return route.abort('blockedbyclient').catch(() => {});
      }
      if (ownHost(url) && ['PUT', 'PATCH', 'DELETE'].includes(request.method())) {
        if (!holdsCreated(url)) await Promise.all(pendingResponses);
        if (!holdsCreated(url)) {
          result.untrustedStop ??= `step ${owner} sends ${templateFor(request.method(), url)} to a record this flow did not create`;
          return route.abort('blockedbyclient').catch(() => {});
        }
      }
      return route.fallback();
    });
  }
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame() || result.excluded !== null) return;
    let p: string;
    try {
      p = normalisedPath(frame.url());
    } catch {
      return;
    }
    if ((options.exclude ?? []).some((pattern) => matchesExclude(pattern, p))) result.excluded = p;
  });

  const locate = (spec: LocatorSpec): Locator => {
    if ('role' in spec) {
      return page.getByRole(spec.role as Parameters<Page['getByRole']>[0], spec.name === undefined ? {} : { name: resolve(spec.name) });
    }
    if ('label' in spec) return page.getByLabel(resolve(spec.label));
    if ('text' in spec) return page.getByText(resolve(spec.text));
    return page.getByTestId(resolve(spec.testId));
  };

  const readyWait = async (startedAt: number) => {
    const remaining = Math.max(0, loadTimeout - (Date.now() - startedAt));
    if (options.ready.kind === 'load') {
      await page.waitForLoadState('load', { timeout: remaining });
      for (;;) {
        if (Date.now() - lastRequestAt >= LOAD_IDLE_MS) return;
        if (Date.now() - startedAt > loadTimeout) throw new Error('ready');
        await page.waitForTimeout(50);
      }
    }
    const expression =
      options.ready.kind === 'nuxt'
        ? '(() => { try { return window.useNuxtApp?.().isHydrating === false } catch { return false } })()'
        : `(() => { try { return Boolean(${options.ready.expression}) } catch { return false } })()`;
    await page.waitForFunction(expression, null, { timeout: remaining, polling: 50 });
  };

  // Waits until the step settles under `settles` (section 23.2): no busy
  // indicator, no own-origin request in flight (polling keys aside), 500 ms with
  // no DOM mutation, and the grace periods after fault events. S counts from the
  // later of `from` and the last fault event; C caps it from the step's start.
  const settle = async (before: Snapshot, from: number, stepStart: number, samples: TextSample[]): Promise<{ settled: boolean; ms: number; unsettled: string | null; after: Snapshot }> => {
    let last = await snapshot();
    let quietSince = Date.now();
    for (;;) {
      await page.waitForTimeout(POLL_MS);
      if (page.isClosed()) return { settled: true, ms: Date.now() - from, unsettled: null, after: last };
      const now = await snapshot();
      const at = Date.now();
      samples.push({ at, lines: now.lines, live: now.live });
      if (options.deadline !== undefined && at > options.deadline) {
        result.voided = 'stopped at the hard stop';
        return { settled: true, ms: at - from, unsettled: null, after: now };
      }
      const held = hooks.settling?.();
      // A request still held at H ends the window: Pending, settles not evaluated.
      if (held?.pending) return { settled: false, ms: at - from, unsettled: 'a held request is still pending', after: now };
      if (now.overlay && !last.overlay) result.pageEvents.push({ step: owner, at, kind: 'overlay', text: 'dev error overlay' });
      if (now.mutations !== last.mutations) quietSince = at;
      last = now;
      const stuck = now.disabled.filter((d) => !before.disabled.includes(d));
      const inflightNow = [...inflight].filter((r) => !polling.has(templateFor(r.method(), r.url())));
      const busy = now.busy || stuck.length > 0 || inflightNow.length > 0;
      const events = held?.events ?? [];
      const lastEvent = events.at(-1);
      const sameKey = lastEvent ? events.filter((e) => e.key === lastEvent.key).length : 0;
      const grace = !lastEvent ? 0 : sameKey >= 2 ? 5000 : 2000;
      const graceDone = !lastEvent || at - lastEvent.at >= grace;
      if (!busy && at - quietSince >= QUIET_MS && graceDone) return { settled: true, ms: at - from, unsettled: null, after: now };
      const sFrom = Math.max(from, lastEvent?.at ?? 0);
      const why = now.busy ? `busy indicator ${now.busyWhat ?? ''}`.trim()
        : stuck.length > 0 ? `control stays disabled (${stuck[0]!.replace(/^\d+:/, '')})`
        : inflightNow.length > 0 ? 'a request is still in flight'
        : 'the page keeps changing';
      // A held request keeps the window open until H, not S (23.2).
      if (at - sFrom > stepTimeout && graceDone && !held?.holding) return { settled: false, ms: at - from, unsettled: why, after: now };
      if (at - stepStart > loadTimeout) return { settled: false, ms: at - from, unsettled: why, after: now };
    }
  };

  const runnerNavigation = async (index: number, what: 'reload' | 'back' | 'forward', notes: NavigationNotes): Promise<{ path: string | null; ready: boolean }> => {
    const before = await snapshot();
    ownNavigation = notes;
    navigated = false;
    const navStart = Date.now();
    let response: Awaited<ReturnType<Page['reload']>> = null;
    let error: string | null = null;
    try {
      response = what === 'reload' ? await page.reload({ waitUntil: 'commit', timeout: loadTimeout })
        : what === 'back' ? await page.goBack({ waitUntil: 'commit', timeout: loadTimeout })
        : await page.goForward({ waitUntil: 'commit', timeout: loadTimeout });
    } catch (e) {
      const text = String((e as Error).message ?? e).split('\n')[0]!;
      if (!/ERR_ABORTED/.test(text)) error = (/net::[A-Z_]+/.exec(text)?.[0]) ?? text.slice(0, 120);
    }
    ownNavigation = null;
    let redirected: string | null = null;
    if (response) {
      let first = response.request();
      while (first.redirectedFrom()) first = first.redirectedFrom()!;
      if (first !== response.request()) {
        const firstResponse = await first.response().catch(() => null);
        redirected = `${firstResponse?.status() ?? '?'} ${pagePath(response.url()) ?? ''}`;
      }
    }
    const path = pagePath(page.url());
    notes.arrived({ status: response?.status() ?? null, error, redirected, path });
    let ready = true;
    if (navigated) {
      try {
        await readyWait(navStart);
      } catch {
        ready = false;
      }
    }
    const samples: TextSample[] = [];
    const done = ready
      ? await settle(before, Date.now(), navStart, samples)
      : { settled: false, ms: Date.now() - navStart, unsettled: `${NOT_READY_PREFIX}${loadTimeout / 1000} s after the ${what === 'reload' ? 'reload' : `${what} step`}`, after: await snapshot() };
    const observation: Observation = { before, samples, after: done.after, unsettled: done.unsettled, windowEndedAt: Date.now(), startedAt: navStart };
    result.steps.push({ index, label: what === 'reload' ? RELOAD_LABEL : `${GO_LABEL_PREFIX}${what}`, observation, settled: done.settled, settleMs: done.ms, path });
    return { path, ready };
  };

  const fail = async (index: number, label: string, message: string) => {
    const aborted = options.guard?.abortedIn(browserContextId) ?? [];
    result.failure = { step: index, label, message: aborted.length > 0 ? `${message} (${abortedHint(aborted)})` : message };
    if (options.onFailure) {
      await options.onFailure(page, result.envFilled.map(locate)).catch(() => {});
    }
  };

  const whyActionFailed = async (locator: Locator, verb: string): Promise<string> => {
    const count = await locator.count().catch(() => 0);
    if (count === 0) return `not found after ${actionTimeout / 1000} s`;
    if (count > 1) return `matches ${count} elements`;
    return `not ${verb} after ${actionTimeout / 1000} s`;
  };

  const fieldValuesOf = async (indices: number[]) => {
    const out: { field: string; value: string | null; password: boolean }[] = [];
    for (const [i, s] of options.flow.steps.entries()) {
      if (!indices.includes(i + 1)) continue;
      const k = stepKind(s);
      if (k !== 'fill' && k !== 'select' && k !== 'check') continue;
      const spec = (s as Record<string, LocatorSpec>)[k]!;
      const read = await locate(spec).evaluate((el) => {
        if (el instanceof HTMLInputElement && el.type === 'password') return { value: null, password: true };
        if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return { value: String(el.checked), password: false };
        if ((el as HTMLElement).isContentEditable) return { value: (el as HTMLElement).innerText, password: false };
        return { value: 'value' in el ? String((el as HTMLInputElement).value) : null, password: false };
      }, undefined, { timeout: 1000 }).catch(() => ({ value: null, password: false }));
      out.push({ field: describeLocator(spec), ...read });
    }
    return out;
  };

  const fieldFacts = new Map<number, FieldFacts>();

  const queue: { index: number; step: Step; recovery: boolean }[] = options.flow.steps.map((step, i) => ({ index: i + 1, step, recovery: false }));
  let recovering = false;
  try {
    while (queue.length > 0) {
      const { index, step, recovery: isRecovery } = queue.shift()!;
      if (options.deadline !== undefined && Date.now() > options.deadline) {
        result.voided = 'stopped at the hard stop';
        break;
      }
      const kind = stepKind(step);
      const label = describeStep(step);
      if (result.excluded !== null) break;
      const startedAt = Date.now();
      if (kind !== 'expect') {
        owner = index;
        stepStartedAt = startedAt;
      }
      navigated = false;
      navigationMethod = null;
      if (!recovering) await hooks.beforeStep?.({ index, step, kind, label, startedAt });
      const pathBefore = pagePath(page.url());
      const before = await snapshot();
      let control: ControlFacts | undefined;
      // The window starts at the step's start, or where the kind's own action says.
      let windowFrom = startedAt;
      let acted: Acted | undefined;
      try {
        if (kind === 'goto') {
          const target = resolve((step as { goto: string }).goto);
          try {
            // Resolved against the base URL here, since a repro's persistent context has none.
            await page.goto(new URL(target, options.baseURL).href, { waitUntil: 'commit', timeout: loadTimeout });
          } catch {
            throw new StepError(result.refused ? `nothing answers at ${result.refused}` : 'the page did not load');
          }
        } else if (kind === 'expect') {
          const locator = locate((step as { expect: LocatorSpec }).expect);
          try {
            await locator.waitFor({ state: 'visible', timeout: actionTimeout });
          } catch {
            const count = await locator.count().catch(() => 0);
            throw new StepError(count > 1 ? `matches ${count} elements` : `not visible after ${actionTimeout / 1000} s`);
          }
        } else {
          const spec = (step as Record<string, LocatorSpec>)[kind]!;
          const locator = locate(spec);
          if (kind === 'click' || kind === 'press') control = await controlFacts(locator, actionTimeout);
          try {
            if (!recovering && hooks.act && (acted = await hooks.act({ index, step, kind, label, startedAt }, locator, before)) !== undefined) {
              if (acted.windowFrom !== undefined) windowFrom = acted.windowFrom;
            } else if (kind === 'click') await locator.click({ timeout: actionTimeout });
            else if (kind === 'check') await locator.check({ timeout: actionTimeout });
            else if (kind === 'press') await locator.press((step as { key: string }).key, { timeout: actionTimeout });
            else {
              const raw = (step as { value: string }).value;
              if (raw.includes('${env.')) result.envFilled.push(spec);
              const value = resolve(raw);
              if (kind === 'fill') await locator.fill(value, { timeout: actionTimeout });
              else await locator.selectOption({ label: value }, { timeout: actionTimeout });
            }
          } catch (error) {
            if (error instanceof NotApplied) throw error;
            throw new StepError(await whyActionFailed(locator, kind === 'fill' || kind === 'select' ? 'editable' : 'clickable'));
          }
          if (kind === 'fill' || kind === 'select' || kind === 'check') {
            const facts = await locator.evaluate(new Function(`return (${FIELD_FACTS})`)() as (el: Element) => FieldFacts, undefined, { timeout: 2000 }).catch(() => undefined);
            if (facts) fieldFacts.set(index, facts);
          }
        }
        if (navigated) {
          try {
            await readyWait(startedAt);
          } catch {
            throw new StepError(`${NOT_READY_PREFIX}${loadTimeout / 1000} s after the page loaded`);
          }
        }
        if (result.excluded !== null) break;
        const samples: TextSample[] = [];
        const settled = kind === 'expect'
          ? { settled: true, ms: 0, unsettled: null, after: await snapshot() }
          : await settle(before, navigated ? Date.now() : windowFrom, acted?.ceilingFrom ?? windowFrom, samples);
        if (result.untrustedStop !== null) throw new StepError(result.untrustedStop);
        const pathAfter = pagePath(page.url());
        const wantShot = options.shots === 'all' || (Array.isArray(options.shots) && options.shots.includes(index)) || hooks.wantsShot?.(settled.after);
        if (wantShot && kind !== 'expect' && !isRecovery && !result.shots.has(index)) {
          const png = await page.screenshot({ mask: result.envFilled.map(locate), timeout: 5000 }).catch(() => null);
          if (png) result.shots.set(index, png);
        }
        const filled = acted?.value !== undefined ? acted.value : kind === 'fill' || kind === 'select' ? resolve((step as { value: string }).value) : kind === 'check' ? 'true' : undefined;
        const observation: Observation = { before, samples, after: settled.after, unsettled: settled.unsettled, windowEndedAt: Date.now(), startedAt };
        result.steps.push({
          index, label, observation, settled: settled.settled, settleMs: settled.ms, path: pathAfter,
          ...(control ? { control } : {}),
          ...(filled !== undefined ? { value: filled } : {}),
          ...hooks.stepFacts?.(settled.after),
          ...(fieldFacts.has(index) && !isRecovery ? { field: fieldFacts.get(index) } : {}),
        });
        if (options.onPoint) await options.onPoint(page, locate, { step: index, end: false, recovery: isRecovery, requests: result.requests.length, records: result.steps.length }).catch(() => {});
        if (kind !== 'expect' && pathAfter !== null && (pathAfter !== pathBefore || navigated)) {
          result.pages.push({
            path: pathAfter,
            step: index,
            entry: navigated ? 'full-load' : 'in-app',
            requests: [],
            previous: pathBefore,
            method: navigated ? navigationMethod : null,
          });
        }
        const end = !recovering && hooks.afterWindow ? await hooks.afterWindow({ index, step, kind, label, startedAt }, { before, samples, after: settled.after, path: pathAfter }) : null;
        if (end?.then === 'end') {
          if (end.unrecovered !== undefined) result.recovery = { action: null, passed: false, detail: end.unrecovered };
          result.endedAfterWindow = true;
          break;
        }
        if (end?.then === 'recover') {
          recovering = true;
          queue.unshift(...end.steps.map((x) => ({ ...x, recovery: true })));
          result.recovery = { action: end.action, passed: true, detail: null };
        }
        if (end?.then === 'continue' && end.skip !== undefined && queue[0]?.index === end.skip) queue.shift();
      } catch (error) {
        if (error instanceof NotApplied) {
          hooks.notApplied?.(error.reason);
          result.endedAfterWindow = true;
          break;
        }
        if (!(error instanceof StepError)) throw error;
        // A failure while recovering fails retry-recovers, never the flow run itself.
        if (recovering && result.recovery) {
          result.recovery.passed = false;
          result.recovery.detail = `step ${index} (${label}): ${error.message}`;
          break;
        }
        await fail(index, label, `${label}: ${result.untrustedStop ?? error.message}`);
        if (hooks.stopsFlow?.(index)) result.stoppedAt = index;
        break;
      }
    }
    await Promise.all(pendingResponses);
    // A guard hit after the last step settled still fails the run, at the step that caused it.
    if (result.untrustedStop !== null && result.failure === null) {
      const step = options.flow.steps[owner - 1];
      await fail(owner, step ? describeStep(step) : '', `${step ? describeStep(step) : ''}: ${result.untrustedStop}`);
    }
    for (const request of inflight) {
      const record = byRequest.get(request);
      if (record) record.streaming = true;
    }
    // Entry requests: GET and HEAD fetch or XHR to own origins that the entry step sent.
    for (const entry of result.pages) {
      entry.requests = [...new Set(result.requests
        .filter((r) => r.step === entry.step && (r.method === 'GET' || r.method === 'HEAD') && (r.resourceType === 'fetch' || r.resourceType === 'xhr') && ownHost(r.url) && !isFrameworkInternal(r.url))
        .map((r) => r.key.replace(/ #\d+$/, '')))];
    }
    result.durationMs = Date.now() - runStartedAt;
    result.aborted = options.guard?.abortedIn(browserContextId) ?? [];
    result.passed = result.failure === null && result.excluded === null && result.refused === null;
    if (options.keepStorageState && result.passed) result.storageState = await context.storageState();
    if (options.onPoint && result.failure === null && result.voided === null && result.excluded === null && !result.endedAfterWindow && result.stoppedAt === null && result.recovery?.passed !== false) {
      await options.onPoint(page, locate, { step: owner, end: true, recovery: false, requests: result.requests.length, records: result.steps.length }).catch(() => {});
    }
    if (options.onFinish && result.failure === null) await options.onFinish(page).catch(() => {});
  } finally {
    await hooks.close?.();
    if (!options.context) await context.close().catch(() => {});
  }
  return result;
}
