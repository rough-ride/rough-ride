// The Attack catalogue: every attack point of every flow in one invocation,
// built once from the flows' baseline runs. The tier's selected attacks come
// from it (spec part 4 section 17.7, part 5 sections 21.1 and 21.8, part 8
// section 32.9), and plan entries are resolved against it (part 11 section 45),
// so the attack invocation and `attack --check` name the same attacks.

import { attackPoints, badInputAttack, doubleSubmitPoints, outOfOrderPoints, ownHostFor, pageTimingPoints, viewportAttack, type PlannedAttack } from './attacks.mjs';
import { planBadInputs, tierInputs } from './badinputs.mjs';
import { attackId, type FaultId } from './faults.mjs';
import { findForms, type Form } from './forms.mjs';
import { describeLocator, isLoopbackHostname, type Flow, type FlowRunResult, type LocatorSpec } from './flowrun.mjs';
import type { OpenApiDoc } from './openapi.mjs';
import type { Candidates } from './plan.mjs';
import type { TierName } from './tiers.mjs';

const NO_CREDENTIAL = 'Skipped: signed-out-reload (the session holds no credential the runner can remove or refuse)';

export interface CatalogueFlowInput {
  flow: Flow;
  // Baseline runs, [] when none. Points come from the first; page timing reads all of them.
  runs: FlowRunResult[];
  passed: boolean;
  // In the selection order and traced: only such a flow adds to the tier's share.
  reached?: boolean;
  // Default: the forms of the first run against the changed endpoints.
  forms?: Form[];
  // The earliest step that loaded a changed file.
  firstLoad?: number | null;
  // Reaches a changed file through the module or page rule.
  reachesByRule?: boolean;
}

export interface CatalogueInput {
  // Gates only the share: plan entries and tests see every fault kind and every bad input.
  tier: TierName;
  // In selection order, the sign-in flow last, then the flows nothing reached:
  // the order decides field ownership and the order of the share and skipped lines.
  flows: CatalogueFlowInput[];
  changedEndpoints?: Set<string>;
  docs: OpenApiDoc[];
  // Requests to these hosts are the target's own; body faults forward only to loopback and remoteTarget.
  hosts: { allowed: string[]; remoteTarget: string | null };
  // The session holds no credential: no signed-out-reload in the share.
  noCredential?: boolean;
  today: Date;
}

export interface Catalogue {
  readonly tier: TierName;
  // The tier's selected attacks, flow by flow, before the ordered list, the dedupe and the cut.
  readonly share: readonly PlannedAttack[];
  readonly skipped: readonly string[];
  readonly fieldsNotAttacked: readonly string[];
}

interface FaultRef { id: string; key: string; fault: FaultId; sticky: boolean }
interface InputRef { id: string; fieldKey: string; carrying: string | null; formName: string }

// What a plan entry can name on one flow. A recorded catalogue keeps only this.
interface FlowEntry { name: string; baseline: boolean; faults: FaultRef[]; inputs: InputRef[] }

// What only a freshly built catalogue holds: the attacks themselves, in the
// same order as the flow's refs, and what regression tests resolve against.
interface FreshFlow {
  faults: PlannedAttack[];
  inputs: PlannedAttack[];
  viewport: PlannedAttack | null;
  flow: Flow;
  runs: FlowRunResult[];
  forms: Form[];
  firstLoad: number | null;
  reachesByRule: boolean;
}

interface Inside {
  tier: TierName;
  flows: Map<string, FlowEntry>;
  // fieldKey -> the flow whose selected bad inputs attack that field (21.1).
  fieldOwner: Map<string, string>;
  fresh: {
    flows: Map<string, FreshFlow>;
    docs: OpenApiDoc[];
    changed: Set<string>;
    ownHost: (url: string) => boolean;
    forwardable: (url: string) => boolean;
    today: Date;
  } | null;
}

const inside = new WeakMap<Catalogue, Inside>();

