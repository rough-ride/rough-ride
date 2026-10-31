// The generic checks ticket 18 brings (spec part 5 sections 22.1 to 22.4):
// no-uncaught-error, settles, visible-error-message and no-broken-text.

import type { ControlFacts, FlowRunResult, RequestRecord, StepRecord } from './flowrun.mjs';
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

function fillValues(run: FlowRunResult): string[] {
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
  return why.startsWith('not ready ') ? `${step.label}: ${why}` : `${step.label}: ${why} after ${Math.round(step.settleMs / 100) / 10} s`;
}

// Checks that already fail in a baseline run: reported once as `fails with no
// attack` and skipped on that flow's attacks.
export function baselineFailures(run: FlowRunResult): { id: CheckId; step: number; page: string | null }[] {
  const out: { id: CheckId; step: number; page: string | null }[] = [];
  const firstEvent = run.pageEvents[0];
  if (firstEvent) out.push({ id: 'no-uncaught-error', step: firstEvent.step, page: run.steps.find((s) => s.index === firstEvent.step)?.path ?? null });
  const unsettled = run.steps.find((s) => s.settled === false);
  if (unsettled) out.push({ id: 'settles', step: unsettled.index, page: unsettled.path });
  const fills = fillValues(run);
  for (const step of run.steps) {
    if (brokenTextIn(linesOf(step), fills, new Set())) {
      out.push({ id: 'no-broken-text', step: step.index, page: step.path });
      break;
    }
  }
  return out;
}

export interface Judged {
  verdict: 'passed' | 'failed' | 'void' | 'fault-never-fired' | 'not-applied' | 'pending' | 'inconclusive';
  checks: CheckResult[];
}

// A told failure: the page got an error it can report. malformed-json, empty-200
// and a completed delay-3s delivered a 2xx; a one-shot fault a retry absorbed was
// never seen; a hang or delay is told once the page gave up on it.
export function toldFault(fault: string, state: NonNullable<FlowRunResult['fault']>): boolean {
  if (state.absorbed) return false;
  if (fault === 'malformed-json' || fault === 'empty-200') return false;
  if (fault === 'hang' || fault === 'delay-3s') return state.givenUp;
  return true;
}

