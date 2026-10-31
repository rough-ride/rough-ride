// Selected fault and viewport attacks (spec part 4 section 17.7, part 5
// sections 20.2, 20.11 and 22.3): attack points from each reached flow's
// baseline run, their order, and one flow run per attack. Bands, the cut and
// lanes come in tickets 28 and 29.

import type { AttackLink } from './accounting.mjs';
import { fieldKind, requestKey, type BadInputPlan } from './badinputs.mjs';
import { judgeAppChecks, matchesWhen, probeFor, type AppCheck } from './appchecks.mjs';
import { baselineFailures, checkLabel, checkSeverity, leadCheck, type CheckResult } from './checks.mjs';
import { TOGGLE_HINT } from './kind-double-submit.mjs';
import { SEVERITY_TEXT, type Group } from './groups.mjs';
import { LOOPBACK_ONLY, type HostPolicy } from './hosts.mjs';
import { membersText } from './summary.mjs';
import { attackId, emptyForm, FAULT_PHRASE, isJsonMedia, kindsFor, responseSchema, type BodyKind, type FaultId } from './faults.mjs';
import type { Form } from './forms.mjs';
import { describeLocator, isFrameworkInternal, stepKind, type Flow, type FlowRunResult, type LocatorSpec, type RequestRecord, type RunFlowOptions, type Served } from './flowrun.mjs';
import { kindFor } from './kinds.mjs';
import { matchTemplate, type OpenApiDoc } from './openapi.mjs';

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const VIEWPORT_RANK = 7;

export interface PlannedAttack {
  id: string;
  flow: string;
  kind: 'fault' | 'viewport' | 'timing' | 'bad-input';
  // Null for the viewport and timing attacks.
  fault: FaultId | null;
  // Timing attacks: the timing id, the page when the POST was sent, the doubled
  // control's accessible name, and every write key the step sent.
  timing?: 'double-submit' | 'out-of-order' | 'refresh' | 'back' | 'signed-out-reload';
  // Page kinds: the entry's number among the run's page entries of that template, and the previous path.
  entry?: { k: number; previous: string | null };
  page?: string | null;
  controlName?: string;
  stepKind?: string;
  // out-of-order: the field's separate submit step, the older value, the baseline offset and the field key.
  outOfOrder?: { submitStep: number; older: string | null; select: boolean; offsetMs: number; fieldKey: string };
  writeKeys?: string[];
  // Bad inputs: the planned input, its field and form.
  badInput?: BadInputPlan;
  sticky: boolean;
  rank: number;
  // `METHOD template #n`, the template, the step and k (its place among same-template requests in that step).
  key: string;
  template: string;
  step: number;
  k: number;
  diffLinked: boolean;
  closeness: 1 | 2 | 3;
  // Body faults: the baseline response and the empty-200 rule's schema.
  baseline?: { status: number | null; mediaType: string | null };
}

export interface AttackOutcome extends PlannedAttack {
  verdict: 'passed' | 'failed' | 'void' | 'fault-never-fired' | 'not-applied' | 'pending' | 'inconclusive' | 'accepted-finding';
  checks: CheckResult[];
  page: string | null;
  // The judged step's locator as written, or its goto path.
  control: string;
  events: { offsetMs: number; event: string; detail?: string }[];
  voided: string | null;
  served: Served | null;
  notApplied: string | null;
  givenUp: boolean;
  run: FlowRunResult;
}

// Templates the baseline run repeated at a steady interval in one step: polling.
export function pollingKeys(run: FlowRunResult): Set<string> {
  const out = new Set<string>();
  const byKey = new Map<string, number[]>();
  for (const q of run.requests) {
    if (q.resourceType !== 'fetch' && q.resourceType !== 'xhr') continue;
    const k = `${q.step}|${q.key.replace(/ #\d+$/, '')}`;
    byKey.set(k, [...(byKey.get(k) ?? []), q.offsetMs]);
  }
  for (const [k, offsets] of byKey) {
    if (offsets.length < 3) continue;
    const gaps = offsets.slice(1).map((o, i) => o - offsets[i]!);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (mean > 0 && gaps.every((g) => Math.abs(g - mean) <= mean * 0.25)) out.add(k.split('|')[1]!);
  }
  return out;
}

export interface PointOptions {
  tier?: string;
  // The flow is the sign-in flow.
  signInFlow?: boolean;
  docs?: OpenApiDoc[];
}

