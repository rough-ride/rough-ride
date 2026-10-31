// The Attack catalogue: every attack point of every flow in one invocation,
// built once from the flows' baseline runs. The tier's selected attacks come
// from it (spec part 4 section 17.7, part 5 sections 21.1 and 21.8, part 8
// section 32.9), and plan entries are resolved against it (part 11 section 45),
// so the attack invocation and `attack --check` name the same attacks.

import { attackPoints, badInputAttack, doubleSubmitPoints, outOfOrderPoints, ownHostFor, pageTimingPoints, viewportAttack, type PlannedAttack } from './attacks.mjs';
import { planBadInputs, tierInputs } from './badinputs.mjs';
import { attackId, type FaultId } from './faults.mjs';
import { findForms, type Form } from './forms.mjs';
import { describeLocator, isLoopbackHostname, stepKind, type Flow, type FlowRunResult, type LocatorSpec } from './flowrun.mjs';
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
  // Flows saved after the planning invocation: what plan recorded for them no longer counts.
  changedSince?: Iterable<string>;
}

// validatePlan's callbacks (45.4): what each plan entry names in this catalogue,
// or why it names nothing, in the words the attack invocation uses.
export function planCandidates(catalogue: Catalogue, scope: PlanScope): Omit<Candidates, 'checks'> {
  const c = inside.get(catalogue)!;
  const selected = new Set(scope.selected);
  const changedSince = new Set(scope.changedSince ?? []);
  const fresh = (name: string) => c.fresh?.flows.get(name);
  const savedLater = (name: string) => ({ unchecked: `flow ${name} was saved after the plan; attack checks its points` });
  return {
    tier: c.tier,
    aboveFlows: new Set(scope.aboveFlows),
    allFlows: new Set([...c.flows.keys(), ...changedSince]),
    selected,
    fault: (name, request, fault, oneShot) => {
      if (changedSince.has(name)) return savedLater(name);
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
      if (changedSince.has(name)) return savedLater(name);
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
      if (name === 'sign-in') return 'no viewport attack on the sign-in flow';
      if (changedSince.has(name)) return savedLater(name);
      if (!c.flows.has(name)) return 'no viewport attack on the sign-in flow';
      return fresh(name)?.viewport ?? named(name, `${name}/viewport-375`);
    },
  };
}

// A recorded catalogue names attacks without building them: attack --check
// reads only their ids and flows, and attack builds them from fresh runs.
const named = (flow: string, id: string): PlannedAttack => ({ id, flow } as PlannedAttack);

// runs/<id>/catalogue.json: what plan entries can name, with no bad-input
// values. For any plan, planCandidates(fromRecord(toRecord(c, s))) gives the
// same ids and the same refusals as planCandidates(c, s).
export interface CatalogueRecord {
  format: 1;
  tier: TierName;
  flows: FlowEntry[];
  fieldOwner: [string, string][];
  selected: string[];
  aboveFlows: string[];
}

export function toRecord(catalogue: Catalogue, scope: PlanScope): CatalogueRecord {
  const c = inside.get(catalogue)!;
  return { format: 1, tier: c.tier, flows: [...c.flows.values()], fieldOwner: [...c.fieldOwner], selected: [...scope.selected], aboveFlows: [...new Set(scope.aboveFlows)] };
}

// The recorded catalogue and its scope, or null when the file isn't one.
export function fromRecord(value: unknown): { catalogue: Catalogue; scope: { selected: string[]; aboveFlows: string[] } } | null {
  const r = value as Partial<CatalogueRecord> | null;
  const str = (x: unknown): x is string => typeof x === 'string';
  const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(str);
  if (!r || typeof r !== 'object' || r.format !== 1 || (r.tier !== 'quick' && r.tier !== 'standard')) return null;
  if (!strings(r.selected) || !strings(r.aboveFlows) || !Array.isArray(r.fieldOwner) || !r.fieldOwner.every((p) => strings(p) && p.length === 2)) return null;
  if (!Array.isArray(r.flows)) return null;
  const flows = new Map<string, FlowEntry>();
  for (const f of r.flows as unknown[]) {
    const e = f as Partial<FlowEntry> | null;
    if (!e || !str(e.name) || typeof e.baseline !== 'boolean' || !Array.isArray(e.faults) || !Array.isArray(e.inputs) || flows.has(e.name)) return null;
    if (!e.faults.every((x) => x && str(x.id) && str(x.key) && str(x.fault) && typeof x.sticky === 'boolean')) return null;
    if (!e.inputs.every((x) => x && str(x.id) && str(x.fieldKey) && (x.carrying === null || str(x.carrying)) && str(x.formName))) return null;
    flows.set(e.name, { name: e.name, baseline: e.baseline, faults: e.faults, inputs: e.inputs });
  }
  const catalogue: Catalogue = { tier: r.tier, share: [], skipped: [], fieldsNotAttacked: [] };
  inside.set(catalogue, { tier: r.tier, flows, fieldOwner: new Map(r.fieldOwner as [string, string][]), fresh: null });
  return { catalogue, scope: { selected: r.selected, aboveFlows: r.aboveFlows } };
}