// Judges one fault attack's flow run against the flow's baseline run.
export function judgeFault(attackRun: FlowRunResult, baseline: FlowRunResult, attackedStep: number, skipped: Set<string>, fault = '500'): Judged {
  if (attackRun.voided) return { verdict: 'void', checks: [] };
  if (!attackRun.fault?.fired) return { verdict: 'fault-never-fired', checks: [] };
  if (attackRun.fault.notApplied !== null) return { verdict: 'not-applied', checks: [] };
  const pending = attackRun.fault.pending;
  const told = toldFault(fault, attackRun.fault);
  const checks: CheckResult[] = [];
  const push = (id: CheckId, fail: string | null, token?: string) => {
    if (skipped.has(id)) checks.push({ id, result: 'skipped-baseline', evidence: 'fails with no attack' });
    else checks.push({ id, result: fail === null ? 'pass' : 'fail', evidence: evidence(fail ?? 'ok'), ...(token ? { token } : {}) });
  };
  const notEvaluated = (id: CheckId, why: string) => checks.push({ id, result: 'not-evaluated', evidence: evidence(why) });

  // no-uncaught-error: anything the baseline run didn't have at the same step.
  const known = new Set(baseline.pageEvents.map((e) => `${e.step}|${e.text}`));
  const fresh = attackRun.pageEvents.find((e) => !known.has(`${e.step}|${e.text}`));
  push('no-uncaught-error', fresh ? `${fresh.kind}: ${fresh.text}` : null);

  // settles: every action step of the attack settles within S of its last fault event.
  const unsettled = attackRun.steps.find((s) => s.settled === false && baseline.steps.find((b) => b.index === s.index)?.settled !== false);
  if (pending) notEvaluated('settles', 'pending hang');
  else push('settles', unsettled ? `${unsettled.label}: ${unsettled.observation?.unsettled ?? 'did not settle'} after ${Math.round(unsettled.settleMs / 100) / 10} s` : null);

  // visible-error-message: a told failure (500 or reset, sticky so never absorbed)
  // must show something new from the failed response until the window ends.
  const step = attackRun.steps.find((s) => s.index === attackedStep);
  const firedAt = attackRun.fault.firedAt ?? 0;
  const o = step?.observation;
  let message: string | null = 'no new visible text after the failed request';
  if (o) {
    const before = new Set([...o.before.lines, ...o.before.live]);
    const typed = fillValues(attackRun);
    const labels = new Set([...o.before.labels, ...o.after.labels]);
    const after = o.samples.filter((x) => x.at >= firedAt);
    const newLine = after.flatMap((x) => [...x.live, ...x.lines]).find((l) => !before.has(l) && !labels.has(l) && !typed.some((v) => l === v));
    const dialog = attackRun.dialogs.length > 0;
    // Navigation to another page counts, as after a 401 that moves to sign-in.
    const previous = pathBefore(attackRun, attackedStep);
    const moved = previous !== null && step.path !== null && step.path !== previous;
    if (newLine || dialog || moved) message = null;
  }
  if (pending) notEvaluated('visible-error-message', 'pending hang');
  else if (attackRun.fault.absorbed) notEvaluated('visible-error-message', 'a client retry absorbed the one-shot fault');
  else if (!told) notEvaluated('visible-error-message', 'the fault delivered a 2xx');
  else push('visible-error-message', message);
  // values-survive (22.4 check 6): after a told failure on a click submit step.
  if (pending) notEvaluated('values-survive', 'pending hang');
  else if (!told || attackRun.values === null) notEvaluated('values-survive', told ? 'not a click submit step' : 'the fault was not told');
  else {
    const lost = attackRun.values.find((v) => !v.password && v.after !== null && v.before !== null && v.before.trim() !== v.after.trim());
    push('values-survive', lost ? `${lost.field} held "${lost.before}", then "${lost.after}" after the failed request` : null);
  }

  // no-broken-text, against every line any baseline step showed.
  const baselineLines = new Set(baseline.steps.flatMap(linesOf));
  const fills = fillValues(attackRun);
  let broken: { line: string; token: string } | null = null;
  for (const s of attackRun.steps) {
    broken = brokenTextIn(linesOf(s), fills, baselineLines);
    if (broken) break;
  }
  push('no-broken-text', broken ? `"${broken.token}" in a new line` : null, broken?.token);

  // retry-recovers (22.4 check 8): after a told, unabsorbed 500, 400, 429 or
  // reset, or a hang or delay-3s the page gave up on.
  const recoverable = told && !attackRun.fault.absorbed && (['500', '400', '429', 'reset'].includes(fault) || ((fault === 'hang' || fault === 'delay-3s') && attackRun.fault.givenUp));
  if (pending) notEvaluated('retry-recovers', 'pending hang');
  else if (!recoverable || attackRun.recovery === null) notEvaluated('retry-recovers', 'no recovery after this fault');
  else push('retry-recovers', attackRun.recovery.passed ? null : (attackRun.recovery.detail ?? 'the flow did not reach its goal'));

  return { verdict: checks.some((c) => c.result === 'fail') ? 'failed' : pending ? 'pending' : 'passed', checks };
}

