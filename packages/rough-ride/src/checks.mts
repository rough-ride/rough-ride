// The generic checks ticket 18 brings (spec part 5 sections 22.1 to 22.4):
// no-uncaught-error, settles, visible-error-message and no-broken-text.

import { NOT_READY_PREFIX, type FlowRunResult, type PageEvent, type StepRecord } from './flowrun.mjs';
import { escapeName } from './output.mjs';
import { redactSecrets } from './secrets.mjs';

export type CheckId = 'no-uncaught-error' | 'settles' | 'visible-error-message' | 'no-broken-text' | 'values-survive' | 'no-overflow-375' | 'one-write' | 'retry-recovers' | 'no-5xx-on-bad-input' | 'latest-response-wins';

// Section 22.1's table, lowest rank first.
export const CHECK_RANK: Record<string, number> = {
  'one-write': 1,
  'no-5xx-on-bad-input': 2,
  'visible-error-message': 3,
  'settles': 4,
  'latest-response-wins': 5,
  'values-survive': 6,
  'retry-recovers': 7,
  'no-broken-text': 8,
  'no-uncaught-error': 10,
  'no-overflow-375': 11,
};

export const CHECK_SEVERITY: Record<string, 'high' | 'medium' | 'low'> = {
  'one-write': 'high',
  'no-5xx-on-bad-input': 'high',
  'visible-error-message': 'high',
  'settles': 'high',
  'latest-response-wins': 'high',
  'values-survive': 'medium',
  'retry-recovers': 'medium',
  'no-broken-text': 'medium',
  'no-uncaught-error': 'medium',
  'no-overflow-375': 'low',
};

// App-specific checks rank 9, after no-broken-text and before no-uncaught-error, at medium (resolution 22).
export const APP_RANK = 9;
export const checkRank = (id: string): number => CHECK_RANK[id] ?? (id.startsWith('app-') ? APP_RANK : 99);
export const checkSeverity = (id: string): 'high' | 'medium' | 'low' => CHECK_SEVERITY[id] ?? (id.startsWith('app-') ? 'medium' : 'low');

export interface CheckResult {
  id: CheckId | `app-${string}`;
  result: 'pass' | 'fail' | 'not-evaluated' | 'skipped-baseline' | 'accepted';
  // At most 200 characters, escaped and redacted.
  evidence: string;
  // For no-broken-text: the fixed word the summary may print.
  token?: string;
  // An app-specific check: its spec part and the form a regression test keeps (45.9).
  app?: { spec: string; inline: Record<string, unknown> };
}

// `app-x (app-specific, spec notes)` for an app-specific check, the id otherwise.
export function checkLabel(id: string, checks: CheckResult[]): string {
  const app = checks.find((c) => c.id === id)?.app;
  return app ? `${id} (app-specific, spec ${app.spec})` : id;
}

export function evidence(text: string): string {
  return escapeName(redactSecrets(text), 200);
}

const BROKEN: { pattern: RegExp; token: string }[] = [
  { pattern: /\bundefined\b/, token: 'undefined' },
  { pattern: /\bNaN\b/, token: 'NaN' },
  { pattern: /\[object Object\]/, token: '[object Object]' },
  { pattern: /Invalid Date/, token: 'Invalid Date' },
  { pattern: /\bat [\w$.<>]+ \([^()]*:\d+:\d+\)/, token: 'a stack frame' },
  { pattern: /�/, token: '\\u{FFFD}' },
];

function linesOf(step: StepRecord): string[] {
  const o = step.observation;
  if (!o) return [];
  return [...o.before.lines, ...o.samples.flatMap((s) => s.lines), ...o.after.lines];
}

export function fillValues(run: FlowRunResult): string[] {
  return run.steps.map((s) => s.value).filter((v): v is string => v !== undefined && v.length > 0);
}

export function brokenTextIn(lines: string[], fills: string[], known: Set<string>): { line: string; token: string } | null {
  for (const line of lines) {
    if (known.has(line) || fills.some((v) => line.includes(v))) continue;
    const hit = BROKEN.find((b) => b.pattern.test(line));
    if (hit) return { line, token: hit.token };
  }
  return null;
}

// A ready wait that timed out already states its time (32.2), so it gets no second one.
function settlesEvidence(step: StepRecord): string {
  const why = step.observation?.unsettled ?? 'did not settle';
  return why.startsWith(NOT_READY_PREFIX) ? `${step.label}: ${why}` : `${step.label}: ${why} after ${Math.round(step.settleMs / 100) / 10} s`;
}

// no-uncaught-error, settles and no-broken-text (22.3) are judged only here: for
// every attack kind against its baseline run, and for a baseline run against nothing.
type Compared = Pick<FlowRunResult, 'pageEvents' | 'steps'>;
const NOTHING: Compared = { pageEvents: [], steps: [] };

// What an attack kind changes about those three checks.
interface Adjustments {
  // Page events the kind expects, which never count for no-uncaught-error (22.4 check 1).
  ignoreEvent?: (event: PageEvent) => boolean;
  // A failure no-uncaught-error reports ahead of any page event.
  leadingError?: string | null;
  // Steps settles judges even where the baseline run's step at the same index did not settle.
  ownStep?: (step: StepRecord) => boolean;
  // A Pending hang (22.3): settles is not evaluated, and the verdict is pending unless a check failed.
  pending?: boolean;
}