export function buildCatalogue(input: CatalogueInput): Catalogue {
  const ownHost = ownHostFor(input.hosts.allowed);
  const forwardable = (url: string) => {
    try {
      const host = new URL(url).hostname;
      return isLoopbackHostname(host) || host === input.hosts.remoteTarget;
    } catch {
      return false;
    }
  };
  const changed = input.changedEndpoints ?? new Set<string>();
  const share: PlannedAttack[] = [];
  const skipped: string[] = [];
  const fieldsNotAttacked: string[] = [];
  const fieldOwner = new Map<string, string>();
  const flows = new Map<string, FlowEntry>();
  const freshFlows = new Map<string, FreshFlow>();
  for (const f of input.flows) {
    const name = f.flow.name;
    if (flows.has(name)) throw new Error(`flow ${name} is in the catalogue input twice`);
    const signIn = name === 'sign-in';
    const baseline = f.runs[0];
    const firstLoad = f.firstLoad ?? null;
    const reachesByRule = f.reachesByRule ?? false;
    const forms = f.forms ?? (baseline ? findForms(f.flow, baseline, ownHost, changed) : []);
    // A plan entry may name any fault kind on any flow with a baseline run (45.4).
    const faults = baseline ? attackPoints(f.flow, baseline, ownHost, changed, firstLoad, { tier: 'standard', signInFlow: signIn, forwardable, docs: input.docs }) : [];
    // validatePlan refuses bad inputs on the sign-in flow before asking for them.
    const allInputs = baseline ? planBadInputs(f.flow, baseline, forms, input.docs, { signInFlow: false, today: input.today }) : null;
    const inputs = (allInputs?.inputs ?? []).map((p) => badInputAttack(name, p, 2, firstLoad));
    flows.set(name, {
      name,
      baseline: !!baseline,
      faults: faults.map((a) => ({ id: a.id, key: a.key, fault: a.fault!, sticky: a.sticky })),
      inputs: inputs.map((a) => ({ id: a.id, fieldKey: a.badInput!.fieldKey, carrying: a.badInput!.carrying, formName: a.badInput!.formName })),
    });
    freshFlows.set(name, { faults, inputs, viewport: signIn ? null : viewportAttack(f.flow, reachesByRule), flow: f.flow, runs: f.runs, forms, firstLoad, reachesByRule });

    if (!f.reached || !f.passed || !baseline) continue;
    const points = input.tier === 'standard' ? faults : attackPoints(f.flow, baseline, ownHost, changed, firstLoad, { tier: input.tier, signInFlow: signIn, forwardable, docs: input.docs });
    skipped.push(...(points.skipped ?? []));
    // double-submit in both tiers (32.9), and one viewport attack per reached flow (22.3); neither on the sign-in flow.
    const doubles = doubleSubmitPoints(f.flow, baseline, ownHost, changed, firstLoad, signIn);
    skipped.push(...(doubles.skipped ?? []));
    // Bad inputs: every form of a reached flow, in the tier's share; a field once per invocation (21.1, 21.8).
    const badPlan = signIn ? planBadInputs(f.flow, baseline, forms, input.docs, { signInFlow: true, today: input.today }) : allInputs!;
    skipped.push(...badPlan.skipped);
    fieldsNotAttacked.push(...badPlan.fieldsNotAttacked);
    const bads: PlannedAttack[] = [];
    for (const { band, plan } of tierInputs(badPlan.inputs, input.tier)) {
      const owner = fieldOwner.get(plan.fieldKey);
      if (owner && owner !== name) continue;
      fieldOwner.set(plan.fieldKey, name);
      bads.push(badInputAttack(name, plan, band, firstLoad));
    }
    // out-of-order, refresh, back and signed-out-reload: standard only (32.9).
    const stale = input.tier === 'standard' ? outOfOrderPoints(f.flow, baseline, forms, ownHost, changed, firstLoad, signIn) : [];
    const pageKinds = input.tier === 'standard' ? pageTimingPoints(f.flow, f.runs, changed, firstLoad, signIn) : [];
    if (input.tier === 'standard') skipped.push(...(pageKinds.skipped ?? []));
    if (input.noCredential && pageKinds.some((a) => a.timing === 'signed-out-reload') && !skipped.includes(NO_CREDENTIAL)) skipped.push(NO_CREDENTIAL);
    const pageAttacks = pageKinds.filter((a) => !(input.noCredential && a.timing === 'signed-out-reload'));
    share.push(...points, ...doubles, ...stale, ...pageAttacks, ...bads, ...(signIn ? [] : [viewportAttack(f.flow, reachesByRule)]));
  }
  const catalogue: Catalogue = { tier: input.tier, share, skipped, fieldsNotAttacked };
  inside.set(catalogue, {
    tier: input.tier,
    flows,
    fieldOwner,
    fresh: { flows: freshFlows, docs: input.docs, changed, ownHost, forwardable, today: input.today },
  });
  return catalogue;
}