// The viewport attack (22.3, check 9): the flow run at 375 x 800, judged by
// no-uncaught-error, settles, no-broken-text and no-overflow-375. The judged
// step is the first step after which overflow was measured.
export function judgeViewport(run: FlowRunResult, baseline: FlowRunResult, skipped: Set<string>): Judged & { step: number | null } {
  const overflowing = run.steps.find((s) => (s.overflowPx ?? 0) > 1) ?? null;
  if (run.voided) return { verdict: 'void', checks: [], step: overflowing?.index ?? null };
  const checks: CheckResult[] = [];
  const push = (id: CheckId, fail: string | null, token?: string) => {
    if (skipped.has(id)) checks.push({ id, result: 'skipped-baseline', evidence: 'fails with no attack' });
    else checks.push({ id, result: fail === null ? 'pass' : 'fail', evidence: evidence(fail ?? 'ok'), ...(token ? { token } : {}) });
  };
  const known = new Set(baseline.pageEvents.map((e) => `${e.step}|${e.text}`));
  const fresh = run.pageEvents.find((e) => !known.has(`${e.step}|${e.text}`));
  push('no-uncaught-error', fresh ? `${fresh.kind}: ${fresh.text}` : null);
  const unsettled = run.steps.find((s) => s.settled === false && baseline.steps.find((b) => b.index === s.index)?.settled !== false);
  push('settles', unsettled ? `${unsettled.label}: ${unsettled.observation?.unsettled ?? 'did not settle'} after ${Math.round(unsettled.settleMs / 100) / 10} s` : null);
  const baselineLines = new Set(baseline.steps.flatMap(linesOf));
  const fills = fillValues(run);
  let broken: { line: string; token: string } | null = null;
  for (const s of run.steps) {
    broken = brokenTextIn(linesOf(s), fills, baselineLines);
    if (broken) break;
  }
  push('no-broken-text', broken ? `"${broken.token}" in a new line` : null, broken?.token);
  push('no-overflow-375', overflowing ? `${overflowing.path ?? 'the page'} is ${overflowing.overflowPx} px wider than the 375 px viewport after ${overflowing.label}` : null);
  return { verdict: checks.some((c) => c.result === 'fail') ? 'failed' : 'passed', checks, step: overflowing?.index ?? null };
}

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const TOGGLE_HINT = '(if this control is a toggle, give it aria-pressed)';