// The reason a body fault can't apply to this request, or null (20.2, 20.13).
function bodyFaultSkip(q: RequestRecord, forwardable: (url: string) => boolean): string | null {
  if (q.method !== 'GET') return 'not a GET';
  if (q.oversize) return 'body over 5 MiB';
  if (q.streaming) return 'still streaming';
  if (q.status === null || q.status < 200 || q.status >= 300 || !isJsonMedia(q.mediaType)) return `response was ${q.status ?? 'none'} ${q.mediaType ?? 'none'}`;
  if (q.emptyBody) return 'empty body';
  if (!forwardable(q.url)) return 'the runner forwards only to loopback and allow.remoteTarget';
  return null;
}

export function bodyKindOf(q: RequestRecord, template: string, docs: OpenApiDoc[]): BodyKind | null {
  if (q.body === undefined) return null;
  const { schema, doc } = responseSchema(docs, q.method, template);
  return emptyForm(q.body, template, schema, doc)?.kind ?? null;
}

// Each own-origin fetch or XHR request of the baseline run is an attack point;
// the tier's fault kinds that apply to it become attacks (20.2, 20.12). Body
// faults forward only to forwardable hosts (resolution 4). Kinds that can't
// apply give `Skipped: <fault> on <request key> (<reason>)`.
export function attackPoints(
  flow: Flow,
  baseline: FlowRunResult,
  hosts: HostPolicy,
  changed: Set<string>,
  firstLoadOfChange: number | null,
  options: PointOptions = {},
): PlannedAttack[] & { skipped?: string[] } {
  const out: PlannedAttack[] & { skipped?: string[] } = [];
  const skipped: string[] = [];
  const kinds = kindsFor(options.tier ?? 'quick');
  const seenInStep = new Map<string, number>();
  for (const q of baseline.requests) {
    if (q.resourceType !== 'fetch' && q.resourceType !== 'xhr') continue;
    if (!hosts.ownHost(q.url) || isFrameworkInternal(q.url) || q.step === 0) continue;
    const template = q.key.replace(/ #\d+$/, '');
    const stepKey = `${q.step}|${template}`;
    const k = (seenInStep.get(stepKey) ?? 0) + 1;
    seenInStep.set(stepKey, k);
    const diffLinked = changed.has(template);
    const closeness: 1 | 2 | 3 = diffLinked ? 1 : firstLoadOfChange !== null && q.step >= firstLoadOfChange ? 2 : 3;
    const write = WRITES.has(q.method);
    const read = q.method === 'GET' || q.method === 'HEAD';
    q.bodyKind = bodyKindOf(q, template, options.docs ?? []);
    const skip = (fault: FaultId, reason: string) => {
      const line = `Skipped: ${fault} on ${q.key} (${reason})`;
      if (!skipped.includes(line)) skipped.push(line);
    };
    for (const kind of kinds) {
      if (options.signInFlow && !kind.signInFlow) {
        skip(kind.fault, 'sign-in flow');
        continue;
      }
      switch (kind.appliesTo) {
        case 'writes':
          if (!write) continue;
          break;
        case 'reads':
          if (!read) continue;
          break;
        case 'every':
          break;
        case 'json-gets':
        case 'empty-form-gets': {
          const why = bodyFaultSkip(q, hosts.forwardable);
          if (why) {
            skip(kind.fault, why);
            continue;
          }
          if (kind.appliesTo === 'empty-form-gets' && q.bodyKind === null) {
            skip(kind.fault, 'no empty form of the response');
            continue;
          }
          break;
        }
        case 'credentialed':
          if (!flow.signedIn || !q.credentialed) {
            skip(kind.fault, 'not credentialed');
            continue;
          }
          break;
      }
      out.push({
        id: attackId(flow.name, q.key, kind.fault, kind.sticky),
        flow: flow.name,
        kind: 'fault',
        fault: kind.fault,
        sticky: kind.sticky,
        rank: kind.rank,
        key: q.key,
        template,
        step: q.step,
        k,
        diffLinked,
        closeness,
        ...(kind.fault === 'malformed-json' || kind.fault === 'empty-200' ? { baseline: { status: q.status, mediaType: q.mediaType } } : {}),
      });
    }
  }
  out.skipped = skipped;
  return out;
}

const DOUBLE_SUBMIT_RANK = 3;
const TOGGLE_ROLES = new Set(['switch', 'checkbox', 'radio', 'tab', 'menuitemcheckbox', 'menuitemradio', 'option']);

// The path the main frame showed before the step: the page a request at that step was sent from.
function pageAt(run: FlowRunResult, step: number): string | null {
  for (let i = step - 1; i >= 1; i--) {
    const p = run.steps.find((s) => s.index === i)?.path;
    if (p) return p;
  }
  return null;
}

// double-submit attack points (32.3): click and press steps the baseline run
// attributed an own-origin fetch or XHR POST answered 2xx. Other writing steps
// give `Skipped: double-submit on <step locator> (<reason>)`.
export function doubleSubmitPoints(
  flow: Flow,
  baseline: FlowRunResult,
  ownHost: (url: string) => boolean,
  changed: Set<string>,
  firstLoadOfChange: number | null,
  signInFlow: boolean,
): PlannedAttack[] & { skipped?: string[] } {
  const out: PlannedAttack[] & { skipped?: string[] } = [];
  const skipped: string[] = [];
  for (const [i, step] of flow.steps.entries()) {
    const index = i + 1;
    const kind = stepKind(step);
    if (kind !== 'click' && kind !== 'press') continue;
    const locator = describeLocator((step as Record<string, LocatorSpec>)[kind]!);
    const at = baseline.requests.filter((q) => q.step === index && ownHost(q.url) && !isFrameworkInternal(q.url));
    const writes = at.filter((q) => (q.resourceType === 'fetch' || q.resourceType === 'xhr') && WRITES.has(q.method));
    const documentPost = at.some((q) => q.navigation && q.method === 'POST');
    if (writes.length === 0 && !documentPost) continue;
    const skip = (reason: string) => skipped.push(`Skipped: double-submit on ${locator} (${reason})`);
    if (signInFlow) {
      skip('sign-in flow');
      continue;
    }
    const control = baseline.steps.find((s) => s.index === index)?.control;
    if (control && (control.ariaPressed !== null || control.ariaChecked !== null || control.ariaExpanded !== null || TOGGLE_ROLES.has(control.role ?? ''))) {
      skip('toggle control');
      continue;
    }
    const post = writes.find((q) => q.method === 'POST' && q.status !== null && q.status >= 200 && q.status < 300);
    if (!post) {
      const methods = [...new Set(writes.filter((q) => q.method !== 'POST').map((q) => q.method))];
      if (methods.length > 0) skip(`sends ${methods.join(', ')}, not POST`);
      else if (documentPost && writes.length === 0) skip('document form post');
      continue;
    }
    const writeKeys = [...new Set(writes.map((q) => q.key.replace(/ #\d+$/, '')))];
    const template = post.key.replace(/ #\d+$/, '');
    const diffLinked = writeKeys.some((k) => changed.has(k));
    const spec = (step as Record<string, LocatorSpec>)[kind]!;
    out.push({
      id: `${flow.name}/${post.key}/double-submit`,
      flow: flow.name,
      kind: 'timing',
      fault: null,
      sticky: false,
      rank: DOUBLE_SUBMIT_RANK,
      key: post.key,
      template,
      step: index,
      k: 0,
      diffLinked,
      closeness: diffLinked ? 1 : firstLoadOfChange !== null && index >= firstLoadOfChange ? 2 : 3,
      timing: 'double-submit',
      page: pageAt(baseline, index),
      controlName: 'name' in spec && spec.name !== undefined ? spec.name : locator,
      stepKind: kind,
      writeKeys,
    });
  }
  out.skipped = skipped;
  return out;
}

// A planned bad input as an attack: band 1 ranks 2, band 2 ranks 8 (21.8).
export function badInputAttack(flow: string, plan: BadInputPlan, band: 1 | 2, firstLoad: number | null): PlannedAttack {
  return {
    id: `${flow}/${plan.field.name}/${plan.inputId}`,
    flow,
    kind: 'bad-input',
    fault: null,
    sticky: false,
    rank: band === 1 ? 2 : 8,
    key: plan.carrying ? `${plan.carrying} #1` : `control ${plan.formName}`,
    template: plan.carrying ?? '',
    step: plan.submitStep,
    k: 0,
    diffLinked: plan.diffLinked,
    closeness: plan.diffLinked ? 1 : firstLoad !== null && plan.fillStep >= firstLoad ? 2 : 3,
    page: plan.page,
    badInput: plan,
  };
}

// One attack per page template and first POST key (32.3's dedupe key); for
// out-of-order, the page route, the carrying template and the field key (32.4).
export function timingDedupeKey(a: PlannedAttack): string {
  return `${a.timing ?? ''}|${a.page ?? ''}|${a.template}${a.outOfOrder ? `|${a.outOfOrder.fieldKey}` : ''}`;
}

const OOO_RANK = 11;
const PAGE_RANKS = { refresh: 14, 'signed-out-reload': 15, back: 19 } as const;

// refresh, back and signed-out-reload attack points (32.5 to 32.7) from a
// flow's page entries; full-load wins when baseline runs disagree.
export function pageTimingPoints(flow: Flow, runs: FlowRunResult[], changed: Set<string>, firstLoadOfChange: number | null, signInFlow: boolean): PlannedAttack[] & { skipped?: string[] } {
  const out: PlannedAttack[] & { skipped?: string[] } = [];
  const skipped: string[] = [];
  out.skipped = skipped;
  const first = runs[0];
  if (signInFlow || !first) return out;
  const counts = new Map<string, number>();
  for (const entry of first.pages) {
    const k = (counts.get(entry.path) ?? 0) + 1;
    counts.set(entry.path, k);
    const fullLoad = runs.some((r) => r.pages.find((p) => p.step === entry.step)?.entry === 'full-load');
    // The document showing at this entry: the latest full load at or before it.
    const loads = first.pages.filter((p) => p.step <= entry.step && p.entry === 'full-load');
    const fromPost = (loads.at(-1)?.method ?? 'GET') !== 'GET';
    const kinds: ('refresh' | 'back' | 'signed-out-reload')[] = [];
    if (!fullLoad) kinds.push('refresh');
    if (flow.signedIn) kinds.push('signed-out-reload');
    if (!fullLoad && entry.previous !== null && entry.previous !== entry.path) kinds.push('back');
    const diffLinked = entry.requests.some((key) => changed.has(key)) || (firstLoadOfChange !== null && firstLoadOfChange === entry.step);
    for (const kind of kinds) {
      const id = `${flow.name}/page ${entry.path} #${k}/${kind}`;
      if (fromPost) {
        skipped.push(`Skipped: ${kind} on page ${entry.path} #${k} (the page came from a form post)`);
        continue;
      }
      out.push({
        id,
        flow: flow.name,
        kind: 'timing',
        fault: null,
        sticky: false,
        rank: PAGE_RANKS[kind],
        key: `page ${entry.path} #${k}`,
        template: `${kind} page ${entry.path}`,
        step: entry.step,
        k,
        diffLinked,
        closeness: diffLinked ? 1 : firstLoadOfChange !== null && entry.step >= firstLoadOfChange ? 2 : 3,
        timing: kind,
        page: entry.path,
        controlName: controlOf(flow, entry.step),
        stepKind: stepKind(flow.steps[entry.step - 1]!),
        entry: { k, previous: entry.previous },
      });
    }
  }
  return out;
}

// out-of-order attack points (32.4): a text, search or textarea fill, or a
// single select, whose carrying request was an own-origin fetch or XHR GET
// answered 2xx and whose submit step is its own step or the very next click or press.
export function outOfOrderPoints(flow: Flow, baseline: FlowRunResult, forms: Form[], ownHost: (url: string) => boolean, changed: Set<string>, firstLoadOfChange: number | null, signInFlow: boolean): PlannedAttack[] {
  if (signInFlow) return [];
  const out: PlannedAttack[] = [];
  for (const form of forms) {
    if (!form.carrying || !form.carrying.startsWith('GET ')) continue;
    const q = baseline.requests.find((r) => r.step === form.submitStep && r.key.replace(/ #\d+$/, '') === form.carrying && (r.resourceType === 'fetch' || r.resourceType === 'xhr') && ownHost(r.url));
    if (!q || q.status === null || q.status < 200 || q.status >= 300) continue;
    for (const index of form.steps) {
      const step = flow.steps[index - 1]!;
      const kind = stepKind(step);
      if (kind !== 'fill' && kind !== 'select') continue;
      const separate = form.submitStep === index + 1 && ['click', 'press'].includes(stepKind(flow.steps[form.submitStep - 1]!));
      if (form.submitStep !== index && !separate) continue;
      const raw = (step as { value?: string }).value ?? '';
      const record = baseline.steps.find((x) => x.index === index);
      const facts = record?.field;
      if (!facts || raw.includes('${env.') || facts.type === 'password' || facts.autocomplete === 'current-password' || facts.multiple) continue;
      const evidence = requestKey(q, record?.value ?? '');
      if (!evidence) continue;
      const fk = fieldKind(facts, { jsonNumber: evidence.jsonNumber }, null, record?.value ?? '');
      if (!['text', 'search', 'textarea', 'select'].includes(fk)) continue;
      let older: string | null = null;
      if (fk === 'select') {
        const enabled = (facts.options ?? []).filter((o) => !o.disabled);
        const chosen = (facts.options ?? []).filter((o) => o.selected).map((o) => o.value);
        const last = enabled.at(-1);
        older = last && !chosen.includes(last.value) ? last.value : enabled.find((o) => o.value !== '' && !chosen.includes(o.value))?.value ?? null;
        if (older === null) continue;
      }
      const locator = describeLocator((step as Record<string, LocatorSpec>)[kind]!);
      const page = pageAt(baseline, index);
      const diffLinked = changed.has(form.carrying);
      out.push({
        id: `${flow.name}/${locator}/out-of-order`,
        flow: flow.name,
        kind: 'timing',
        fault: null,
        sticky: false,
        rank: OOO_RANK,
        key: q.key,
        template: form.carrying,
        step: index,
        k: 0,
        diffLinked,
        closeness: diffLinked ? 1 : firstLoadOfChange !== null && index >= firstLoadOfChange ? 2 : 3,
        timing: 'out-of-order',
        page,
        controlName: locator,
        stepKind: kind,
        outOfOrder: { submitStep: form.submitStep, older, select: fk === 'select', offsetMs: q.offsetMs, fieldKey: evidence.key },
      });
    }
  }
  return out;
}

// The viewport attack: once per reached flow except the sign-in flow (22.3).
// Closeness 2 when the flow reaches a changed file through the module or page
// rule (or an accepted page link), 3 otherwise (17.7).
export function viewportAttack(flow: Flow, reachesByRule: boolean): PlannedAttack {
  return {
    id: `${flow.name}/viewport-375`,
    flow: flow.name,
    kind: 'viewport',
    fault: null,
    sticky: false,
    rank: VIEWPORT_RANK,
    key: 'viewport 375',
    template: '',
    step: 1,
    k: 0,
    diffLinked: false,
    closeness: reachesByRule ? 2 : 3,
  };
}

// Inside one flow: closeness, kind rank, step index, attack id by code point.
export function orderAttacks(list: PlannedAttack[]): PlannedAttack[] {
  return [...list].sort((a, b) =>
    a.closeness - b.closeness || a.rank - b.rank || a.step - b.step || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function controlOf(flow: Flow, step: number): string {
  const s = flow.steps[step - 1];
  if (!s) return `step ${step}`;
  const kind = stepKind(s);
  if (kind === 'goto') return `goto ${(s as { goto: string }).goto}`;
  return describeLocator((s as Record<string, LocatorSpec>)[kind]!);
}

// One attack run, judged by the generic checks and by the app-specific checks
// whose when it matches (45.7); a failed app check makes the attack fail.
export async function runAttack(
  attack: PlannedAttack,
  flow: Flow,
  baseline: FlowRunResult,
  base: Omit<RunFlowOptions, 'flow' | 'kind' | 'templateOf' | 'pollingKeys'>,
  docs: OpenApiDoc[],
  appChecks: AppCheck[] = [],
): Promise<AttackOutcome> {
  const matching = appChecks.filter((c) => matchesWhen(c, attack, flow));
  if (matching.length === 0) return runJudged(attack, flow, baseline, base, docs);
  const probe = probeFor(matching);
  const o = await runJudged(attack, flow, baseline, { ...base, onPoint: probe.onPoint }, docs);
  const results = judgeAppChecks(matching, attack, flow, o.run, probe.probes, o.verdict, (base.hosts ?? LOOPBACK_ONLY).ownHost);
  return { ...o, checks: [...o.checks, ...results], verdict: o.verdict === 'passed' && results.some((r) => r.result === 'fail') ? 'failed' : o.verdict };
}

async function runJudged(
  attack: PlannedAttack,
  flow: Flow,
  baseline: FlowRunResult,
  base: Omit<RunFlowOptions, 'flow' | 'kind' | 'templateOf' | 'pollingKeys'>,
  docs: OpenApiDoc[],
): Promise<AttackOutcome> {
  const templateOf = (method: string, url: string) => {
    const keyed = matchTemplate(docs, url, method);
    return keyed ? `${method} ${keyed.template}` : null;
  };
  const skipped = new Set<string>(baselineFailures(baseline).map((f) => f.id));
  return kindFor(attack).run(attack, { flow, baseline, options: { ...base, flow, templateOf, pollingKeys: pollingKeys(baseline) }, docs, skipped, control: (step) => controlOf(flow, step) });
}

// Section 37's symptom templates, by lead check.
export function symptom(o: AttackOutcome): string {
  const lead = leadCheck(o.checks);
  const press = o.stepKind === 'press';
  const bad = o.badInput;
  if (bad && lead?.id === 'no-5xx-on-bad-input') {
    const c = o.run.badInput?.carrying;
    return `${o.template || 'The submit'} answers ${c?.status ?? 'no response'} to bad input ${bad.inputId} in ${bad.field.name}`;
  }
  if (bad && lead?.id === 'visible-error-message' && o.run.badInput?.outcome === 'silent-refusal') {
    return `${o.control} does nothing and shows no message for bad input ${bad.inputId} in ${bad.field.name}`;
  }
  const what = bad ? `bad input ${bad.inputId} in ${bad.field.name}`
    : o.timing === 'out-of-order' ? `an older answer arrived after a newer one on ${o.controlName ?? o.control}`
    : o.timing === 'refresh' ? `a reload of ${o.page}`
    : o.timing === 'back' ? `back then forward to ${o.page}`
    : o.timing === 'signed-out-reload' ? `a signed-out reload of ${o.page}`
    : o.kind === 'timing' ? `a double ${press ? 'press' : 'click'} on ${o.control}`
    : o.fault === null ? 'the 375px viewport' : `${o.template} ${FAULT_PHRASE[o.fault]}`;
  if (lead?.id.startsWith('app-')) return `App check ${lead.id} fails on ${o.page ?? 'the page'} after ${what}`;
  switch (lead?.id) {
    case 'one-write': {
      const n = /one-write: (\d+) successful/.exec(lead.evidence)?.[1] ?? '2';
      const hint = lead.evidence.endsWith(TOGGLE_HINT) ? ` ${TOGGLE_HINT}` : '';
      return `${o.control} sends ${n} successful ${o.template} on a double ${press ? 'press' : 'click'}${hint}`;
    }
    case 'no-overflow-375':
      return `${o.page ?? 'the page'} scrolls sideways at 375px`;
    case 'visible-error-message':
      return `No message when ${what} (${o.control})`;
    case 'settles':
      return `${o.control} stays busy after ${what}`;
    case 'values-survive':
      return `Typed values lost after ${what} (${o.control})`;
    case 'retry-recovers':
      return `No way to retry without a reload after ${what}`;
    case 'latest-response-wins':
      return `Stale answer shown as current when ${what}`;
    case 'no-broken-text':
      return `"${lead.token ?? 'undefined'}" shown on ${o.page ?? 'the page'} after ${what}`;
    default:
      return `Uncaught error on ${o.page ?? 'the page'} after ${what}`;
  }
}

export function severityOf(o: AttackOutcome): 'high' | 'medium' | 'low' {
  const lead = leadCheck(o.checks);
  return lead ? checkSeverity(lead.id) : 'low';
}

const SEV_TEXT = { high: 'HIGH', medium: 'MED ', low: 'LOW ' };

// Two summary lines per failing attack, until ticket 26 groups them.
export function findingLines(o: AttackOutcome): string[] {
  const fails = o.checks.filter((c) => c.result === 'fail').map((c) => c.id);
  return [
    `${SEV_TEXT[severityOf(o)]}  ${symptom(o)}`,
    `      ${o.page ?? '-'} | ${o.kind === 'timing' ? `double-submit on ${o.key}` : o.fault === null ? 'viewport 375' : `${o.fault}${o.sticky ? '!' : ''} on ${o.key}`} | fails: ${fails.join(', ')}`,
  ];
}

// Section 37's two lines per shown group: the symptom with the member count and
// repro id (the toggle hint last), then page, members, checks and any foreign-record mark.
export function groupLines(g: Group, repro: string): string[] {
  const rep = g.representative.outcome;
  const sym = symptom(rep);
  const hint = sym.endsWith(TOGGLE_HINT) ? ` ${TOGGLE_HINT}` : '';
  const text = hint ? sym.slice(0, -hint.length) : sym;
  const n = g.members.length;
  const foreign = g.members.flatMap((m) => m.foreign)[0];
  const members = membersText(g.members.map((m) => ({ kind: m.outcome.kind, fault: m.outcome.fault, sticky: m.outcome.sticky, key: m.outcome.key, id: m.outcome.id, ...(m.outcome.badInput ? { field: m.outcome.badInput.field.name } : {}) })));
  const fails = (g.fails.length > 0 ? g.fails : g.representative.failed).map((c) => checkLabel(c, rep.checks));
  return [
    `${SEVERITY_TEXT[g.severity]}  ${text}${n > 1 ? ` | ${n} attacks` : ''} | repro ${repro}${hint}`,
    `      ${g.key.page} | ${members} | fails: ${fails.join(', ')}${foreign ? ` | page showed a record from ${foreign.attack}` : ''}`,
  ];
}

export function attackLink(o: Pick<AttackOutcome, 'flow' | 'verdict' | 'kind' | 'step' | 'page' | 'template' | 'writeKeys'>, loaded: string[]): AttackLink {
  const verdict = o.verdict;
  if (o.kind === 'viewport') return { flow: o.flow, verdict, kind: 'viewport', step: o.step, page: o.page, endpoints: [], loaded };
  if (o.kind === 'bad-input') return { flow: o.flow, verdict, kind: 'bad-input', step: o.step, page: o.page, endpoints: o.template ? [o.template] : [], loaded };
  if (o.kind === 'timing') return { flow: o.flow, verdict, kind: 'timing', step: o.step, page: o.page, endpoints: o.writeKeys ?? [o.template], loaded };
  return { flow: o.flow, verdict, kind: 'fault', step: o.step, page: o.page, endpoints: [o.template], loaded };
}

// Lines that are never findings (20.15), typed by kind for the run record.
export function nonFinding(o: AttackOutcome, holdMs: number): { kind: string; text: string; refs: string[] } | null {
  if (o.kind === 'timing' && o.verdict === 'not-applied') return { kind: 'not-applied', text: `Not applied: ${o.id} (${o.notApplied ?? 'unknown'})`, refs: [o.id] };
  if (o.kind === 'bad-input') {
    const r = o.run.badInput;
    if (o.verdict === 'not-applied') return { kind: 'not-applied', text: `Not applied: ${o.id} (${o.notApplied ?? 'unknown'})`, refs: [o.id] };
    if (o.verdict === 'inconclusive') return { kind: 'inconclusive', text: `Inconclusive: ${o.id} (${r?.carrying?.status ?? '?'} on ${r?.carrying?.method ?? ''} ${r?.carrying?.path ?? ''})`, refs: [o.id] };
    if (o.run.stoppedAt !== null) return { kind: 'accepted-flow-stopped', text: `Accepted; flow stopped at step ${o.run.stoppedAt}: ${o.id}`, refs: [o.id] };
  }
  // In out-of-order a later failing step fails latest-response-wins through (c), so no line here.
  if (o.run.stoppedAt !== null && o.timing !== 'out-of-order') return { kind: 'faulted-flow-stopped', text: `Faulted; flow stopped at step ${o.run.stoppedAt}: ${o.id}`, refs: [o.id] };
  if (o.run.fault?.pending) return { kind: 'pending', text: `Pending: ${o.id} (no response for ${holdMs / 1000} s and the page did not give up)`, refs: [o.id] };
  switch (o.verdict) {
    case 'not-applied':
      return { kind: 'not-applied', text: `Not applied: ${o.id} (${o.notApplied ?? 'unknown'})`, refs: [o.id] };
    case 'pending':
      return { kind: 'pending', text: `Pending: ${o.id} (no response for ${holdMs / 1000} s and the page did not give up)`, refs: [o.id] };
    case 'fault-never-fired':
      return { kind: 'fault-never-fired', text: `${o.id}: fault never fired`, refs: [o.id] };
    case 'void':
      return { kind: 'void', text: `${o.id}: void (${o.voided ?? 'void'})`, refs: [o.id] };
    default:
      return null;
  }
}
