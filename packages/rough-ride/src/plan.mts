// The attack plan (spec part 11 section 45): parsed and validated so that it
// can only add. A refused plan or a rejected entry never cancels, reorders or
// replaces a selected attack.

import { parseDocument } from 'yaml';
import { validateChecks, type AppCheck, type CheckEntry, type CheckFacts } from './appchecks.mjs';
import type { PlannedAttack } from './attacks.mjs';
import { compareVersions, FORMATS } from './formats.mjs';
import type { TierName } from './tiers.mjs';
import { TIER_TABLE } from './tiers.mjs';

export const MAX_PLAN = 24 * 1024;
const TOP = ['attacks', 'checks', 'noFlow'];
const ONE_SHOT = ['500', '400', '429', 'reset', 'malformed-json', 'empty-200'];
const FAULTS = ['500', '400', '401', '429', 'malformed-json', 'empty-200', 'reset', 'hang', 'delay-3s'];
const FREE_TEXT = /^[\x20-\x7e]{1,160}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;

export interface PlanInput {
  attacks?: unknown[];
  checks?: unknown[];
  noFlow?: unknown[];
}

export interface ParsedPlan {
  // `Plan refused: ...` or `Refused: plan.json ...`; the plan then adds nothing.
  refused: string | null;
  input: PlanInput | null;
  // A whole plan.json passed back for replay (45.10).
  replay: { tier: string | null; links: unknown[] } | null;
  warnings: string[];
}

// 45.1 and 45.2 rule 1: the checks that refuse the whole plan.
export function parsePlan(text: string, tier: TierName): ParsedPlan {
  const refuse = (why: string): ParsedPlan => ({ refused: why.startsWith('Refused:') ? why : `Plan refused: ${why}`, input: null, replay: null, warnings: [] });
  if (Buffer.byteLength(text) > MAX_PLAN) return refuse('over 24 KB');
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    if (/[^\t\r\x20-\x7e]/.test(line)) return refuse(`line ${i + 1}: non-ASCII byte (write it as \\uXXXX inside double quotes)`);
  }
  if (text.trim() === '') return { refused: null, input: {}, replay: null, warnings: [] };
  const doc = parseDocument(text, { uniqueKeys: true, version: '1.2' });
  if (doc.errors.length > 0) return refuse(`not valid YAML (${doc.errors[0]!.message.split('\n')[0]})`);
  const root = doc.toJSON() as unknown;
  if (!root || typeof root !== 'object' || Array.isArray(root)) return refuse('the plan is not a mapping');
  const value = root as Record<string, unknown>;
  // A whole plan.json: replayed within the plan kind's range (45.10).
  if ('schema' in value && 'input' in value) {
    const schema = String(value.schema);
    const { current, floor } = FORMATS.plan;
    if (compareVersions(schema, floor) < 0) return refuse(`Refused: plan.json schema ${schema} is older than this runner reads (${floor}).`);
    if (compareVersions(schema, current) > 0) return refuse(`plan.json schema ${schema} is newer than this runner reads (${current}); update rough-ride to replay it`);
    const inner = value.input;
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return refuse('plan.json input is not a mapping');
    const warnings = typeof value.tier === 'string' && value.tier !== tier ? [`Plan warning: plan.json was made for ${value.tier}; this run is ${tier}.`] : [];
    const links = (value.links as { input?: unknown[] } | undefined)?.input ?? [];
    const nested = checkTop(inner as Record<string, unknown>);
    if (nested) return refuse(nested);
    return { refused: null, input: inner as PlanInput, replay: { tier: typeof value.tier === 'string' ? value.tier : null, links }, warnings };
  }
  if ('schema' in value) return refuse('leave schema out; the runner stamps plan.json');
  const top = checkTop(value);
  if (top) return refuse(top);
  return { refused: null, input: value as PlanInput, replay: null, warnings: [] };
}

function checkTop(value: Record<string, unknown>): string | null {
  for (const key of Object.keys(value)) if (!TOP.includes(key)) return `unknown key ${key}`;
  for (const key of TOP) if (value[key] !== undefined && !Array.isArray(value[key])) return `${key} is not a list`;
  return null;
}