// Same keys at every level and the same values everywhere except boolean leaves.
export function sameShapeExceptBooleans(a: unknown, b: unknown): boolean {
  if (typeof a === 'boolean' && typeof b === 'boolean') return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameShapeExceptBooleans(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameShapeExceptBooleans((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

function hasAriaState(control: ControlFacts | undefined): boolean {
  return !!control && (control.ariaPressed !== null || control.ariaChecked !== null || control.ariaExpanded !== null);
}

// Section 33.1. Own-origin fetch or XHR writes at the step, answered 2xx, by key without #n.
export function oneWrite(run: FlowRunResult, baseline: FlowRunResult, step: number, ownHost: (url: string) => boolean): string | null {
  const writes = (r: FlowRunResult) => r.requests.filter((q) =>
    q.step === step && WRITES.has(q.method) && (q.resourceType === 'fetch' || q.resourceType === 'xhr') && ownHost(q.url) &&
    q.status !== null && q.status >= 200 && q.status < 300);
  const keyOf = (q: RequestRecord) => q.key.replace(/ #\d+$/, '');
  const base = new Map<string, RequestRecord[]>();
  for (const q of writes(baseline)) base.set(keyOf(q), [...(base.get(keyOf(q)) ?? []), q]);
  const control = baseline.steps.find((x) => x.index === step)?.control;
  for (const [key, baseAnswers] of base) {
    const answers = writes(run).filter((q) => keyOf(q) === key);
    // A 2xx whose body equals an earlier 2xx body for the key is the same write.
    const seen = new Set<string>();
    let count = 0;
    for (const q of answers) {
      const identity = q.body !== undefined ? `json:${JSON.stringify(q.body)}` : `sha:${q.bodySha256 ?? q.url}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      count++;
    }
    if (count <= baseAnswers.length) continue;
    // A toggle that flipped and flipped back: answers differ only in boolean leaves.
    const reference = baseAnswers[0]!.body;
    if (reference !== undefined && answers.every((q) => q.body !== undefined && sameShapeExceptBooleans(q.body, reference))) continue;
    return `one-write: ${count} successful ${key} (the baseline run sent ${baseAnswers.length})${hasAriaState(control) ? '' : ` ${TOGGLE_HINT}`}`;
  }
  return null;
}

// A double-submit attack (32.8): one-write, no-uncaught-error, settles and no-broken-text.
export function judgeTiming(run: FlowRunResult, baseline: FlowRunResult, step: number, skipped: Set<string>, ownHost: (url: string) => boolean): Judged {
  if (run.voided) return { verdict: 'void', checks: [] };
  if (run.timing === null) return { verdict: 'fault-never-fired', checks: [] };
  const checks: CheckResult[] = [];
  const push = (id: CheckId, fail: string | null, token?: string) => {
    if (skipped.has(id)) checks.push({ id, result: 'skipped-baseline', evidence: 'fails with no attack' });
    else checks.push({ id, result: fail === null ? 'pass' : 'fail', evidence: evidence(fail ?? 'ok'), ...(token ? { token } : {}) });
  };
  push('one-write', oneWrite(run, baseline, step, ownHost));
  const known = new Set(baseline.pageEvents.map((e) => `${e.step}|${e.text}`));
  const fresh = run.pageEvents.find((e) => !known.has(`${e.step}|${e.text}`));
  push('no-uncaught-error', fresh ? `${fresh.kind}: ${fresh.text}` : null);
  const unsettled = run.steps.find((x) => x.settled === false && baseline.steps.find((b) => b.index === x.index)?.settled !== false);
  push('settles', unsettled ? `${unsettled.label}: ${unsettled.observation?.unsettled ?? 'did not settle'} after ${Math.round(unsettled.settleMs / 100) / 10} s` : null);
  const baselineLines = new Set(baseline.steps.flatMap(linesOf));
  const fills = fillValues(run);
  let broken: { line: string; token: string } | null = null;
  for (const x of run.steps) {
    broken = brokenTextIn(linesOf(x), fills, baselineLines);
    if (broken) break;
  }
  push('no-broken-text', broken ? `"${broken.token}" in a new line` : null, broken?.token);
  return { verdict: checks.some((c) => c.result === 'fail') ? 'failed' : 'passed', checks };
}

function pathBefore(run: FlowRunResult, step: number): string | null {
  for (let i = step - 1; i >= 1; i--) {
    const p = run.steps.find((s) => s.index === i)?.path;
    if (p) return p;
  }
  return null;
}

export function leadCheck(checks: CheckResult[]): CheckResult | null {
  return checks.filter((c) => c.result === 'fail').sort((a, b) => checkRank(a.id) - checkRank(b.id))[0] ?? null;
}

// A bad-input attack (21.10, 21.11): the four checks every bad input gets, then
// visible-error-message, values-survive and retry-recovers after a refusal.
export function judgeBadInput(run: FlowRunResult, baseline: FlowRunResult, submitStep: number, skipped: Set<string>): Judged {
  if (run.voided) return { verdict: 'void', checks: [] };
  const r = run.badInput;
  if (!r || r.notApplied !== null) return { verdict: 'not-applied', checks: [] };
  if (r.outcome === null) return { verdict: 'void', checks: [] };
  if (r.outcome === 'inconclusive') return { verdict: 'inconclusive', checks: [] };
  const checks: CheckResult[] = [];
  const push = (id: CheckId, fail: string | null, token?: string) => {
    if (skipped.has(id)) checks.push({ id, result: 'skipped-baseline', evidence: 'fails with no attack' });
    else checks.push({ id, result: fail === null ? 'pass' : 'fail', evidence: evidence(fail ?? 'ok'), ...(token ? { token } : {}) });
  };
  const notEvaluated = (id: CheckId, why: string) => checks.push({ id, result: 'not-evaluated', evidence: evidence(why) });
  const known = new Set(baseline.pageEvents.map((e) => `${e.step}|${e.text}`));
  const fresh = run.pageEvents.find((e) => !known.has(`${e.step}|${e.text}`));
  push('no-uncaught-error', fresh ? `${fresh.kind}: ${fresh.text}` : null);
  const unsettled = run.steps.find((x) => x.settled === false && baseline.steps.find((b) => b.index === x.index)?.settled !== false);
  push('settles', unsettled ? `${unsettled.label}: ${unsettled.observation?.unsettled ?? 'did not settle'} after ${Math.round(unsettled.settleMs / 100) / 10} s` : null);
  const baselineLines = new Set(baseline.steps.flatMap(linesOf));
  const fills = fillValues(run);
  let broken: { line: string; token: string } | null = null;
  for (const x of run.steps) {
    broken = brokenTextIn(linesOf(x), fills, baselineLines);
    if (broken) break;
  }
  push('no-broken-text', broken ? `"${broken.token}" in a new line` : null, broken?.token);
  const c = r.carrying;
  push('no-5xx-on-bad-input', r.outcome === 'crashed'
    ? `${c ? `${c.method} ${c.path}` : 'a request'} answered ${c?.status ?? 'no response'} after the bad input`
    : null);
  // A refusal is outcomes 3 to 6; an accepted input followed by a failing step
  // that shows a new message with the values intact counts as blocked by the app.
  const valuesLost = r.reference.find((ref, i) => {
    const now = r.after[i];
    return !ref.password && ref.value !== null && now?.value !== null && now !== undefined && ref.value.trim() !== now.value!.trim();
  });
  const refused = ['rejected', 'blocked-by-browser', 'blocked-by-app', 'silent-refusal'].includes(r.outcome);
  if (refused) {
    if (r.outcome === 'silent-refusal') push('visible-error-message', 'the submit ran, nothing was sent and no message appeared');
    else if (r.outcome === 'rejected') {
      const step = run.steps.find((x) => x.index === submitStep);
      const o = step?.observation;
      const before = new Set(r.linesBefore);
      const typed = new Set(fills);
      const shown = o ? [...o.samples.flatMap((x) => [...x.live, ...x.lines]), ...o.after.lines].some((l) => !before.has(l) && !typed.has(l) && !o.after.labels.includes(l)) : false;
      push('visible-error-message', shown || run.dialogs.length > 0 ? null : `no new visible text after ${c ? `${c.method} ${c.path}` : 'the submit'} answered ${c?.status ?? 'nothing'}`);
    } else push('visible-error-message', null);
    // Lengths only: a bad value never reaches a report (21.12).
    if (r.reference.length > 0) push('values-survive', valuesLost ? `${valuesLost.field} held ${valuesLost.value!.length} chars before the submit, then ${r.after[r.reference.indexOf(valuesLost)]?.value?.length ?? 0}` : null);
    else notEvaluated('values-survive', 'not a click or press submit');
    if (run.recovery) push('retry-recovers', run.recovery.passed ? null : (run.recovery.detail ?? 'the flow did not reach its goal'));
    else notEvaluated('retry-recovers', 'no recovery ran');
  } else {
    for (const id of ['visible-error-message', 'values-survive', 'retry-recovers'] as const) notEvaluated(id, `outcome ${r.outcome}`);
  }
  return { verdict: checks.some((x) => x.result === 'fail') ? 'failed' : 'passed', checks };
}

// out-of-order (33.2): latest-response-wins through (a), (b) or (c), plus
// no-uncaught-error (an AbortError after the page aborted the held request
// doesn't count), settles and no-broken-text.
export function judgeOutOfOrder(run: FlowRunResult, baseline: FlowRunResult, step: number, skipped: Set<string>): Judged {
  if (run.voided) return { verdict: 'void', checks: [] };
  const r = run.outOfOrder;
  if (!r || r.notApplied !== null) return { verdict: 'not-applied', checks: [] };
  const checks: CheckResult[] = [];
  const push = (id: CheckId, fail: string | null, token?: string) => {
    if (skipped.has(id)) checks.push({ id, result: 'skipped-baseline', evidence: 'fails with no attack' });
    else checks.push({ id, result: fail === null ? 'pass' : 'fail', evidence: evidence(fail ?? 'ok'), ...(token ? { token } : {}) });
  };
  let latest: string | null = null;
  const o = run.steps.find((x) => x.index === step)?.observation;
  if (r.olderOnly && r.newerOnly && o && r.releasedAt !== null) {
    const after = o.samples.filter((x) => x.at >= r.releasedAt!);
    const shownAfter = [...after.flatMap((x) => x.lines), ...o.after.lines];
    const visibleIn = (lines: string[], leaf: string) => lines.some((l) => l.includes(leaf));
    const appeared = r.olderOnly.find((leaf) => !visibleIn(r.linesBefore, leaf) && visibleIn(shownAfter, leaf));
    if (appeared) latest = `latest-response-wins: "${appeared}" from the older answer appeared after the newer one`;
    else {
      const gone = r.newerOnly.find((leaf) => visibleIn(r.linesBefore, leaf) && !visibleIn(o.after.lines, leaf));
      if (gone) latest = `latest-response-wins: "${gone}" from the newer answer disappeared when the older one arrived`;
    }
  }
  if (!latest && run.stoppedAt !== null && run.failure) {
    latest = `latest-response-wins: step ${run.stoppedAt} failed after the older answer arrived: ${run.failure.message.split('\n')[0]}`;
  }
  push('latest-response-wins', latest);
  const known = new Set(baseline.pageEvents.map((e) => `${e.step}|${e.text}`));
  const fresh = run.pageEvents.find((e) => !known.has(`${e.step}|${e.text}`) && !(r.aborted && /AbortError/.test(e.text)));
  push('no-uncaught-error', fresh ? `${fresh.kind}: ${fresh.text}` : null);
  const unsettled = run.steps.find((x) => x.settled === false && baseline.steps.find((b) => b.index === x.index)?.settled !== false);
  push('settles', unsettled ? `${unsettled.label}: ${unsettled.observation?.unsettled ?? 'did not settle'} after ${Math.round(unsettled.settleMs / 100) / 10} s` : null);
  const baselineLines = new Set(baseline.steps.flatMap(linesOf));
  const fills = fillValues(run);
  let broken: { line: string; token: string } | null = null;
  for (const x of run.steps) {
    broken = brokenTextIn(linesOf(x), fills, baselineLines);
    if (broken) break;
  }
  push('no-broken-text', broken ? `"${broken.token}" in a new line` : null, broken?.token);
  return { verdict: checks.some((x) => x.result === 'fail') ? 'failed' : 'passed', checks };
}

// refresh, back and signed-out-reload (32.8): no-uncaught-error with the
// document additions, settles and no-broken-text. Errors a baseline run's full
// load of the same page template also got don't count.
export function judgePageTiming(run: FlowRunResult, baseline: FlowRunResult, skipped: Set<string>, fullLoadErrors: string[]): Judged {
  if (run.voided) return { verdict: 'void', checks: [] };
  const r = run.pageTiming;
  if (!r || r.notApplied !== null) return { verdict: 'not-applied', checks: [] };
  if (r.events.length === 0) return { verdict: 'fault-never-fired', checks: [] };
  const checks: CheckResult[] = [];
  const push = (id: CheckId, fail: string | null, token?: string) => {
    if (skipped.has(id)) checks.push({ id, result: 'skipped-baseline', evidence: 'fails with no attack' });
    else checks.push({ id, result: fail === null ? 'pass' : 'fail', evidence: evidence(fail ?? 'ok'), ...(token ? { token } : {}) });
  };
  const known = new Set([...baseline.pageEvents.map((e) => `${e.step}|${e.text}`)]);
  const expected = new Set(fullLoadErrors);
  const fresh = run.pageEvents.find((e) => !known.has(`${e.step}|${e.text}`) && !expected.has(e.text));
  const doc = r.documentStatus !== null && r.documentStatus >= 500 && !expected.has(`document ${r.documentStatus}`) ? `the document answered ${r.documentStatus} after the runner's navigation`
    : r.navigationError && !expected.has(r.navigationError) ? `the navigation failed with ${r.navigationError}`
    : null;
  push('no-uncaught-error', doc ?? (fresh ? `${fresh.kind}: ${fresh.text}` : null));
  const unsettled = run.steps.find((x) => x.settled === false && (x.label === 'reload' || x.label.startsWith('go ') || baseline.steps.find((b) => b.index === x.index)?.settled !== false));
  push('settles', unsettled ? settlesEvidence(unsettled) : null);
  const baselineLines = new Set(baseline.steps.flatMap(linesOf));
  const fills = fillValues(run);
  let broken: { line: string; token: string } | null = null;
  for (const x of run.steps) {
    broken = brokenTextIn(linesOf(x), fills, baselineLines);
    if (broken) break;
  }
  push('no-broken-text', broken ? `"${broken.token}" in a new line` : null, broken?.token);
  return { verdict: checks.some((x) => x.result === 'fail') ? 'failed' : 'passed', checks };
}