// Anything the baseline run didn't have at the same step.
function uncaughtError(run: FlowRunResult, baseline: Compared, adjust: Adjustments): PageEvent | undefined {
  const known = new Set(baseline.pageEvents.map((e) => `${e.step}|${e.text}`));
  return run.pageEvents.find((e) => !known.has(`${e.step}|${e.text}`) && !adjust.ignoreEvent?.(e));
}

// An action step that did not settle where the baseline run's same step did.
function unsettledStep(run: FlowRunResult, baseline: Compared, adjust: Adjustments): StepRecord | undefined {
  return run.steps.find((s) => s.settled === false && (adjust.ownStep?.(s) || baseline.steps.find((b) => b.index === s.index)?.settled !== false));
}

// A broken line no baseline step showed.
function brokenText(run: FlowRunResult, baseline: Compared): { step: StepRecord; token: string } | null {
  const baselineLines = new Set(baseline.steps.flatMap(linesOf));
  const fills = fillValues(run);
  for (const step of run.steps) {
    const broken = brokenTextIn(linesOf(step), fills, baselineLines);
    if (broken) return { step, token: broken.token };
  }
  return null;
}

// Checks that already fail in a baseline run: reported once as `fails with no
// attack` and skipped on that flow's attacks.
export function baselineFailures(run: FlowRunResult): { id: CheckId; step: number; page: string | null }[] {
  const out: { id: CheckId; step: number; page: string | null }[] = [];
  const error = uncaughtError(run, NOTHING, {});
  if (error) out.push({ id: 'no-uncaught-error', step: error.step, page: run.steps.find((s) => s.index === error.step)?.path ?? null });
  const unsettled = unsettledStep(run, NOTHING, {});
  if (unsettled) out.push({ id: 'settles', step: unsettled.index, page: unsettled.path });
  const broken = brokenText(run, NOTHING);
  if (broken) out.push({ id: 'no-broken-text', step: broken.step.index, page: broken.step.path });
  return out;
}

export interface Judged {
  verdict: 'passed' | 'failed' | 'void' | 'fault-never-fired' | 'not-applied' | 'pending' | 'inconclusive';
  checks: CheckResult[];
}

// One attack's check results. A check that fails in the baseline run reads
// skipped-baseline instead; one that does not apply reads not-evaluated.
export type CheckList = ReturnType<typeof checkList>;

function checkList(skipped: Set<string>) {
  const checks: CheckResult[] = [];
  const push = (id: CheckId, fail: string | null, token?: string) => {
    if (skipped.has(id)) checks.push({ id, result: 'skipped-baseline', evidence: 'fails with no attack' });
    else checks.push({ id, result: fail === null ? 'pass' : 'fail', evidence: evidence(fail ?? 'ok'), ...(token ? { token } : {}) });
  };
  const notEvaluated = (id: CheckId, why: string) => checks.push({ id, result: 'not-evaluated', evidence: evidence(why) });
  return { checks, push, notEvaluated };
}

// How one attack kind is judged: its gate, its adjustments to the generic checks and its own checks.
export interface KindRules {
  // The attack kind, for a programmer error that names it.
  name: string;
  // The verdict when the kind's attack did not happen as planned. A void flow run comes first.
  gate: Judged['verdict'] | null;
  adjust?: Adjustments;
  // The order the kind lists its checks in, the three generic ones included.
  order: CheckId[];
  // The kind's own checks.
  own?: (list: CheckList) => void;
}

// The checks in the kind's declared order. A check the order leaves out is a
// programmer error: its index of -1 would silently sort it first.
export function inKindOrder(kind: string, order: CheckId[], checks: CheckResult[]): CheckResult[] {
  const missing = checks.find((c) => !order.includes(c.id as CheckId));
  if (missing) throw new Error(`the ${kind} kind's check order has no ${missing.id}`);
  return checks.sort((a, b) => order.indexOf(a.id as CheckId) - order.indexOf(b.id as CheckId));
}

export function judgeAttack(run: FlowRunResult, baseline: FlowRunResult, skipped: Set<string>, kind: KindRules): Judged {
  if (run.voided) return { verdict: 'void', checks: [] };
  if (kind.gate !== null) return { verdict: kind.gate, checks: [] };
  const adjust = kind.adjust ?? {};
  const list = checkList(skipped);
  const error = uncaughtError(run, baseline, adjust);
  list.push('no-uncaught-error', adjust.leadingError ?? (error ? `${error.kind}: ${error.text}` : null));
  if (adjust.pending) list.notEvaluated('settles', 'pending hang');
  else {
    const unsettled = unsettledStep(run, baseline, adjust);
    list.push('settles', unsettled ? settlesEvidence(unsettled) : null);
  }
  const broken = brokenText(run, baseline);
  list.push('no-broken-text', broken ? `"${broken.token}" in a new line` : null, broken?.token);
  kind.own?.(list);
  const checks = inKindOrder(kind.name, kind.order, list.checks);
  return { verdict: checks.some((c) => c.result === 'fail') ? 'failed' : adjust.pending ? 'pending' : 'passed', checks };
}

export function pathBefore(run: FlowRunResult, step: number): string | null {
  for (let i = step - 1; i >= 1; i--) {
    const p = run.steps.find((s) => s.index === i)?.path;
    if (p) return p;
  }
  return null;
}

export function leadCheck(checks: CheckResult[]): CheckResult | null {
  return checks.filter((c) => c.result === 'fail').sort((a, b) => checkRank(a.id) - checkRank(b.id))[0] ?? null;
}