export interface PlanScope {
  // Ids of the selected attacks above the cut.
  selected: Iterable<string>;
  // Flows with a selected attack or a test inside the cut, and flows saved in this run (45.5).
  aboveFlows: Iterable<string>;
}

// validatePlan's callbacks (45.4): what each plan entry names in this catalogue,
// or why it names nothing, in the words the attack invocation uses.
export function planCandidates(catalogue: Catalogue, scope: PlanScope): Omit<Candidates, 'checks'> {
  const c = inside.get(catalogue)!;
  const selected = new Set(scope.selected);
  const fresh = (name: string) => c.fresh?.flows.get(name);
  return {
    tier: c.tier,
    aboveFlows: new Set(scope.aboveFlows),
    allFlows: new Set(c.flows.keys()),
    selected,
    fault: (name, request, fault, oneShot) => {
      const entry = c.flows.get(name);
      const same = (entry?.faults ?? []).filter((a) => a.key === request);
      if (same.length === 0) return `${request} is not an attack point of ${name}`;
      const kind = same.filter((a) => a.fault === fault);
      if (kind.length === 0) return `${fault} does not apply to ${request}`;
      const pick = (ref: FaultRef) => fresh(name)?.faults[entry!.faults.indexOf(ref)] ?? named(name, ref.id);
      if (!oneShot) return pick(kind.find((a) => a.sticky) ?? kind[0]!);
      const once = kind.find((a) => !a.sticky);
      if (once) return pick(once);
      // The one-shot form of a kind that is only sticky (27.16).
      const sticky = kind[0]!;
      return { ...pick(sticky), sticky: false, id: attackId(name, sticky.key, sticky.fault, false) };
    },
    badInputs: (name, form) => {
      const entry = c.flows.get(name);
      if (!entry?.baseline) return `${name} has no baseline run`;
      const submit = !!form && typeof form === 'object' && 'submit' in (form as object) ? describeLocator((form as { submit: LocatorSpec }).submit) : null;
      const matches = entry.inputs.filter((p) => (typeof form === 'string' ? p.carrying === form : submit !== null && submit === p.formName));
      if (matches.length === 0) return `${typeof form === 'string' ? form : 'that form'} is not a form of ${name}`;
      return matches
        .filter((p) => !c.fieldOwner.has(p.fieldKey) || c.fieldOwner.get(p.fieldKey) === name)
        .filter((p) => !selected.has(p.id))
        .map((p) => fresh(name)?.inputs[entry.inputs.indexOf(p)] ?? named(name, p.id));
    },
    viewport: (name) => {
      if (!c.flows.has(name) || name === 'sign-in') return 'no viewport attack on the sign-in flow';
      return fresh(name)?.viewport ?? named(name, `${name}/viewport-375`);
    },
  };
}

// A recorded catalogue names attacks without building them: attack --check
// reads only their ids and flows, and attack builds them from fresh runs.
const named = (flow: string, id: string): PlannedAttack => ({ id, flow } as PlannedAttack);
