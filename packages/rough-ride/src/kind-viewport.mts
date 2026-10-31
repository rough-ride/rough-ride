// The viewport attack (spec part 5 section 22.3, check 9): the flow run at a
// plain 375 x 800, each step's sideways overflow, and no-overflow-375.

import type { AttackOutcome, PlannedAttack } from './attacks.mjs';
import { judgeAttack, type Judged } from './checks.mjs';
import { runFlow, type AttackKind, type FlowRunResult } from './flowrun.mjs';
import type { KindContext, KindModule } from './kinds.mjs';

export const VIEWPORT = { width: 375, height: 800 };

const flowRunKind: AttackKind = {
  viewport: VIEWPORT,
  start: (engine) => ({
    // The first step after which the page scrolls sideways keeps a screenshot.
    wantsShot: (after) => (after.overflow ?? 0) > 1 && !engine.result.steps.some((x) => (x.overflowPx ?? 0) > 1),
    stepFacts: (after) => ({ overflowPx: after.overflow, innerWidth: after.innerWidth }),
  }),
};

// Judged by no-uncaught-error, settles, no-broken-text and no-overflow-375.
// The judged step is the first step after which overflow was measured.
export function judgeViewport(run: FlowRunResult, baseline: FlowRunResult, skipped: Set<string>): Judged & { step: number | null } {
  const overflowing = run.steps.find((s) => (s.overflowPx ?? 0) > 1) ?? null;
  const judged = judgeAttack(run, baseline, skipped, {
    name: 'viewport',
    gate: null,
    order: ['no-uncaught-error', 'settles', 'no-broken-text', 'no-overflow-375'],
    own: ({ push }) => push('no-overflow-375', overflowing ? `${overflowing.path ?? 'the page'} is ${overflowing.overflowPx} px wider than the 375 px viewport after ${overflowing.label}` : null),
  });
  return { ...judged, step: overflowing?.index ?? null };
}

export const viewportKind: KindModule = {
  what: () => 'the 375px viewport',
  symptom: (o, lead) => (lead?.id === 'no-overflow-375' ? `${o.page ?? 'the page'} scrolls sideways at 375px` : null),
  key: () => ({ viewport: 375 }),
  record: () => ({ viewport: { width: 375, height: 800 } }),
  appId: () => null,
  link: () => ({ kind: 'viewport', endpoints: [] }),
  nonFinding: (_o, lines) => lines.flowStopped() ?? lines.byVerdict(),
  groupKey: (o) => ({ page: o.page ?? '/', action: 'viewport 375' }),
  async run(attack: PlannedAttack, ctx: KindContext): Promise<AttackOutcome> {
    const run = await runFlow({ ...ctx.options, kind: flowRunKind, shots: [] });
    const judged = judgeViewport(run, ctx.baseline, ctx.skipped);
    const step = judged.step ?? attack.step;
    return {
      ...attack,
      step,
      verdict: judged.verdict,
      checks: judged.checks,
      page: run.steps.find((s) => s.index === step)?.path ?? null,
      control: 'viewport 375',
      events: [],
      voided: run.voided,
      served: null,
      notApplied: null,
      givenUp: false,
      run,
    };
  },
};