export type TestResolution = { attack: PlannedAttack } | { stale: string } | { pass: string };

// A regression test's or repro's attack point in this baseline run, never
// retargeting (25.3): a point that moved or went reads stale.
export function resolveTest(catalogue: Catalogue, name: string, a: Record<string, unknown>): TestResolution {
  const fresh = inside.get(catalogue)?.fresh;
  const f = fresh?.flows.get(name);
  const baseline = f?.runs[0];
  if (!fresh || !f || !baseline) throw new Error(`no baseline run of ${name} in this catalogue`);
  const { flow, forms, firstLoad } = f;
  const signIn = name === 'sign-in';
  const requestOf = (key: string) => baseline.requests.find((q) => q.key === key && (q.resourceType === 'fetch' || q.resourceType === 'xhr'));
  const fullLoadOf = (page: unknown) => baseline.pages.some((p) => p.path === page && p.entry === 'full-load');
  if (typeof a.fault === 'string') {
    const request = String(a.request);
    const q = requestOf(request);
    if (!q) {
      if (fullLoadOf(a.page)) return { stale: `fault never fired: ${request.replace(/ #\d+$/, '')} is no longer sent from the browser on ${String(a.page)} (the flow enters it by full page load)` };
      return { stale: `fault never fired (${request} not sent)` };
    }
    if (a.page !== undefined && q.pagePath !== a.page) return { stale: `attack point moved (${request} is now sent on ${q.pagePath ?? '?'}, was ${String(a.page)})` };
    const exact = f.faults.find((p) => p.key === request && p.fault === a.fault && p.sticky === a.sticky);
    if (exact) return { attack: exact };
    const any = f.faults.find((p) => p.key === request);
    if (!any) return { stale: `fault never fired (${request} can't take ${String(a.fault)})` };
    const fault = a.fault as FaultId;
    return { attack: { ...any, fault, sticky: a.sticky === true, id: attackId(name, request, fault, a.sticky === true) } };
  }
  if (typeof a.badInput === 'string') {
    const plan = planBadInputs(flow, baseline, forms, fresh.docs, { signInFlow: signIn, today: fresh.today });
    const field = a.field as string | { name: string; kind: string } | null;
    const matches = (i: (typeof plan.inputs)[number]) =>
      i.inputId === a.badInput && i.page === a.page && (typeof field === 'string' ? i.field.key === field : !!field && i.field.name === field.name && i.field.kind === field.kind);
    const input = plan.inputs.find(matches);
    if (input) return { attack: badInputAttack(name, input, 1, firstLoad) };
    const blocked = plan.skipped.find((l) => l.includes(`: ${String(a.badInput)} (blocked by the browser's validation: `));
    if (blocked) return { pass: `pass (${/\((blocked by the browser's validation: [^)]*)\)/.exec(blocked)?.[1] ?? 'blocked by the browser'})` };
    return { stale: 'field not found' };
  }
  if (a.viewport !== undefined) return { attack: viewportAttack(flow, f.reachesByRule) };
  if (a.timing === 'double-submit') {
    const request = String(a.request);
    const found = doubleSubmitPoints(flow, baseline, fresh.ownHost, fresh.changed, firstLoad, signIn).find((p) => p.key === request);
    if (found) return found.page === a.page ? { attack: found } : { stale: `attack point moved (${request} is now sent on ${found.page ?? '?'}, was ${String(a.page)})` };
    const q = baseline.requests.find((r) => r.key === request);
    if (q) {
      const kind = stepKind(flow.steps[q.step - 1] ?? { goto: '/' });
      if (kind !== 'click' && kind !== 'press') return { stale: `attack point moved (${request} is no longer sent by a click or press step)` };
      return { stale: `attack point moved (${request} is now sent on ${q.pagePath ?? '?'}, was ${String(a.page)})` };
    }
    return { stale: `fault never fired (${request} not sent)` };
  }
  if (a.timing === 'out-of-order') {
    const found = outOfOrderPoints(flow, baseline, forms, fresh.ownHost, fresh.changed, firstLoad, signIn).find((p) => p.template === a.request && p.outOfOrder?.fieldKey === a.field);
    return found ? { attack: found } : { stale: 'field not found' };
  }
  if (a.timing === 'refresh' || a.timing === 'back' || a.timing === 'signed-out-reload') {
    const found = pageTimingPoints(flow, [baseline], fresh.changed, firstLoad, signIn).find((p) => p.timing === a.timing && p.page === a.page && p.entry?.k === a.entry);
    if (found) return { attack: found };
    const entries = baseline.pages.filter((p) => p.path === a.page);
    const entry = entries[Number(a.entry) - 1];
    if (entry?.entry === 'full-load') return { stale: `attack point moved (${String(a.page)} #${String(a.entry)} is now entered by full page load)` };
    return { stale: `fault never fired (the flow no longer enters ${String(a.page)})` };
  }
  return { stale: 'unknown attack' };
}
