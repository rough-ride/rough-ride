// Finding groups, ranking and confirmation (spec part 9 sections 34 and 35).
// Grouping and ranking are a pure function of the attack outcomes: every
// comparison is by code point, with no clock, locale or completion order.

import type { AttackOutcome } from './attacks.mjs';
import { checkRank, checkSeverity, type CheckResult } from './checks.mjs';
import { stepKind, type Flow, type RequestRecord } from './flowrun.mjs';
import { kindFor } from './kinds.mjs';
import type { FlowClass } from './forms.mjs';

export type Severity = 'high' | 'medium' | 'low';
export const SEVERITY_TEXT: Record<Severity, string> = { high: 'HIGH', medium: 'MED ', low: 'LOW ' };
const SEVERITY_ORDER: Severity[] = ['high', 'medium', 'low'];
const CLASS_ORDER: FlowClass[] = ['form', 'write', 'read', 'module', 'app-wide'];
const KIND_ORDER = ['fault', 'timing', 'bad-input', 'viewport'];
const FAULT_ORDER = ['500', '400', '429', 'reset', '401', 'hang', 'delay-3s', 'malformed-json', 'empty-200'];

export const CONFIRMATION_RUNS: Record<string, number> = { quick: 5, standard: 8 };
export const SHOWN_CAP = 5;

export interface GroupKey {
  page: string;
  step: string;
  action: string;
}

export interface Member {
  outcome: AttackOutcome;
  key: GroupKey;
  lead: string;
  failed: string[];
  foreign: { token: string; attack: string }[];
}

export type GroupState = 'shown' | 'not-confirmed' | 'capped' | 'unchecked' | 'under-test';

export interface Group {
  key: GroupKey;
  lead: string;
  severity: Severity;
  members: Member[];
  representative: Member;
  state: GroupState | null;
  // A confirmed group's printed checks: failed in the attack and in the confirmation run.
  fails: string[];
  confirmation: { verdict: string; failed: string[]; unique: string } | null;
}

export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const rankOf = checkRank;
const severityOfCheck = checkSeverity;

function failedChecks(checks: CheckResult[]): string[] {
  return checks.filter((c) => c.result === 'fail').map((c) => c.id).sort((a, b) => rankOf(a) - rankOf(b) || cmp(a, b));
}

