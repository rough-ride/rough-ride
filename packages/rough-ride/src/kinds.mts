// The Attack kind modules (spec part 5 sections 20 to 22, part 6 section 32):
// each one runs a planned attack of its kind as one flow run, through the
// flow run engine's kind hooks, and judges it.

import type { AttackLink } from './accounting.mjs';
import type { MatchedAttack } from './appchecks.mjs';
import type { AttackOutcome, NonFinding, PlannedAttack } from './attacks.mjs';
import type { BadInputPlan } from './badinputs.mjs';
import type { CheckResult } from './checks.mjs';
import type { FaultId } from './faults.mjs';
import type { Flow, FlowRunResult, RequestRecord, RunFlowOptions } from './flowrun.mjs';
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

// The fields each kind's attacks always carry beyond PlannedAttack's shared ones.
export interface KindFields {
  fault: { fault: FaultId };
  'bad-input': { badInput: BadInputPlan };
  'double-submit': object;
  'out-of-order': { outOfOrder: NonNullable<PlannedAttack['outOfOrder']> };
  'page-timing': object;
  viewport: object;
}

export type KindId = keyof KindFields;

// A kind module, handed its attacks with the fields of its kind (F).
export interface KindModule<F extends object = object> {
  run(attack: PlannedAttack & F, ctx: KindContext): Promise<AttackOutcome>;
  // The symptom's words for what the attack did (37).
  what(o: AttackOutcome & F): string;
  // The symptom when the lead check is one the kind words itself, or null.
  symptom?(o: AttackOutcome & F, lead: CheckResult | null): string | null;
  // The attack as a regression test and a repro key it.
  key(o: AttackOutcome & F): Record<string, unknown>;
  // The run record's fields for this kind (38).
  record(o: AttackOutcome & F): Record<string, unknown>;
  // An app check's outcome class (45.7); none when the kind has no such classes.
  appOutcome?(attack: MatchedAttack, run: FlowRunResult): { cls: 'told' | 'refused' | 'accepted' | null; shown: string };
  // The id an app check's when.ids names the attack by (45.7), or null.
  appId(attack: MatchedAttack): string | null;
  // The attack link's kind word and the endpoints the attack went to (selection, 17).
  link(attack: LinkedAttack): { kind: AttackLink['kind']; endpoints: string[] };
  // Which line that is never a finding (20.15) the attack gets, in the kind's order, or null.
  nonFinding(o: AttackOutcome & F, lines: NonFindingLines): NonFinding | null;
  // The group key's page and action (34).
  groupKey(o: AttackOutcome & F, at: GroupKeyFacts): { page: string; action: string };
}

// What an attack link is made from: a planned attack or its outcome.
export type LinkedAttack = Pick<PlannedAttack, 'kind' | 'timing' | 'fault' | 'template' | 'writeKeys'>;

// The non-finding lines every kind shares, for its own order.
export interface NonFindingLines {
  // `Not applied: <id> (<why>)`.
  notApplied(): NonFinding;
  // `Faulted; flow stopped at step <n>: <id>`, when a later step failed.
  flowStopped(): NonFinding | null;
  // A fault still pending, then the verdict's own line.
  byVerdict(): NonFinding | null;
}

// The attack's request in the run, and section 34's suffixes for its action.
export interface GroupKeyFacts {
  request: RequestRecord | null;
  suffixes(entry: boolean): string;
}

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

const MODULES: { [K in KindId]: KindModule<KindFields[K]> } = {
  fault: faultKind,
  'bad-input': badInputKind,
  'double-submit': doubleSubmitKind,
  'out-of-order': outOfOrderKind,
  'page-timing': pageTimingKind,
  viewport: viewportKind,
};

const hasFault = <T extends PlannedAttack>(a: T): a is T & KindFields['fault'] => a.fault !== null;
const hasBadInput = <T extends PlannedAttack>(a: T): a is T & KindFields['bad-input'] => a.badInput !== undefined;
const hasOutOfOrder = <T extends PlannedAttack>(a: T): a is T & KindFields['out-of-order'] => a.outOfOrder !== undefined;

// Calls `use` with the attack's kind module and the attack typed with its
// kind's fields; an attack without them is a builder's mistake.
export function withKind<T extends PlannedAttack, R>(attack: T, use: <F extends object>(kind: KindModule<F>, attack: T & F) => R): R {
  const id = kindId(attack);
  if (id === 'fault' && hasFault(attack)) return use(MODULES.fault, attack);
  if (id === 'bad-input' && hasBadInput(attack)) return use(MODULES['bad-input'], attack);
  if (id === 'out-of-order' && hasOutOfOrder(attack)) return use(MODULES['out-of-order'], attack);
  if (id === 'double-submit' || id === 'page-timing' || id === 'viewport') return use(MODULES[id], attack);
  throw new Error(`${attack.id}: kind ${id} without the fields that kind needs`);
}

// What a kind says about an attack that is not a PlannedAttack: an app
// check's matched attack, or an attack link's source.
export function kindFor(attack: Parameters<typeof kindId>[0]): Pick<KindModule, 'appOutcome' | 'appId' | 'link'> {
  return MODULES[kindId(attack)];
}
