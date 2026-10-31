// The double-submit attack (spec part 6 sections 32.3, 32.8 and 33.1): the
// attacked click or press is doubled with no wait between, and one-write
// judges the writes it sent.

import type { AttackOutcome, PlannedAttack } from './attacks.mjs';
import { judgeAttack, type Judged } from './checks.mjs';
import { runFlow, type AttackKind, type ControlFacts, type FlowRunResult, type RequestRecord } from './flowrun.mjs';
import type { KindContext, KindModule } from './kinds.mjs';

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const TOGGLE_HINT = '(if this control is a toggle, give it aria-pressed)';

function flowRunKind(step: number): AttackKind {
  return {
    start: (engine) => ({
      act: async (at, locator) => {
        if (at.index !== step || (at.kind !== 'click' && at.kind !== 'press')) return undefined;
        // The window starts at the doubled action.
        const windowFrom = Date.now();
        if (at.kind === 'click') {
          engine.result.timing = { actionAt: windowFrom, action: 'double-clicked' };
          await locator.dblclick({ timeout: engine.timeouts.action });
        } else {
          const key = (at.step as { key: string }).key;
          engine.result.timing = { actionAt: windowFrom, action: 'pressed twice' };
          await locator.press(key, { timeout: engine.timeouts.action });
          await engine.page.keyboard.press(key);
        }
        return { windowFrom };
      },
      // A later failing step: `Faulted; flow stopped at step <n>`, never a finding.
      stopsFlow: (index) => index > step,
    }),
  };
}

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

// one-write, no-uncaught-error, settles and no-broken-text (32.8).
export function judgeTiming(run: FlowRunResult, baseline: FlowRunResult, step: number, skipped: Set<string>, ownHost: (url: string) => boolean): Judged {
  return judgeAttack(run, baseline, skipped, {
    name: 'timing',
    gate: run.timing === null ? 'fault-never-fired' : null,
    order: ['one-write', 'no-uncaught-error', 'settles', 'no-broken-text'],
    own: ({ push }) => push('one-write', oneWrite(run, baseline, step, ownHost)),
  });
}

export const doubleSubmitKind: KindModule = {
  what: (o) => `a double ${o.stepKind === 'press' ? 'press' : 'click'} on ${o.control}`,
  symptom: (o, lead) => {
    if (lead?.id !== 'one-write') return null;
    const n = /one-write: (\d+) successful/.exec(lead.evidence)?.[1] ?? '2';
    const hint = lead.evidence.endsWith(TOGGLE_HINT) ? ` ${TOGGLE_HINT}` : '';
    return `${o.control} sends ${n} successful ${o.template} on a double ${o.stepKind === 'press' ? 'press' : 'click'}${hint}`;
  },
  key: (o) => ({ timing: o.timing, request: o.key, page: o.page }),
  record: (o) => ({ timing: { timing: o.timing, key: o.key, control: o.controlName ?? null, page: o.page }, events: o.events }),
  async run(attack: PlannedAttack, ctx: KindContext): Promise<AttackOutcome> {
    const run = await runFlow({ ...ctx.options, kind: flowRunKind(attack.step), shots: [attack.step] });
    const own = ctx.options.hosts.ownHost;
    const judged = judgeTiming(run, ctx.baseline, attack.step, ctx.skipped, own);
    const writes = run.requests.filter((q) => q.step === attack.step && WRITES.has(q.method) && (q.resourceType === 'fetch' || q.resourceType === 'xhr') && own(q.url));
    return {
      ...attack,
      verdict: judged.verdict,
      checks: judged.checks,
      page: attack.page ?? null,
      control: ctx.control(attack.step),
      events: run.timing
        ? [{ offsetMs: 0, event: run.timing.action, detail: writes.map((q) => `${q.key.replace(/ #\d+$/, '')} ${q.status ?? q.failure ?? 'none'} ${q.bodySha256 ?? '-'}`).join('; ') }]
        : [],
      voided: run.voided,
      served: null,
      notApplied: null,
      givenUp: false,
      run,
    };
  },
};
