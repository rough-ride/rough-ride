// The Attack kind modules (spec part 5 sections 20 to 22, part 6 section 32):
// each one runs a planned attack of its kind as one flow run, through the
// flow run engine's kind hooks, and judges it.

import type { MatchedAttack } from './appchecks.mjs';
import type { AttackOutcome, PlannedAttack } from './attacks.mjs';
import type { CheckResult } from './checks.mjs';
import type { Flow, FlowRunResult, RunFlowOptions } from './flowrun.mjs';
import { badInputKind } from './kind-bad-input.mjs';
import { doubleSubmitKind } from './kind-double-submit.mjs';
import { faultKind } from './kind-fault.mjs';
import { outOfOrderKind } from './kind-out-of-order.mjs';
import { pageTimingKind } from './kind-page-timing.mjs';
import { viewportKind } from './kind-viewport.mjs';
import type { OpenApiDoc } from './openapi.mjs';

export interface KindContext {
  flow: Flow;
  baseline: FlowRunResult;
  // Every attack's flow run options: the shared ones, the flow, the OpenAPI
  // templates and the baseline run's polling keys.
  options: RunFlowOptions;
  docs: OpenApiDoc[];
  // Checks that already fail in the baseline run.
  skipped: Set<string>;
  // The judged step's locator as written, or its goto path.
  control(step: number): string;
}

export interface KindModule {
  run(attack: PlannedAttack, ctx: KindContext): Promise<AttackOutcome>;
  // The symptom's words for what the attack did (37).
  what(o: AttackOutcome): string;
  // The symptom when the lead check is one the kind words itself, or null.
  symptom?(o: AttackOutcome, lead: CheckResult | null): string | null;
  // The attack as a regression test and a repro key it.
  key(o: AttackOutcome): Record<string, unknown>;
  // The run record's fields for this kind (38).
  record(o: AttackOutcome): Record<string, unknown>;
  // An app check's outcome class (45.7); none when the kind has no such classes.
  appOutcome?(attack: MatchedAttack, run: FlowRunResult): { cls: 'told' | 'refused' | 'accepted' | null; shown: string };
}

export type KindId = 'fault' | 'double-submit' | 'out-of-order' | 'page-timing' | 'bad-input' | 'viewport';

// A timing attack's kind comes from its timing id; an attack without a fault is the viewport.
export function kindId(attack: { kind: PlannedAttack['kind']; timing?: string; fault: string | null }): KindId {
  if (attack.kind === 'bad-input') return 'bad-input';
  if (attack.kind === 'timing') {
    if (attack.timing === 'out-of-order') return 'out-of-order';
    if (attack.timing === 'refresh' || attack.timing === 'back' || attack.timing === 'signed-out-reload') return 'page-timing';
    return 'double-submit';
  }
  if (attack.kind === 'viewport' || attack.fault === null) return 'viewport';
  return 'fault';
}

const MODULES: Record<KindId, KindModule> = {
  fault: faultKind,
  'bad-input': badInputKind,
  'double-submit': doubleSubmitKind,
  'out-of-order': outOfOrderKind,
  'page-timing': pageTimingKind,
  viewport: viewportKind,
};

export function kindFor(attack: Parameters<typeof kindId>[0]): KindModule {
  return MODULES[kindId(attack)];
}
