// One flow run (spec part 3 sections 11.4, 12.1 and 12.6, part 5 section
// 23.1): a fresh context, the steps in order, the ready wait after every full
// page load, and every step settled before the next starts.

import { randomInt } from 'node:crypto';
import type { Browser, BrowserContext, CDPSession, Locator, Page, Request, Route } from 'playwright-core';
import { DELAY_MS, fixedResponse, holdMsFor, isJsonMedia, malformedBody, MAX_BODY, sha256, type BodyKind, type FaultId } from './faults.mjs';
import { abortedHint, type AbortedWrite, type LocalhostGuard } from './guard.mjs';
import { hasCredentialHeader } from './secrets.mjs';

export const S = 10_000;
export const C = 30_000;
const QUIET_MS = 500;
const POLL_MS = 100;
const LOAD_IDLE_MS = 500;
const WORLD = 'rough-patch';

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

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
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

export interface FaultAttack {
  fault: FaultId;
  sticky: boolean;
  // `METHOD template` of the attack point, and its place among same-key requests in its step.
  template: string;
  k: number;
  step: number;
  // Body faults: the baseline response's status and media type, and the empty-200 rule.
  baseline?: { status: number | null; mediaType: string | null };
  emptyFormOf?: (live: unknown) => { kind: BodyKind; body: string } | null;
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
  // Origins the target owns besides loopback (the applied allow hosts).
  allowedHosts?: string[];
  unique?: string;
  keepStorageState?: boolean;
  // Called at the failing step, with the page still open (baseline screenshots).
  onFailure?: (page: Page, masks: Locator[]) => Promise<void>;
  // Called after the last step of a run that did not fail, with the page still open (snapshots).
  onFinish?: (page: Page) => Promise<void>;
  timeouts?: { S?: number; C?: number };
  // The localhost guard, attached to the whole browser; it also turns the HTTP cache off.
  guard?: LocalhostGuard;
  // A fault attack: a route on this run's own context.
  attack?: FaultAttack;
  // `METHOD template` for a request from the OpenAPI documents, or null to fall
  // back to the {} rules (with this run's own token and returned values).
  templateOf?: (method: string, url: string) => string | null;
  // Templates the baseline run repeated at a steady interval: left out of the settle tests.
  pollingKeys?: Set<string>;
  // Credential strings from the sign-in session (section 20.6).
  credentials?: string[];
  // The viewport attack's plain 375 x 800 viewport; 1280 x 800 otherwise.
  viewport?: { width: number; height: number };
  // A timing attack: double-submit doubles this click or press step (32.3).
  timing?: { kind: 'double-submit'; step: number };
  // Fault recovery: control labels the baseline run showed after the attacked step (23.7).
  baselineLabels?: string[];
  // Screenshots kept in memory when a step's window ends: every step, or only these.
  shots?: 'all' | number[];
  // A bad-input attack (21.9): this value replaces one fill or select step.
  badInput?: BadInputRun;
  // An out-of-order attack (32.4).
  outOfOrder?: OutOfOrderRun;
  // The hard stop (50.3): a flow run still going at this time (ms since the epoch) is void.
  deadline?: number;
  // A regression test's pinned time zone and locale (25.4); attacks never set them.
  pin?: { timezone: string; locale: string };
  // repro --keep-open (14.6, 14.8): run in this context and leave it open, keep the
  // fault armed after the window, and leave dialogs open for the MCP.
  context?: BrowserContext;
  keepArmed?: boolean;
  keepDialogs?: boolean;
  // refresh, back or signed-out-reload at a page entry (32.5 to 32.7).
  pageTiming?: { kind: 'refresh' | 'back' | 'signed-out-reload'; step: number; previous: string | null };
  // flow save baseline runs and snapshot steps (44.5): abort writes to records this
  // run did not create and main-frame navigations to other sites.
  untrusted?: boolean;
  // App-specific checks (45.7): called with the live page after each step settles,
  // before a fault clears or a recovery starts, and once after the last step of a
  // run that completed every step. `locate` resolves ${unique} as the steps do.
  onPoint?: (page: Page, locate: (spec: LocatorSpec) => Locator, point: { step: number; end: boolean; recovery: boolean; requests: number; records: number }) => Promise<void>;
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

export interface OutOfOrderRun {
  step: number;
  // The separate submit step (the next click or press), or the field's own step.
  submitStep: number;
  // `METHOD template` of the carrying GET.
  template: string;
  // The older value: for a fill, null means V followed by this run's ${unique}.
  older: string | null;
  select: boolean;
  // The baseline offset from the step's start to its carrying request.
  offsetMs: number;
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

export interface BadInputRun {
  step: number;
  value: string;
  select: boolean;
  // A multiple select's `placeholder`: no option at all.
  noOption?: boolean;
  submitStep: number;
  // Every attackable step of the form, for reference values and recovery.
  formSteps: number[];
  // `METHOD template` of the baseline run's carrying request, or null.
  carrying: string | null;
  carryingWrite: boolean;
  // `METHOD path` of 5xx answers the baseline run got at the submit step.
  baseline5xx: string[];
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
  globalThis.__roughPatch = state;
  // Events reach the runner through a CDP binding, so a form post's submit
  // survives the navigation it starts.
  const send = (event) => { try { globalThis.__roughPatchEvent(JSON.stringify(event)); } catch {} };
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
    mutations: (globalThis.__roughPatch && globalThis.__roughPatch.mutations) || 0,
  };
})()`;

interface Snapshot {
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
// A bad input that could not be applied ends the attack with Not applied.
class BadInputStop extends Error {}

// A GraphQL error: the JSON request body has a `query` string and the
// response a non-empty top-level `errors` array (21.10 outcome 3).
function graphqlErrors(q: RequestRecord): boolean {
  try {
    const sent = JSON.parse(q.postData ?? '') as { query?: unknown };
    const body = q.body as { errors?: unknown } | undefined;
    return typeof sent.query === 'string' && Array.isArray(body?.errors) && body.errors.length > 0;
  } catch {
    return false;
  }
}

// Section 23.6: a fault that delivered a 2xx lets the flow go on; a told,
// unabsorbed fault gets a recovery; anything else ends the attack.
export function afterWindow(fault: FaultId, state: FaultState): 'continue' | 'recover' | 'end' {
  if (!state.fired || state.pending || state.notApplied !== null) return 'end';
  if (fault === 'malformed-json' || fault === 'empty-200' || (fault === 'delay-3s' && !state.givenUp)) return 'continue';
  if (state.absorbed || fault === '401') return 'end';
  if (fault === 'hang' || fault === 'delay-3s') return state.givenUp ? 'recover' : 'end';
  return 'recover';
}

const FAULT_EVENT = /^(served|aborted net|given up|fast-failed|released|forwarded)/;

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
  // Under delay-3s every step and expect timeout gets 3 s more (20.10).
  const actionTimeout = stepTimeout + (options.attack?.fault === 'delay-3s' ? DELAY_MS : 0);
  const loadTimeout = options.timeouts?.C ?? C;
  const unique = options.unique ?? newUnique();
  const resolve = (text: string) => resolvePlaceholders(text, unique, options.env);
  const ownHost = (url: string) => {
    try {
      const host = new URL(url).hostname;
      return isLoopbackHostname(host) || (options.allowedHosts ?? []).includes(host);
    } catch {
      return false;
    }
  };

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
    fault: options.attack || options.outOfOrder
      ? { fired: false, events: [], firedAt: null, notApplied: null, pending: false, givenUp: false, absorbed: false, served: null, holdMs: holdMsFor(stepTimeout) }
      : null,
    endedAfterWindow: false,
    timing: null,
    stoppedAt: null,
    recovery: null,
    pageTiming: options.pageTiming ? { notApplied: null, events: [], documentStatus: null, navigationError: null, removed: 0, served401: 0 } : null,
    outOfOrder: options.outOfOrder ? { notApplied: null, aborted: false, releasedAt: null, linesBefore: [], olderOnly: null, newerOnly: null } : null,
    badInput: options.badInput ? { notApplied: null, held: null, linesBefore: [], reference: [], after: [], submitDisabled: false, submittedAt: null, outcome: null, carrying: null } : null,
    shots: new Map(),
    formEvents: { submits: [], invalids: [] },
    values: null,
    storageState: null,
    untrustedStop: null,
  };

  const context = options.context ?? await options.browser.newContext({
    baseURL: options.baseURL,
    serviceWorkers: 'block',
    viewport: options.viewport ?? { width: 1280, height: 800 },
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
  await cdp.send('Runtime.addBinding', { name: '__roughPatchEvent', executionContextName: WORLD });
  cdp.on('Runtime.bindingCalled', (event: { name: string; payload: string }) => {
    if (event.name !== '__roughPatchEvent') return;
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
  // hang: requests the fault holds; delay-3s: requests waiting out the delay.
  const held = new Map<Request, Route>();
  const delayed = new Set<Request>();
  // Requests after a spent one-shot fault: a real 2xx among them absorbed it.
  const oneShotRetries = new Set<Request>();
  let abortingHeld = false;
  let routeEventAt: number | null = null;
  const faultEvent = (event: string, detail?: string) => {
    const now = Date.now();
    const offset = routeEventAt === null ? 0 : Math.round(performance.now() - routeEventAt);
    result.fault!.events.push({ at: now, offsetMs: offset, event, key: options.attack?.template ?? options.outOfOrder?.template ?? '', ...(detail ? { detail } : {}) });
  };
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
  let ownNavigation = false;
  // The method of the request that loaded the document now showing.
  let documentMethod = 'GET';
  page.on('dialog', (dialog) => {
    // A beforeunload raised by the runner's own reload, back or forward is accepted (32.2).
    if (ownNavigation && dialog.type() === 'beforeunload') {
      result.pageTiming?.events.push({ at: Date.now(), event: 'beforeunload accepted' });
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
        // A one-shot fault's later request that got a real 2xx: the client retry absorbed it.
        if (oneShotRetries.has(request) && record.status !== null && record.status >= 200 && record.status < 300) result.fault!.absorbed = true;
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
    // The page gave up on a held or delayed request: from then on the fault is told.
    if ((held.has(request) || delayed.has(request)) && !abortingHeld) {
      held.delete(request);
      delayed.delete(request);
      result.fault!.givenUp = true;
      faultEvent('given up by the page', failure);
    }
    if (/ERR_CONNECTION_REFUSED/.test(failure) && ownHost(request.url()) && result.refused === null) {
      result.refused = new URL(request.url()).origin;
    }
    // An unfaulted request to the target that failed without the page aborting it.
    const afterBadFill = options.badInput !== undefined && (record?.step ?? 0) >= options.badInput.step;
    // The runner's own reload, back or forward failing is judged by no-uncaught-error, never a void.
    const ownNavFailure = options.pageTiming !== undefined && (record?.navigation ?? false);
    if (!faulted.has(request) && !afterBadFill && !ownNavFailure && ownHost(request.url()) && !/ERR_ABORTED|ERR_CONNECTION_REFUSED|ERR_BLOCKED_BY_CLIENT/.test(failure)) {
      result.voided ??= 'target unstable';
    }
  });

  // The fault: a route on this run's own context (sections 20.5 to 20.11).
  let armed = false;
  let cleared = false;
  let countInStep = 0;
  const attack = options.attack;
  const holdMs = result.fault?.holdMs ?? holdMsFor(stepTimeout);
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  const crossOrigin = (url: string) => {
    try {
      return new URL(url).origin !== new URL(page.url()).origin;
    } catch {
      return false;
    }
  };
  const markServed = (request: Request) => {
    faulted.add(request);
    const record = byRequest.get(request);
    if (record) record.servedByFault = true;
  };
  const serveFixed = async (route: Route, request: Request, fault: '500' | '400' | '401' | '429') => {
    const fixed = fixedResponse(fault, crossOrigin(request.url()));
    markServed(request);
    result.fault!.served ??= { status: fixed.status, headers: fixed.headers, body: fixed.body };
    faultEvent(`served ${fixed.status}`);
    await route.fulfill({ status: fixed.status, headers: fixed.headers, body: fixed.body }).catch(() => {});
  };
  // malformed-json and empty-200: forwarded exactly once, then the body is rewritten (20.8).
  const serveBody = async (route: Route, request: Request) => {
    let response;
    try {
      response = await route.fetch({ maxRedirects: 0, timeout: holdMs });
    } catch (error) {
      result.fault!.notApplied ??= `forwarding failed: ${String((error as Error).message ?? error).split('\n')[0]!.slice(0, 120)}`;
      cleared = true;
      markServed(request);
      faultEvent('aborted net::ERR_FAILED');
      await route.abort('failed').catch(() => {});
      return;
    }
    const status = response.status();
    const media = (response.headers()['content-type'] ?? '').split(';')[0]!.trim().toLowerCase() || null;
    const body = await response.body().catch(() => Buffer.alloc(0));
    const base = attack!.baseline;
    const unchanged = async (reason: string) => {
      result.fault!.notApplied ??= reason;
      cleared = true;
      faultEvent(`forwarded ${status} ${media ?? 'none'}`, 'unchanged');
      await route.fulfill({ response }).catch(() => {});
    };
    const sameClass = base?.status != null && Math.floor(base.status / 100) === Math.floor(status / 100) && base.mediaType === media;
    if (status < 200 || status >= 300 || !isJsonMedia(media) || body.length === 0 || (base && !sameClass)) {
      return unchanged(`the real response was ${status} ${media ?? 'none'}`);
    }
    let text: string;
    let kind: string;
    if (attack!.fault === 'malformed-json') {
      text = malformedBody(body.toString('utf8'));
      kind = 'malformed';
    } else {
      let live: unknown;
      try {
        live = JSON.parse(body.toString('utf8'));
      } catch {
        return unchanged(`the real response was ${status} ${media ?? 'none'}`);
      }
      const form = attack!.emptyFormOf?.(live) ?? null;
      if (!form) return unchanged('no empty form of the response');
      if (form.body === JSON.stringify(live)) return unchanged('response already empty');
      text = form.body;
      kind = form.kind;
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(response.headers())) {
      if (name === 'content-length' || name === 'content-encoding' || name === 'transfer-encoding') continue;
      headers[name] = value;
    }
    markServed(request);
    const shown = Object.fromEntries(Object.entries(headers).map(([n, v]) => [n, n === 'set-cookie' ? '<redacted>' : v]));
    result.fault!.served ??= { status, headers: shown, bodyKind: kind, length: Buffer.byteLength(text), sha256: sha256(text) };
    faultEvent(`forwarded ${status} ${media}`, kind);
    await route.fulfill({ status, headers, body: text }).catch(() => {});
  };
  const clearOwnCookies = async () => {
    const domains = new Set((await context.cookies()).map((c) => c.domain));
    for (const domain of domains) {
      if (ownHost(`http://${domain.replace(/^\./, '')}/`)) await context.clearCookies({ domain }).catch(() => {});
    }
  };
  // A Pending hang: a request still held at H ends the window (23.3).
  const startHoldDeadline = () => {
    if (holdTimer !== null) return;
    holdTimer = setTimeout(() => {
      if (held.size > 0 && !result.fault!.givenUp) {
        result.fault!.pending = true;
        faultEvent(`pending at ${holdMs / 1000} s`);
      }
    }, holdMs);
  };
  if (attack) {
    await context.route('**/*', async (route, request) => {
      const type = request.resourceType();
      const url = request.url();
      if (cleared || (type !== 'fetch' && type !== 'xhr') || !ownHost(url) || isFrameworkInternal(url)) return route.fallback();
      // After a 401 attack point, every credentialed own-origin request gets the 401 (20.6).
      if (attack.fault === '401' && result.fault!.fired) {
        const headers = await request.allHeaders().catch(() => ({}) as Record<string, string>);
        if (hasCredentialHeader(headers, options.credentials ?? [])) return serveFixed(route, request, '401');
        return route.fallback();
      }
      if (templateFor(request.method(), url) !== attack.template) return route.fallback();
      let hit = false;
      if (!result.fault!.fired) {
        if (armed && owner === attack.step) {
          countInStep++;
          hit = countInStep === attack.k;
        }
      } else if (attack.sticky) hit = true;
      if (!hit) {
        if (result.fault!.fired && !attack.sticky) oneShotRetries.add(request);
        return route.fallback();
      }
      const first = !result.fault!.fired;
      if (first) {
        routeEventAt = performance.now();
        result.fault!.fired = true;
        result.fault!.firedAt = Date.now();
      }
      switch (attack.fault) {
        case '500':
        case '400':
        case '429':
          return serveFixed(route, request, attack.fault);
        case '401':
          await clearOwnCookies();
          return serveFixed(route, request, '401');
        case 'reset':
          markServed(request);
          result.fault!.served ??= { aborted: 'net::ERR_CONNECTION_RESET' };
          faultEvent('aborted net::ERR_CONNECTION_RESET');
          return route.abort('connectionreset').catch(() => {});
        case 'hang':
          markServed(request);
          if (result.fault!.givenUp) {
            faultEvent('fast-failed', 'net::ERR_TIMED_OUT');
            return route.abort('timedout').catch(() => {});
          }
          result.fault!.served ??= { held: true };
          held.set(request, route);
          faultEvent('held');
          startHoldDeadline();
          return;
        case 'delay-3s': {
          result.fault!.served ??= { delayed: DELAY_MS };
          delayed.add(request);
          const releaseAt = performance.now() + DELAY_MS;
          while (performance.now() < releaseAt) await new Promise((r) => setTimeout(r, Math.max(1, releaseAt - performance.now())));
          if (!delayed.has(request)) return;
          delayed.delete(request);
          faultEvent(`released after ${DELAY_MS} ms`);
          return route.continue().catch(() => {});
        }
        case 'malformed-json':
        case 'empty-200':
          return serveBody(route, request);
      }
    });
  }
  // Untrusted runs (44.5). A predicate matcher, so an attack's unroute('**/*') keeps it.
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
  // After the window: held requests are aborted once the page has been judged.
  const releaseHeld = async () => {
    if (holdTimer !== null) clearTimeout(holdTimer);
    if (held.size === 0) return;
    abortingHeld = true;
    faultEvent('aborted after checks');
    for (const route of held.values()) await route.abort('aborted').catch(() => {});
    held.clear();
  };
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
      // A request still held at H ends the window: Pending, settles not evaluated.
      if (result.fault?.pending) return { settled: false, ms: at - from, unsettled: 'a held request is still pending', after: now };
      if (now.overlay && !last.overlay) result.pageEvents.push({ step: owner, at, kind: 'overlay', text: 'dev error overlay' });
      if (now.mutations !== last.mutations) quietSince = at;
      last = now;
      const stuck = now.disabled.filter((d) => !before.disabled.includes(d));
      const inflightNow = [...inflight].filter((r) => !polling.has(templateFor(r.method(), r.url())));
      const busy = now.busy || stuck.length > 0 || inflightNow.length > 0;
      // Fault events only: served responses and aborts, give-ups, releases and forwards.
      const events = (result.fault?.events ?? []).filter((e) => FAULT_EVENT.test(e.event));
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
      if (at - sFrom > stepTimeout && graceDone && held.size === 0) return { settled: false, ms: at - from, unsettled: why, after: now };
      if (at - stepStart > loadTimeout) return { settled: false, ms: at - from, unsettled: why, after: now };
    }
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

  // Field values of the fill, select and check steps before `index`, for values-survive.
  const fieldValues = (index: number) => fieldValuesOf(options.flow.steps.map((_, i) => i + 1).filter((i) => i < index));
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

  // Section 23.7: repeat the step when its control is still visible or it is a
  // fill; otherwise click a control only the failure state shows. Never a reload.
  const recoveryStepFor = async (step: Step, kind: StepKind, labelsNow: string[]): Promise<Step | null> => {
    if (kind === 'fill' || kind === 'select' || kind === 'check') return step;
    if (kind === 'click' || kind === 'press') {
      const spec = (step as Record<string, LocatorSpec>)[kind]!;
      if (await locate(spec).isVisible().catch(() => false)) return step;
    }
    const baseline = new Set(options.baselineLabels ?? []);
    for (const name of [...new Set(labelsNow)].filter((l) => !baseline.has(l) && l.length <= 80)) {
      for (const role of ['button', 'link'] as const) {
        const candidate = page.getByRole(role, { name, exact: true });
        if ((await candidate.count().catch(() => 0)) === 1 && (await candidate.isVisible().catch(() => false))) {
          return { click: { role, name } } as Step;
        }
      }
    }
    return null;
  };

  const bad = options.badInput;
  const fieldFacts = new Map<number, FieldFacts>();
  const ooo = options.outOfOrder;

  // out-of-order (32.4): hold the older value's request, enter the newer value,
  // release the older one once the newer answer rendered. Returns the release time.
  const runOutOfOrder = async (locator: Locator, step: Step): Promise<number> => {
    const r = result.outOfOrder!;
    const o = ooo!;
    const method = o.template.slice(0, o.template.indexOf(' '));
    let r1: { route: Route; request: Request } | null = null;
    let r2: Request | null = null;
    const notApplied = async (why: string): Promise<never> => {
      r.notApplied = why;
      if (r1 && !r.aborted && r.releasedAt === null) await r1.route.continue().catch(() => {});
      await context.unroute('**/*').catch(() => {});
      throw new BadInputStop();
    };
    await context.route('**/*', async (route, request) => {
      const t = request.resourceType();
      if ((t !== 'fetch' && t !== 'xhr') || request.method() !== method || templateFor(request.method(), request.url()) !== o.template) return route.fallback();
      if (r1 === null) {
        r1 = { route, request };
        routeEventAt = performance.now();
        result.fault!.fired = true;
        result.fault!.firedAt = Date.now();
        faultEvent('held');
        return;
      }
      r2 ??= request;
      return route.fallback();
    });
    context.on('requestfailed', (request) => {
      if (r1 && request === r1.request && r.releasedAt === null && !r.aborted) {
        r.aborted = true;
        faultEvent('older aborted by the page', request.failure()?.errorText ?? '');
      }
    });
    const own = resolve((step as { value: string }).value);
    // The older option goes in by value; the flow's own option by its label, as the flow wrote it.
    const enter = (value: string, own = false) => (o.select ? locator.selectOption(own ? { label: value } : { value }, { timeout: actionTimeout }) : locator.fill(value, { timeout: actionTimeout }));
    const submit = o.submitStep !== o.step ? options.flow.steps[o.submitStep - 1]! : null;
    const pressSubmit = async () => {
      if (!submit) return;
      const k = stepKind(submit);
      const target = locate((submit as Record<string, LocatorSpec>)[k]!);
      if (k === 'press') return target.press((submit as { key: string }).key, { timeout: actionTimeout });
      const until = Date.now() + stepTimeout;
      const disabled = () => target.evaluate((el) => (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true', undefined, { timeout: 1000 }).catch(() => false);
      while ((await disabled()) && Date.now() < until) await page.waitForTimeout(POLL_MS);
      if (await disabled()) await notApplied('the submit control stayed disabled while the older request was pending');
      return target.click({ timeout: actionTimeout });
    };
    const waitFor = async (check: () => boolean, ms: number) => {
      const until = Date.now() + ms;
      while (!check() && Date.now() < until) await page.waitForTimeout(25);
      return check();
    };
    try {
      await enter(o.older ?? own + unique);
    } catch {
      await notApplied('the field could not be filled while the older request was pending');
    }
    const held = await locator.evaluate((el) => ('value' in el ? String((el as HTMLInputElement).value) : ''), undefined, { timeout: 2000 }).catch(() => null);
    if (held === own) await notApplied("the field kept the flow's own value");
    await pressSubmit();
    if (!(await waitFor(() => r1 !== null, Math.min(o.offsetMs + 1000, stepTimeout)))) await notApplied('the older value sent no request');
    try {
      await enter(own, true);
    } catch {
      await notApplied('the field could not be filled while the older request was pending');
    }
    await pressSubmit();
    if (!(await waitFor(() => r2 !== null, Math.min(o.offsetMs + 1000, stepTimeout)))) await notApplied('the newer value sent no request');
    const newer = await Promise.race([
      (async () => {
        const res = await r2!.response();
        await res?.finished();
        return res;
      })(),
      page.waitForTimeout(10_000).then(() => undefined),
    ]).catch(() => undefined);
    if (newer === undefined) await notApplied('no answer to the newer value within 10 s');
    faultEvent('newer delivered');
    // 500 ms with no DOM mutation, at most S after the newer request was sent.
    const sentAt = Date.now();
    let last = (await snapshot()).mutations;
    let quietSince = Date.now();
    while (Date.now() - quietSince < QUIET_MS && Date.now() - sentAt < stepTimeout) {
      await page.waitForTimeout(POLL_MS);
      const m = (await snapshot()).mutations;
      if (m !== last) {
        last = m;
        quietSince = Date.now();
      }
    }
    r.linesBefore = (await snapshot()).lines;
    if (!r.aborted) {
      const heldFor = Math.round(performance.now() - (routeEventAt ?? performance.now()));
      await r1!.route.continue().catch(() => {});
      r.releasedAt = Date.now();
      faultEvent(`released after ${heldFor} ms`);
    }
    await context.unroute('**/*').catch(() => {});
    // Both answers, from response events; bodies stay in memory.
    const bodyOf = async (req: Request) => {
      const res = await Promise.race([req.response(), page.waitForTimeout(10_000).then(() => null)]).catch(() => null);
      if (!res) return null;
      const buf = await res.body().catch(() => null);
      return buf ? { buf, media: (res.headers()['content-type'] ?? '').split(';')[0]!.trim().toLowerCase() } : null;
    };
    const older = r.aborted ? null : await bodyOf(r1!.request);
    const newerBody = await bodyOf(r2!);
    if (older && newerBody && sha256(older.buf) === sha256(newerBody.buf)) await notApplied('both answers were the same');
    const leaves = (b: { buf: Buffer; media: string } | null): Set<string> | null => {
      if (!b || !isJsonMedia(b.media) || b.buf.length > MAX_BODY) return null;
      try {
        const out = new Set<string>();
        const walk = (v: unknown): void => {
          if (typeof v === 'string') {
            if (v.length >= 4 && /\p{L}/u.test(v)) out.add(v);
          } else if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === 'object') Object.values(v).forEach(walk);
        };
        walk(JSON.parse(b.buf.toString('utf8')));
        return out;
      } catch {
        return null;
      }
    };
    const lo = leaves(older);
    const ln = leaves(newerBody);
    if (lo && ln) {
      r.olderOnly = [...lo].filter((x) => !ln.has(x));
      r.newerOnly = [...ln].filter((x) => !lo.has(x));
    }
    return r.releasedAt ?? Date.now();
  };
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
      if (attack && index === attack.step && !isRecovery && !recovering) {
        armed = true;
        countInStep = 0;
      }
      const valuesBefore = attack && index === attack.step && kind === 'click' && !recovering ? await fieldValues(index) : null;
      const pathBefore = pagePath(page.url());
      const before = await snapshot();
      let control: ControlFacts | undefined;
      // The window starts at the step's start, or at the doubled action of a timing attack.
      let windowFrom = startedAt;
      const doubled = options.timing?.step === index && (kind === 'click' || kind === 'press');
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
          if (bad && index === bad.submitStep && !recovering && !isRecovery && result.badInput!.notApplied === null) {
            if (kind === 'click' || kind === 'press') {
              // Reference values: blur the focused element, then read every field of the form.
              await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.()).catch(() => {});
              result.badInput!.reference = await fieldValuesOf(bad.formSteps);
            }
            // A submit that stays disabled through the settle window is skipped, never waited on for 30 s.
            if (kind === 'click') {
              const disabled = () => locator.evaluate((el) => (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true', undefined, { timeout: 1000 }).catch(() => false);
              const until = Date.now() + stepTimeout;
              while ((await disabled()) && Date.now() < until) await page.waitForTimeout(POLL_MS);
              if (await disabled()) result.badInput!.submitDisabled = true;
            }
            result.badInput!.submittedAt = Date.now();
          }
          try {
            if (bad && index === bad.submitStep && result.badInput!.submitDisabled && !recovering) {
              // Skipped: the submit stayed disabled.
            } else if (doubled && kind === 'click') {
              windowFrom = Date.now();
              result.timing = { actionAt: windowFrom, action: 'double-clicked' };
              await locator.dblclick({ timeout: actionTimeout });
            } else if (doubled && kind === 'press') {
              const key = (step as { key: string }).key;
              windowFrom = Date.now();
              result.timing = { actionAt: windowFrom, action: 'pressed twice' };
              await locator.press(key, { timeout: actionTimeout });
              await page.keyboard.press(key);
            } else if (kind === 'click') await locator.click({ timeout: actionTimeout });
            else if (kind === 'check') await locator.check({ timeout: actionTimeout });
            else if (kind === 'press') await locator.press((step as { key: string }).key, { timeout: actionTimeout });
            else if (ooo && index === ooo.step && !isRecovery) {
              windowFrom = await runOutOfOrder(locator, step);
            } else if (bad && index === bad.step && !recovering && !isRecovery) {
              // The bad value goes in with fill or selectOption; a throw is Not applied (21.9).
              result.badInput!.linesBefore = before.lines;
              try {
                if (bad.select) await locator.selectOption(bad.noOption ? [] : { value: bad.value }, { timeout: actionTimeout });
                else await locator.fill(bad.value, { timeout: actionTimeout });
              } catch (error) {
                result.badInput!.notApplied = `fill failed: ${String((error as Error).message ?? error).split('\n')[0]!.slice(0, 120)}`;
                throw new BadInputStop();
              }
              const held = await locator.evaluate((el) => ((el as HTMLElement).isContentEditable ? (el as HTMLElement).innerText : 'value' in el ? String((el as HTMLInputElement).value) : ''), undefined, { timeout: 2000 }).catch(() => null);
              result.badInput!.held = held;
              const own = resolve((step as { value: string }).value);
              if (held !== null && held === own) {
                result.badInput!.notApplied = "the field kept the flow's own value";
                throw new BadInputStop();
              }
            } else {
              const raw = (step as { value: string }).value;
              if (raw.includes('${env.')) result.envFilled.push(spec);
              const value = resolve(raw);
              if (kind === 'fill') await locator.fill(value, { timeout: actionTimeout });
              else await locator.selectOption({ label: value }, { timeout: actionTimeout });
            }
          } catch (error) {
            if (error instanceof BadInputStop) throw error;
            if (ooo && index === ooo.step) {
              result.outOfOrder!.notApplied ??= 'the field could not be filled while the older request was pending';
              throw new BadInputStop();
            }
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
            throw new StepError(`not ready ${loadTimeout / 1000} s after the page loaded`);
          }
        }
        if (result.excluded !== null) break;
        const samples: TextSample[] = [];
        const settled = kind === 'expect'
          ? { settled: true, ms: 0, unsettled: null, after: await snapshot() }
          : await settle(before, navigated ? Date.now() : windowFrom, ooo && index === ooo.step ? startedAt : windowFrom, samples);
        if (result.untrustedStop !== null) throw new StepError(result.untrustedStop);
        const pathAfter = pagePath(page.url());
        const wantShot = options.shots === 'all' || (Array.isArray(options.shots) && options.shots.includes(index)) ||
          (options.viewport && (settled.after.overflow ?? 0) > 1 && ![...result.steps].some((x) => (x.overflowPx ?? 0) > 1));
        if (wantShot && kind !== 'expect' && !isRecovery && !result.shots.has(index)) {
          const png = await page.screenshot({ mask: result.envFilled.map(locate), timeout: 5000 }).catch(() => null);
          if (png) result.shots.set(index, png);
        }
        const badHere = bad && index === bad.step && !recovering && !isRecovery;
        const filled = badHere ? bad.value : kind === 'fill' || kind === 'select' ? resolve((step as { value: string }).value) : kind === 'check' ? 'true' : undefined;
        const observation: Observation = { before, samples, after: settled.after, unsettled: settled.unsettled, windowEndedAt: Date.now(), startedAt };
        result.steps.push({
          index, label, observation, settled: settled.settled, settleMs: settled.ms, path: pathAfter,
          ...(control ? { control } : {}),
          ...(filled !== undefined ? { value: filled } : {}),
          ...(options.viewport ? { overflowPx: settled.after.overflow, innerWidth: settled.after.innerWidth } : {}),
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
        // refresh, back or signed-out-reload after the entry step settles (32.5 to 32.7).
        const pt = options.pageTiming;
        if (pt && index === pt.step && !isRecovery && result.pageTiming!.events.length === 0) {
          const r = result.pageTiming!;
          const ev = (event: string, detail?: string) => r.events.push({ at: Date.now(), event, ...(detail ? { detail } : {}) });
          const entryPath = pathAfter;
          const stop = (why: string) => {
            r.notApplied = why;
            throw new BadInputStop();
          };
          // The runner's own navigation: a reload, back or forward step, settled like an action step.
          const ownNav = async (what: 'reload' | 'back' | 'forward') => {
            // Reloading a page that a form post produced would resend the write (32.2).
            if (what === 'reload' && documentMethod !== 'GET') {
              ev('form post blocked');
              stop('the reload would resend a form post');
            }
            const before2 = await snapshot();
            ownNavigation = true;
            navigated = false;
            const navStart = Date.now();
            let response: Awaited<ReturnType<Page['reload']>> = null;
            try {
              response = what === 'reload' ? await page.reload({ waitUntil: 'commit', timeout: loadTimeout })
                : what === 'back' ? await page.goBack({ waitUntil: 'commit', timeout: loadTimeout })
                : await page.goForward({ waitUntil: 'commit', timeout: loadTimeout });
            } catch (error) {
              const text = String((error as Error).message ?? error).split('\n')[0]!;
              if (!/ERR_ABORTED/.test(text)) r.navigationError = (/net::[A-Z_]+/.exec(text)?.[0]) ?? text.slice(0, 120);
            }
            ownNavigation = false;
            if (response) {
              r.documentStatus = response.status();
              let first = response.request();
              while (first.redirectedFrom()) first = first.redirectedFrom()!;
              if (first !== response.request()) {
                const firstResponse = await first.response().catch(() => null);
                ev(`redirected ${firstResponse?.status() ?? '?'} ${pagePath(response.url()) ?? ''}`);
              }
            }
            const path = pagePath(page.url());
            if (what === 'reload') ev(`reloaded ${r.documentStatus ?? r.navigationError ?? 'no response'}`);
            else ev(`went ${what} ${path ?? ''}`);
            let ready = true;
            if (navigated) {
              try {
                await readyWait(navStart);
              } catch {
                ready = false;
              }
            }
            const samples2: TextSample[] = [];
            const done = ready
              ? await settle(before2, Date.now(), navStart, samples2)
              : { settled: false, ms: Date.now() - navStart, unsettled: `not ready ${loadTimeout / 1000} s after the ${what === 'reload' ? 'reload' : `${what} step`}`, after: await snapshot() };
            const obs: Observation = { before: before2, samples: samples2, after: done.after, unsettled: done.unsettled, windowEndedAt: Date.now(), startedAt: navStart };
            result.steps.push({ index, label: what === 'reload' ? 'reload' : `go ${what}`, observation: obs, settled: done.settled, settleMs: done.ms, path });
            return { path, ready };
          };
          if (pt.kind === 'signed-out-reload') {
            // The 401 fault's session loss, exactly (20.6), then a reload; the attack ends there.
            const creds = options.credentials ?? [];
            const cookies = (await context.cookies()).filter((c) => ownHost(`http://${c.domain.replace(/^\./, '')}/`));
            r.removed = cookies.filter((c) => creds.includes(c.value)).length;
            await clearOwnCookies();
            ev(`cookies deleted ${cookies.length}`);
            await context.route('**/*', async (route, request) => {
              const t = request.resourceType();
              if ((t !== 'fetch' && t !== 'xhr') || !ownHost(request.url())) return route.fallback();
              const headers = await request.allHeaders().catch(() => ({}) as Record<string, string>);
              if (!hasCredentialHeader(headers, creds)) return route.fallback();
              r.served401++;
              ev('served 401');
              const fixed = fixedResponse('401', false);
              return route.fulfill({ status: fixed.status, headers: fixed.headers, body: fixed.body }).catch(() => {});
            });
            const { ready } = await ownNav('reload');
            if (!ready && options.ready.kind === 'expression') stop('the ready expression stayed false after signing out');
            if (r.removed === 0 && r.served401 === 0) stop('no credential was removed or refused');
            result.endedAfterWindow = true;
            break;
          }
          if (pt.kind === 'refresh') {
            await ownNav('reload');
          } else {
            const back = await ownNav('back');
            if (back.path === entryPath) stop(`the page stayed on ${entryPath}`);
            if (back.path !== pt.previous) stop(`the back step went to ${back.path}, not ${pt.previous}`);
            const forward = await ownNav('forward');
            if (forward.path !== entryPath) stop(`the forward step went to ${forward.path}, not ${entryPath}`);
          }
        }
        // out-of-order ran its own submit step; the flow goes on after it.
        if (ooo && index === ooo.step && ooo.submitStep !== ooo.step && queue[0]?.index === ooo.submitStep) queue.shift();
        // A bad input's window ends when its submit step settles (23.4): classify, then recover or go on.
        if (bad && index === bad.submitStep && !recovering && !isRecovery && result.badInput!.notApplied === null) {
          await Promise.all(pendingResponses);
          const r = result.badInput!;
          r.after = await fieldValuesOf(bad.formSteps);
          const own = (url: string) => ownHost(url);
          const pathOf = (url: string) => {
            try {
              return new URL(url).pathname;
            } catch {
              return url;
            }
          };
          const since = result.requests.filter((q) => q.step >= bad.step && own(q.url) && !isFrameworkInternal(q.url));
          const carrying = bad.carrying
            ? since.find((q) => q.step === bad.submitStep && `${q.key.replace(/ #\d+$/, '')}` === bad.carrying) ?? null
            : since.find((q) => q.step === bad.submitStep && q.navigation && q.method !== 'GET') ?? null;
          r.carrying = carrying ? { method: carrying.method, path: pathOf(carrying.url), status: carrying.status, failure: carrying.failure } : null;
          const crashed = since.some((q) =>
            (q.status !== null && q.status >= 500 && !bad.baseline5xx.includes(`${q.method} ${pathOf(q.url)}`)) ||
            (q.failure !== null && q.status === null && !/ERR_ABORTED/.test(q.failure)));
          const invalids = result.formEvents.invalids.filter((e) => e.step === bad.submitStep);
          const labels = new Set([...settled.after.labels, ...before.labels]);
          const typed = (r.after ?? []).map((v) => v.value).filter((v): v is string => !!v);
          const newMessage = [...samples.flatMap((x) => [...x.live, ...x.lines]), ...settled.after.lines]
            .some((l) => !r.linesBefore.includes(l) && !labels.has(l) && !typed.includes(l));
          const status = carrying?.status ?? null;
          let outcome: BadOutcome;
          if (crashed) outcome = 'crashed';
          else if (status !== null && [401, 403, 407, 408, 429].includes(status)) outcome = 'inconclusive';
          else if (carrying && status !== null && status >= 400 && status < 500) outcome = 'rejected';
          else if (carrying && status !== null && status < 300 && graphqlErrors(carrying)) outcome = 'rejected';
          else if (carrying && carrying.navigation && status !== null && status < 300 && (await locate((options.flow.steps[bad.step - 1] as Record<string, LocatorSpec>)[stepKind(options.flow.steps[bad.step - 1]!)]!).count().catch(() => 0)) > 0) outcome = 'rejected';
          else if (!carrying && invalids.some((e) => e.browser && e.visible)) outcome = 'blocked-by-browser';
          else if (!carrying && (r.submitDisabled || newMessage)) outcome = 'blocked-by-app';
          else if (!carrying && (kind === 'click' || kind === 'press') && bad.carryingWrite) outcome = 'silent-refusal';
          else outcome = 'accepted';
          r.outcome = outcome;
          if (outcome === 'inconclusive' || outcome === 'crashed') {
            result.endedAfterWindow = true;
            break;
          }
          if (outcome !== 'accepted') {
            // Recovery (23.7): re-fill every field of the form with this run's own values, then submit again.
            recovering = true;
            const refill = bad.formSteps.filter((i) => i !== bad.submitStep).map((i) => ({ index: i, step: options.flow.steps[i - 1]!, recovery: true }));
            queue.unshift(...refill, { index, step, recovery: true });
            result.recovery = { action: `re-fill ${refill.length} ${refill.length === 1 ? 'field' : 'fields'}, then ${label}`, passed: true, detail: null };
          }
        }
        // The attacked step's window ended: the fault clears (23.5), then the
        // flow goes on, recovers, or the attack ends (23.6).
        if (attack && index === attack.step && !recovering) {
          if (valuesBefore) {
            const after = await fieldValues(index);
            result.values = valuesBefore.map((v, i) => ({ field: v.field, before: v.value, after: after[i]?.value ?? null, password: v.password }));
          }
          const f = result.fault!;
          // repro --keep-open holds the attack: nothing clears and nothing recovers (14.8).
          if (options.keepArmed) {
            result.endedAfterWindow = true;
            break;
          }
          cleared = true;
          if (f.fired && !f.pending) faultEvent('cleared');
          await releaseHeld();
          const after = afterWindow(attack.fault, f);
          if (after === 'end') {
            result.endedAfterWindow = true;
            break;
          }
          if (after === 'recover') {
            recovering = true;
            const recoveryStep = await recoveryStepFor(step, kind, settled.after.labels);
            if (!recoveryStep) {
              result.recovery = { action: null, passed: false, detail: 'no retry path without a reload' };
              result.endedAfterWindow = true;
              break;
            }
            result.recovery = { action: describeStep(recoveryStep), passed: true, detail: null };
            queue.unshift({ index, step: recoveryStep, recovery: true });
          }
        }
      } catch (error) {
        if (error instanceof BadInputStop) {
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
        // After a timing attack's window, or a fault that delivered a 2xx:
        // `Faulted; flow stopped at step <n>`, never a finding.
        if (options.timing && index > options.timing.step) result.stoppedAt = index;
        if (attack && index > attack.step && result.fault?.fired) result.stoppedAt = index;
        if (bad && index > bad.submitStep && result.badInput?.outcome === 'accepted') result.stoppedAt = index;
        if (ooo && index > ooo.step && result.outOfOrder?.releasedAt !== null) result.stoppedAt = index;
        if (options.pageTiming && index > options.pageTiming.step && (result.pageTiming?.events.length ?? 0) > 0) result.stoppedAt = index;
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
    if (attack && !options.keepArmed) await releaseHeld();
    if (!options.context) await context.close().catch(() => {});
  }
  return result;
}