export interface Candidates {
  tier: TierName;
  // Flows above the cut, including flows saved in this run.
  aboveFlows: Set<string>;
  allFlows: Set<string>;
  // Ids of the selected attacks the invocation runs.
  selected: Set<string>;
  // The planned attack, or why the entry is rejected.
  fault(flow: string, request: string, fault: string, oneShot: boolean): PlannedAttack | string;
  // The form's runnable inputs not already run by a selected attack, in round-robin order, or why none.
  badInputs(flow: string, form: unknown): PlannedAttack[] | string;
  viewport(flow: string): PlannedAttack | string;
  // What app-specific checks are validated against; left out, every check reads no spec.
  checks?: CheckFacts;
}

export interface PlanEntry {
  path: string;
  status: 'kept' | 'rejected' | 'already-selected';
  attackIds: string[];
  why?: string;
}

export interface PlanResult {
  kept: PlannedAttack[];
  entries: PlanEntry[];
  lines: string[];
  noFlow: { file: string; page?: string; why: string }[];
  // App-specific checks: each entry's status, and the checks kept (45.6 to 45.8).
  checks: CheckEntry[];
  appChecks: AppCheck[];
}

export function planCap(tier: TierName): number {
  return tier === 'standard' ? 20 : 8;
}

// 45.2 rules 2 to 5, 45.4 and 45.5: each entry on its own, then the cap.
export function validatePlan(input: PlanInput, c: Candidates): PlanResult {
  const cap = planCap(c.tier);
  const kept: PlannedAttack[] = [];
  const entries: PlanEntry[] = [];
  const lines: string[] = [];
  const reject = (path: string, why: string) => {
    entries.push({ path, status: 'rejected', attackIds: [], why });
    lines.push(`Rejected plan entry: ${path} (${why})`);
  };
  for (const [i, raw] of (input.attacks ?? []).entries()) {
    const path = `attacks[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      reject(path, 'an entry is a mapping');
      continue;
    }
    const e = raw as Record<string, unknown>;
    if ('timing' in e) {
      reject(path, 'timing attacks are selected by the runner, never planned');
      continue;
    }
    const kinds = ['fault', 'badInputs', 'viewport'].filter((k) => k in e);
    const allowed = ['flow', 'because', ...(kinds[0] === 'fault' ? ['fault', 'request', 'oneShot'] : kinds[0] === 'badInputs' ? ['badInputs', 'form'] : ['viewport'])];
    const unknown = Object.keys(e).find((k) => !allowed.includes(k));
    if (kinds.length !== 1) {
      reject(path, 'an entry has exactly one of fault, badInputs or viewport');
      continue;
    }
    if (unknown) {
      reject(path, `unknown field ${unknown}`);
      continue;
    }
    if (typeof e.flow !== 'string' || !NAME.test(e.flow)) {
      reject(path, 'flow is not a flow name');
      continue;
    }
    if (typeof e.because !== 'string' || !FREE_TEXT.test(e.because)) {
      reject(path, 'because is one ASCII line of 1 to 160 characters');
      continue;
    }
    if (!c.allFlows.has(e.flow)) {
      reject(path, `no flow ${e.flow} in this run`);
      continue;
    }
    if (!c.aboveFlows.has(e.flow)) {
      reject(path, `flow ${e.flow} is below the ${c.tier} cut`);
      continue;
    }
    let attacks: PlannedAttack[] = [];
    if (kinds[0] === 'fault') {
      const fault = String(e.fault);
      if (!FAULTS.includes(fault)) {
        reject(path, `unknown fault ${fault}`);
        continue;
      }
      if (typeof e.request !== 'string' || !/^[A-Z]+ \/.* #[0-9]+$/.test(e.request)) {
        reject(path, 'request is "METHOD template #n"');
        continue;
      }
      if (e.oneShot !== undefined && e.oneShot !== true) {
        reject(path, 'oneShot is true or left out');
        continue;
      }
      if (e.oneShot === true && !ONE_SHOT.includes(fault)) {
        reject(path, `oneShot is only for ${ONE_SHOT.slice(0, -1).join(', ')} and ${ONE_SHOT.at(-1)}`);
        continue;
      }
      const a = c.fault(e.flow, e.request, fault, e.oneShot === true);
      if (typeof a === 'string') {
        reject(path, a);
        continue;
      }
      attacks = [a];
    } else if (kinds[0] === 'badInputs') {
      if (!Number.isInteger(e.badInputs) || (e.badInputs as number) < 1 || (e.badInputs as number) > 12) {
        reject(path, 'badInputs is 1 to 12');
        continue;
      }
      if (e.flow === 'sign-in') {
        reject(path, 'bad inputs are never planned on the sign-in flow');
        continue;
      }
      const found = c.badInputs(e.flow, e.form);
      if (typeof found === 'string') {
        reject(path, found);
        continue;
      }
      attacks = found.filter((a) => !kept.some((k) => k.id === a.id)).slice(0, e.badInputs as number);
      if (attacks.length === 0) {
        entries.push({ path, status: 'already-selected', attackIds: [], why: 'already selected' });
        lines.push(`Rejected plan entry: ${path} (already selected)`);
        continue;
      }
    } else {
      if (e.viewport !== 375) {
        reject(path, 'viewport is 375');
        continue;
      }
      const a = c.viewport(e.flow);
      if (typeof a === 'string') {
        reject(path, a);
        continue;
      }
      attacks = [a];
    }
    if (attacks.length === 1 && (c.selected.has(attacks[0]!.id) || kept.some((k) => k.id === attacks[0]!.id))) {
      entries.push({ path, status: 'already-selected', attackIds: [attacks[0]!.id], why: 'already selected' });
      lines.push(`Rejected plan entry: ${path} (already selected)`);
      continue;
    }
    const room = cap - kept.length;
    if (room <= 0 || attacks.length > room) {
      const keep = attacks.slice(0, Math.max(0, room));
      kept.push(...keep);
      const why = kinds[0] === 'badInputs'
        ? `over the plan cap of ${cap}; ${keep.length} of ${e.badInputs} bad inputs kept`
        : `over the plan cap of ${cap}`;
      entries.push({ path, status: keep.length > 0 ? 'kept' : 'rejected', attackIds: keep.map((a) => a.id), why });
      lines.push(`Rejected plan entry: ${path} (${why})`);
      continue;
    }
    kept.push(...attacks);
    entries.push({ path, status: 'kept', attackIds: attacks.map((a) => a.id) });
  }
  const noFlow: PlanResult['noFlow'] = [];
  for (const [i, raw] of (input.noFlow ?? []).entries()) {
    const n = raw as Record<string, unknown> | null;
    if (!n || typeof n.file !== 'string' || typeof n.why !== 'string' || !FREE_TEXT.test(n.why) || (n.page !== undefined && (typeof n.page !== 'string' || !n.page.startsWith('/')))) {
      reject(`noFlow[${i}]`, 'a noFlow entry is {file, page?, why}, why one ASCII line of 1 to 160 characters');
      continue;
    }
    noFlow.push({ file: n.file, ...(typeof n.page === 'string' ? { page: n.page } : {}), why: n.why });
    lines.push(`adversary: no flow (${JSON.stringify(n.why)})`);
  }
  const checks = validateChecks(input.checks ?? [], c.checks ?? { specs: new Map(), flows: c.allFlows, footprint: () => null, apiKeys: [] });
  lines.push(...checks.lines);
  return { kept, entries, lines, noFlow, checks: checks.entries, appChecks: checks.kept };
}

// 45.5: planned attacks go after every selected attack outside the sign-in
// segment, and after the segment's selected attacks; the first planned attack
// that makes anything finish past the window is cut, and every one after it.
export function cutPlanned(selected: { flow: string; nominalMs: number }[], planned: { flow: string; nominalMs: number }[], windowMs: number, signIn = 'sign-in'): boolean[] {
  const lanes = TIER_TABLE.referenceLanes;
  const finishes = (plannedCount: number): number => {
    const order = [
      ...selected.filter((x) => x.flow !== signIn),
      ...planned.slice(0, plannedCount).filter((x) => x.flow !== signIn),
      ...selected.filter((x) => x.flow === signIn),
      ...planned.slice(0, plannedCount).filter((x) => x.flow === signIn),
    ];
    const free = new Array(lanes).fill(0);
    let segment = false;
    let latest = 0;
    for (const item of order) {
      if (item.flow === signIn && !segment) {
        segment = true;
        free.fill(Math.max(...free));
      }
      let lane = 0;
      for (let l = 1; l < lanes; l++) if (free[l] < free[lane]) lane = l;
      free[lane] += item.nominalMs;
      latest = Math.max(latest, free[lane]);
    }
    return latest;
  };
  const base = finishes(0);
  const out: boolean[] = [];
  let cut = false;
  for (let k = 1; k <= planned.length; k++) {
    if (!cut && finishes(k) > Math.max(windowMs, base)) cut = true;
    out.push(!cut);
  }
  return out;
}
