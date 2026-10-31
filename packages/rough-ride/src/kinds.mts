// The Attack kind modules (spec part 5 sections 20 to 22, part 6 section 32):
// each one runs a planned attack of its kind as one flow run, through the
// flow run engine's kind hooks, and judges it.

import type { AttackOutcome, PlannedAttack } from './attacks.mjs';
import type { Flow, FlowRunResult, RunFlowOptions } from './flowrun.mjs';
import { doubleSubmitKind } from './kind-double-submit.mjs';
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
}

export type KindId = 'fault' | 'double-submit' | 'out-of-order' | 'page-timing' | 'bad-input' | 'viewport';

// A timing attack's kind comes from its timing id; an attack without a fault is the viewport.
export function kindId(attack: Pick<PlannedAttack, 'kind' | 'timing' | 'fault'>): KindId {
  if (attack.kind === 'bad-input') return 'bad-input';
  if (attack.kind === 'timing') {
    if (attack.timing === 'out-of-order') return 'out-of-order';
    if (attack.timing === 'refresh' || attack.timing === 'back' || attack.timing === 'signed-out-reload') return 'page-timing';
    return 'double-submit';
  }
  if (attack.kind === 'viewport' || attack.fault === null) return 'viewport';
  return 'fault';
}

const MODULES: Partial<Record<KindId, KindModule>> = {
  'double-submit': doubleSubmitKind,
  viewport: viewportKind,
};

export function kindFor(attack: PlannedAttack): KindModule | null {
  return MODULES[kindId(attack)] ?? null;
}
