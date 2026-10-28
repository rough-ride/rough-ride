// Bands, the ordered list, nominal time and the cut (spec part 12 sections
// 48.3, 48.6 and 48.7). Only nominal time decides the cut, so the same
// footprints give the same selection on any machine.

import { createHash } from 'node:crypto';
import type { PlannedAttack } from './attacks.mjs';
import { stepKind, type Flow, type FlowRunResult } from './flowrun.mjs';
import { canonicalJson } from './output.mjs';
import { TIER_TABLE, type TierName } from './tiers.mjs';

const N = TIER_TABLE.nominal;
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function bandOf(rank: number): 1 | 2 | 3 {
  return TIER_TABLE.tiers.standard.kinds.find((k) => k.rank === rank)?.band ?? 3;
}

// One step's nominal cost: a full page load, an action step or an expect.
function stepMs(flow: Flow, baseline: FlowRunResult | undefined, index: number): number {
  const step = flow.steps[index - 1];
  if (!step) return 0;
  const kind = stepKind(step);
  if (kind === 'expect') return N.expectMs;
  const fullLoad = kind === 'goto' || (baseline?.pages.some((p) => p.step === index && p.entry === 'full-load') ?? false);
  return fullLoad ? N.fullLoadMs : N.actionStepMs;
}

function stepsMs(flow: Flow, baseline: FlowRunResult | undefined, from: number, to: number): number {
  let ms = 0;
  for (let i = from; i <= to; i++) ms += stepMs(flow, baseline, i);
  return ms;
}

// The nominal run of a flow: 400 ms plus its steps.
export function flowNominalMs(flow: Flow, baseline?: FlowRunResult): number {
  return N.perRunMs + stepsMs(flow, baseline, 1, flow.steps.length);
}

// Section 48.6's nominal time of one attack, over the steps it runs plus its surcharge.
export function attackNominalMs(a: PlannedAttack, flow: Flow, baseline?: FlowRunResult): number {
  const last = flow.steps.length;
  const all = N.perRunMs + stepsMs(flow, baseline, 1, last);
  const recovery = stepsMs(flow, baseline, a.step, last);
  const s = N.surcharges;
  if (a.kind === 'viewport') return all;
  if (a.kind === 'bad-input' && a.badInput) {
    return all + a.badInput.formSteps.reduce((n, i) => n + stepMs(flow, baseline, i), 0) + stepsMs(flow, baseline, a.badInput.submitStep, last);
  }
  if (a.kind === 'timing') {
    switch (a.timing) {
      case 'double-submit':
        return all + s.doubleSubmitMs;
      case 'out-of-order':
        return all + s.outOfOrderMs;
      case 'refresh':
        return all + s.refreshMs;
      case 'back':
        return all + s.backMs;
      case 'signed-out-reload':
        return N.perRunMs + stepsMs(flow, baseline, 1, a.step) + s.signedOutReloadMs;
      default:
        return all;
    }
  }
  const write = WRITES.has(a.template.split(' ')[0] ?? '');
  switch (a.fault) {
    case 'hang':
      return N.perRunMs + stepsMs(flow, baseline, 1, a.step - 1) + s.hangStepMs;
    case 'delay-3s':
      return all + s.delayMs;
    case '401':
    case 'malformed-json':
    case 'empty-200':
      return all + s.oneShotMs;
    default:
      return a.sticky ? all + (write ? s.stickyWriteGraceMs : s.stickyReadGraceMs) + recovery : all + s.oneShotMs;
  }
}

// Inside one flow and band: closeness, kind rank, step index, attack id by code point.
const inFlowOrder = (a: PlannedAttack, b: PlannedAttack) =>
  a.closeness - b.closeness || a.rank - b.rank || a.step - b.step || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Section 48.3's list: band 1 on every flow but the sign-in flow, flow by flow
// in selection order, then band 2, then band 3, then the sign-in segment band by band.
export function orderedList(flowOrder: string[], attacks: PlannedAttack[], signIn = 'sign-in'): PlannedAttack[] {
  const out: PlannedAttack[] = [];
  const others = flowOrder.filter((f) => f !== signIn);
  for (const band of [1, 2, 3] as const) {
    for (const flow of others) out.push(...attacks.filter((a) => a.flow === flow && bandOf(a.rank) === band).sort(inFlowOrder));
  }
  for (const band of [1, 2, 3] as const) out.push(...attacks.filter((a) => a.flow === signIn && bandOf(a.rank) === band).sort(inFlowOrder));
  return out;
}

export interface CutResult {
  nominalPlanMs: number;
  windowMs: number;
  // Per item, in list order: its nominal time and whether it falls inside the cut.
  items: { attack: PlannedAttack; nominalMs: number; aboveCut: boolean }[];
  selectionDigest: string;
}

// List-schedules `durations` on `lanes` lanes; returns each item's finish time.
function schedule(durations: number[], lanes: number, startAt: number[]): number[] {
  const free = [...startAt];
  return durations.map((d) => {
    let lane = 0;
    for (let i = 1; i < free.length; i++) if (free[i]! < free[lane]!) lane = i;
    free[lane] = free[lane]! + d;
    return free[lane]!;
  });
}

// Section 48.7: P_nom, the window W, and the cut on 3 reference lanes.
export function computeCut(options: {
  tier: TierName;
  list: PlannedAttack[];
  nominal: (a: PlannedAttack) => number;
  signInNominalMs: number;
  // Every other baseline run of the invocation, nominal ms each.
  baselineNominalMs: number[];
  signIn?: string;
  tableSha256: string;
}): CutResult {
  const lanes = TIER_TABLE.referenceLanes;
  const B = TIER_TABLE.tiers[options.tier].budgetMs;
  const baselineFinish = schedule(options.baselineNominalMs, lanes, new Array(lanes).fill(0));
  const nominalPlanMs = options.signInNominalMs + Math.max(0, ...baselineFinish) + N.surcharges.openApiMs;
  const windowMs = B - nominalPlanMs - N.surcharges.reportMs;
  const signIn = options.signIn ?? 'sign-in';
  const free = new Array(lanes).fill(0);
  let cutFrom = -1;
  const items = options.list.map((attack) => ({ attack, nominalMs: options.nominal(attack), aboveCut: true }));
  // Selected attacks on other flows, then the sign-in segment once every lane is free.
  let segmentStarted = false;
  for (const [i, item] of items.entries()) {
    if (item.attack.flow === signIn && !segmentStarted) {
      segmentStarted = true;
      const all = Math.max(...free);
      free.fill(all);
    }
    let lane = 0;
    for (let l = 1; l < lanes; l++) if (free[l] < free[lane]) lane = l;
    free[lane] += item.nominalMs;
    if (free[lane] > windowMs && cutFrom === -1) cutFrom = i;
  }
  if (cutFrom !== -1) for (let i = cutFrom; i < items.length; i++) items[i]!.aboveCut = false;
  const selectionDigest = createHash('sha256')
    .update(canonicalJson({ tableSha256: options.tableSha256, attacks: items.map((x) => [x.attack.id, x.aboveCut]) }))
    .digest('hex');
  return { nominalPlanMs, windowMs, items, selectionDigest };
}

// Section 50.1's reserve: the measured durations of the first L failed
// attacks so far, plus 3,000 ms for the report.
export function reserveMs(failedDurations: number[], tier: TierName): number {
  const L = tier === 'standard' ? 5 : 3;
  return failedDurations.slice(0, L).reduce((n, d) => n + d, 0) + N.surcharges.reportMs;
}