// The attack point's request in the attack run: the k-th request with its template in its step.
function attackRequest(o: AttackOutcome): RequestRecord | null {
  const same = o.run.requests.filter((q) => q.step === o.step && q.key.replace(/ #\d+$/, '') === o.template);
  return same[Math.max(0, o.k - 1)] ?? same[0] ?? null;
}

// ` (entry)`, ` (next-action ...)` and ` (operation ...)` suffixes of section 34.
function actionSuffixes(o: AttackOutcome, q: RequestRecord | null, entry: boolean): string {
  let out = '';
  if (entry && q && o.run.pages.some((p) => p.step === o.step && p.requests.includes(o.template))) out += ' (entry)';
  if (q?.nextAction) out += ` (next-action ${q.nextAction.slice(0, 8)})`;
  if (q?.postData) {
    try {
      const body = JSON.parse(q.postData) as { operationName?: unknown };
      if (typeof body.operationName === 'string' && /^[_A-Za-z][_0-9A-Za-z]*$/.test(body.operationName)) out += ` (operation ${body.operationName.slice(0, 40)})`;
    } catch {
      // Not JSON.
    }
  }
  return out;
}

// Section 34's key fields: the judged step's page, kind and action; the page
// and action come from the attack's kind.
export function keyOf(o: AttackOutcome, flow: Flow): GroupKey {
  const s = flow.steps[o.step - 1];
  const step = s ? stepKind(s) : 'goto';
  const request = attackRequest(o);
  const { page, action } = kindFor(o).groupKey(o, { request, suffixes: (entry) => actionSuffixes(o, request, entry) });
  return { page, step, action };
}

// Another flow run's ${unique} token in a failed check's evidence or in new text on the judged page.
export function foreignRecords(o: AttackOutcome, tokens: Map<string, string>): { token: string; attack: string }[] {
  const step = o.run.steps.find((s) => s.index === o.step);
  const before = new Set(step?.observation?.before.lines ?? []);
  const fresh = (step?.observation?.after.lines ?? []).filter((l) => !before.has(l));
  const texts = [...o.checks.filter((c) => c.result === 'fail').map((c) => c.evidence), ...fresh];
  const out: { token: string; attack: string }[] = [];
  for (const [token, attack] of [...tokens].sort((a, b) => cmp(a[0], b[0]))) {
    if (token === o.run.unique || attack === o.id) continue;
    if (texts.some((t) => t.includes(token)) && !out.some((f) => f.token === token)) out.push({ token, attack });
  }
  return out;
}

export function memberOf(o: AttackOutcome, flow: Flow, tokens: Map<string, string>): Member | null {
  const failed = failedChecks(o.checks);
  if (failed.length === 0) return null;
  return { outcome: o, key: keyOf(o, flow), lead: failed[0]!, failed, foreign: foreignRecords(o, tokens) };
}

function faultOrder(o: AttackOutcome): number {
  const i = o.fault ? FAULT_ORDER.indexOf(o.fault) : FAULT_ORDER.length;
  return i * 2 + (o.sticky ? 0 : 1);
}

// The members that failed the lead check: most failed checks, kind, fault order, id.
function representative(members: Member[], lead: string): Member {
  return [...members].filter((m) => m.failed.includes(lead)).sort((a, b) =>
    b.failed.length - a.failed.length ||
    KIND_ORDER.indexOf(a.outcome.kind) - KIND_ORDER.indexOf(b.outcome.kind) ||
    faultOrder(a.outcome) - faultOrder(b.outcome) ||
    cmp(a.outcome.id, b.outcome.id))[0]!;
}

function makeGroup(members: Member[]): Group {
  const lead = [...new Set(members.map((m) => m.lead))].sort((a, b) => rankOf(a) - rankOf(b) || cmp(a, b))[0]!;
  return { key: members[0]!.key, lead, severity: severityOfCheck(lead), members, representative: representative(members, lead), state: null, fails: [], confirmation: null };
}

export interface RankContext {
  // The flow class of each reached flow (section 17.6).
  flowClass: (flow: string) => FlowClass | null;
}

function closeness(g: Group, ctx: RankContext): number {
  if (g.members.some((m) => m.outcome.diffLinked)) return 0;
  const best = Math.min(...g.members.map((m) => {
    const c = ctx.flowClass(m.outcome.flow);
    return c === null ? CLASS_ORDER.length : CLASS_ORDER.indexOf(c);
  }));
  return 1 + best;
}

// Section 34's six ranking keys.
export function rankGroups(groups: Group[], ctx: RankContext): Group[] {
  const allForeign = (g: Group) => g.members.every((m) => m.foreign.length > 0);
  return [...groups].sort((a, b) =>
    SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
    Number(allForeign(a)) - Number(allForeign(b)) ||
    closeness(a, ctx) - closeness(b, ctx) ||
    rankOf(a.lead) - rankOf(b.lead) ||
    b.members.length - a.members.length ||
    cmp(a.representative.outcome.id, b.representative.outcome.id));
}

const sameKey = (a: GroupKey, b: GroupKey) => a.page === b.page && a.step === b.step && a.action === b.action;

// Pass 1 by (page, step, action, lead), ranked once; pass 2 folds a later group
// into an earlier one with the same key when its failed checks are a subset.
export function groupFindings(members: Member[], ctx: RankContext): Group[] {
  const pass1 = new Map<string, Member[]>();
  for (const m of members) {
    const k = [m.key.page, m.key.step, m.key.action, m.lead].join('\u0000');
    pass1.set(k, [...(pass1.get(k) ?? []), m]);
  }
  const ranked = rankGroups([...pass1.values()].map(makeGroup), ctx);
  const kept: Group[] = [];
  for (const g of ranked) {
    const failed = new Set(g.members.flatMap((m) => m.failed));
    const into = kept.find((e) => sameKey(e.key, g.key) && [...failed].every((c) => e.members.some((m) => m.failed.includes(c))));
    if (into) into.members.push(...g.members);
    else kept.push({ ...g, members: [...g.members] });
  }
  return rankGroups(kept.map((g) => makeGroup(g.members)), ctx);
}

// Confirms representatives alone, down the ranked list (section 35). Sign-in
// flow groups are tried last. `runOne` re-runs one attack on a fresh flow run.
export async function confirmGroups(
  groups: Group[],
  tier: string,
  runOne: (o: AttackOutcome) => Promise<AttackOutcome>,
  // The closing deadline: a confirmation run starts only while this holds (50.3).
  canStart: (o: AttackOutcome) => boolean = () => true,
): Promise<{ runs: number }> {
  const limit = CONFIRMATION_RUNS[tier] ?? CONFIRMATION_RUNS.quick!;
  let runs = 0;
  let shown = 0;
  const order = [...groups.filter((g) => g.representative.outcome.flow !== 'sign-in'), ...groups.filter((g) => g.representative.outcome.flow === 'sign-in')];
  for (const g of order) {
    if (g.state !== null) continue;
    if (shown >= SHOWN_CAP) {
      g.state = 'capped';
      continue;
    }
    if (runs >= limit || !canStart(g.representative.outcome)) {
      g.state = 'unchecked';
      continue;
    }
    runs++;
    const again = await runOne(g.representative.outcome);
    const failedAgain = failedChecks(again.checks);
    g.confirmation = { verdict: again.verdict, failed: failedAgain, unique: again.run.unique };
    if (failedAgain.includes(g.lead)) {
      g.state = 'shown';
      g.fails = g.representative.failed.filter((c) => failedAgain.includes(c));
      shown++;
    } else g.state = 'not-confirmed';
  }
  return { runs };
}
