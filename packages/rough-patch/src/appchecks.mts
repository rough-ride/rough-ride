// App-specific checks (spec part 11 sections 45.6 to 45.9, ADR 0004): one
// declarative condition per check, quoting the spec file it enforces, judged
// by the runner from its own records. No code, no regular expression and no
// LLM judges anything.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from 'playwright-core';
import { decodeUtf8 } from './adversary.mjs';
import { CHECK_RANK, evidence, toldFault, type CheckResult } from './checks.mjs';
import { describeLocator, type Flow, type FlowRunResult, type LocatorSpec, type StepRecord } from './flowrun.mjs';
import type { FolderState } from './folder.mjs';
import { canonicalJson } from './output.mjs';

export const CHECK_CAP = 10;
const ID = /^app-[a-z0-9][a-z0-9-]{0,39}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const FREE_TEXT = /^[\x20-\x7e]{1,160}$/;
const KEY = /^[A-Z]+ \/\S*$/;
const ATTACKS = ['fault', 'bad-input', 'timing', 'viewport'] as const;
const AT = ['settled', 'end', 'every-step'] as const;
const STATUS = ['2xx', '3xx', '4xx', '5xx', 'failed'] as const;
const REFUSED = ['rejected', 'blocked-by-browser', 'blocked-by-app', 'silent-refusal'];
// 45.8 gate 4: these follow the machine's time zone and locale.
const DATE_TIME = [/\d{4}-\d{2}-\d{2}/, /\d{1,2}[./-]\d{1,2}[./-]\d{4}/, /\d{1,2}:\d{2}/];

export type Condition =
  | { text: string; within?: LocatorSpec; absent?: true }
  | { count: { of: LocatorSpec; is?: number; atLeast?: number; atMost?: number } }
  | { path: { is?: string; isNot?: string } }
  | { requests: { key: string; status?: (typeof STATUS)[number]; is?: number; atLeast?: number; atMost?: number } }
  | { outcome: 'accepted' | 'refused' };

export interface AppCheck {
  id: string;
  // Left out in a regression test, whose own attack takes the place of flow and when.
  flow?: string;
  when: { attack?: (typeof ATTACKS)[number]; point?: string; field?: LocatorSpec; ids?: string[]; outcome?: 'told' | 'refused' | 'accepted' };
  at: (typeof AT)[number];
  assert: Condition;
  spec: string;
  quote?: string;
  because: string;
}

// The texts the quote check compares: NFC, whitespace runs collapsed, trimmed.
export function normText(text: string): string {
  return text.replace(/\r\n/g, '\n').normalize('NFC').replace(/\s+/g, ' ').trim();
}

const isLocator = (v: unknown): v is LocatorSpec => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if ('role' in o) return typeof o.role === 'string' && keys.every((k) => k === 'role' || (k === 'name' && typeof o.name === 'string'));
  return keys.length === 1 && ['label', 'text', 'testId'].includes(keys[0]!) && typeof o[keys[0]!] === 'string';
};
const locatorStrings = (l: LocatorSpec): string[] => Object.values(l).filter((v): v is string => typeof v === 'string');
const sameLocator = (a: LocatorSpec, b: LocatorSpec) => canonicalJson(a) === canonicalJson(b);
const keyOf = (k: string) => k.replace(/ #\d+$/, '').replace(/\{[^}]*\}/g, '{}');
const one = (o: Record<string, unknown>, keys: string[]) => keys.filter((k) => o[k] !== undefined);

// The facts a check is validated against: plan's data in --check, the fresh baseline runs in attack.
export interface CheckFacts {
  // Spec parts by file stem: the text read now, and whether its sha256 changed since plan.
  specs: Map<string, { text: string | null; changed: boolean }>;
  flows: Set<string>;
  // A flow's footprint; null when unknown (a flow saved in this run, in --check).
  footprint(flow: string): { paths: string[]; requests: string[]; steps: LocatorSpec[] | null; fills: string[] | null } | null;
  // `METHOD template` keys from the OpenAPI documents.
  apiKeys: string[];
  // The fresh baseline run's visible lines and what a within locator matched; left out in --check.
  baseline?(flow: string): { lines: string[]; withinMatched(locator: LocatorSpec): boolean } | null;
}

export interface CheckEntry {
  path: string;
  id: string | null;
  status: 'kept' | 'rejected' | 'disabled';
  why?: string;
}

export interface ChecksResult {
  kept: AppCheck[];
  entries: CheckEntry[];
  lines: string[];
}

function conditionOf(raw: unknown): Condition | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'assert holds exactly one of text, count, path, requests or outcome';
  const a = raw as Record<string, unknown>;
  const kinds = one(a, ['text', 'count', 'path', 'requests', 'outcome']);
  if (kinds.length !== 1 || (kinds[0] !== 'text' && Object.keys(a).length !== 1)) return 'assert holds exactly one of text, count, path, requests or outcome';
  const bound = (o: Record<string, unknown>, max: number) => {
    const given = one(o, ['is', 'atLeast', 'atMost']);
    if (given.length !== 1) return 'it takes exactly one of is, atLeast or atMost';
    const n = o[given[0]!];
    return Number.isInteger(n) && (n as number) >= 0 && (n as number) <= max ? null : `${given[0]} is 0 to ${max}`;
  };
  switch (kinds[0]) {
    case 'text': {
      if (Object.keys(a).some((k) => !['text', 'within', 'absent'].includes(k)) || typeof a.text !== 'string') return 'assert.text is {text, within?, absent?}';
      if (a.within !== undefined && !isLocator(a.within)) return 'assert.within is a locator';
      if (a.absent !== undefined && a.absent !== true) return 'absent is true or left out';
      return a as Condition;
    }
    case 'count': {
      const c = a.count as Record<string, unknown> | null;
      if (!c || typeof c !== 'object' || Object.keys(c).some((k) => !['of', 'is', 'atLeast', 'atMost'].includes(k)) || !isLocator(c.of)) return 'assert.count is {of: <locator>, is | atLeast | atMost}';
      const b = bound(c, 100);
      if (b) return `assert.count: ${b}`;
      if (!locatorStrings(c.of as LocatorSpec).some((s) => s.includes('${unique}'))) return 'a count locator contains ${unique}';
      return a as Condition;
    }
    case 'path': {
      const p = a.path as Record<string, unknown> | null;
      if (!p || typeof p !== 'object' || Object.keys(p).length !== 1 || one(p, ['is', 'isNot']).length !== 1) return 'assert.path is {is | isNot: "<path template>"}';
      const v = p.is ?? p.isNot;
      return typeof v === 'string' && v.startsWith('/') ? (a as Condition) : 'a path template starts with /';
    }
    case 'requests': {
      const r = a.requests as Record<string, unknown> | null;
      if (!r || typeof r !== 'object' || Object.keys(r).some((k) => !['key', 'status', 'is', 'atLeast', 'atMost'].includes(k))) return 'assert.requests is {key, status?, is | atLeast | atMost}';
      if (typeof r.key !== 'string' || !KEY.test(r.key)) return 'assert.requests.key is "METHOD template" without #n';
      if (r.status !== undefined && !STATUS.includes(r.status as (typeof STATUS)[number])) return 'assert.requests.status is 2xx, 3xx, 4xx, 5xx or failed';
      const b = bound(r, 1000);
      return b ? `assert.requests: ${b}` : (a as Condition);
    }
    default:
      return a.outcome === 'accepted' || a.outcome === 'refused' ? (a as Condition) : 'assert.outcome is accepted or refused';
  }
}

// Conditions every-step accepts (45.7): absence only.
function isAbsence(c: Condition): boolean {
  if ('text' in c) return c.absent === true;
  if ('count' in c) return c.count.is === 0 || c.count.atMost !== undefined;
  if ('path' in c) return c.path.isNot !== undefined;
  if ('requests' in c) return c.requests.is === 0 || c.requests.atMost !== undefined;
  return false;
}

// The shape rules every check obeys, in a plan or inline in a regression test.
export function shapeOf(raw: Record<string, unknown>, inline: boolean): AppCheck | string {
  const fields = inline ? ['id', 'at', 'when', 'assert', 'spec', 'because'] : ['id', 'flow', 'when', 'at', 'assert', 'spec', 'quote', 'because'];
  const unknown = Object.keys(raw).find((k) => !fields.includes(k));
  if (unknown) return `unknown field ${unknown}`;
  const missing = fields.filter((k) => raw[k] === undefined && !(inline && k === 'when'));
  if (missing.length > 0) return `missing ${missing.join(', ')}`;
  if (typeof raw.id === 'string' && Object.hasOwn(CHECK_RANK, raw.id)) return `${raw.id} is a generic check id`;
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) return 'id is app- then 1 to 40 lowercase letters, digits or dashes';
  if (!inline && (typeof raw.flow !== 'string' || !NAME.test(raw.flow))) return 'flow is not a flow name';
  if (typeof raw.spec !== 'string' || !NAME.test(raw.spec)) return 'spec is a spec file name without .txt';
  if (typeof raw.because !== 'string' || !FREE_TEXT.test(raw.because)) return 'because is one ASCII line of 1 to 160 characters';
  if (canonicalJson(raw).includes('${env.')) return 'the only placeholder is ${unique}';
  const w = (raw.when ?? {}) as Record<string, unknown>;
  if (typeof w !== 'object' || Array.isArray(w)) return 'when is a mapping';
  const whenFields = inline ? ['outcome'] : ['attack', 'point', 'field', 'ids', 'outcome'];
  const wUnknown = Object.keys(w).find((k) => !whenFields.includes(k));
  if (wUnknown) return `unknown field when.${wUnknown}`;
  if (!inline && !ATTACKS.includes(w.attack as (typeof ATTACKS)[number])) return 'when.attack is fault, bad-input, timing or viewport';
  if (w.point !== undefined && (typeof w.point !== 'string' || !KEY.test(w.point) || / #\d+$/.test(w.point))) return 'when.point is "METHOD template" without #n';
  if (w.field !== undefined && !isLocator(w.field)) return 'when.field is a locator';
  if (w.ids !== undefined && (!Array.isArray(w.ids) || w.ids.length === 0 || w.ids.some((x) => typeof x !== 'string'))) return 'when.ids is a list of ids';
  if (w.outcome !== undefined && !['told', 'refused', 'accepted'].includes(w.outcome as string)) return 'when.outcome is told, refused or accepted';
  if (!inline && w.outcome === 'told' && w.attack !== 'fault') return 'when.outcome told needs when.attack fault';
  if (!inline && w.outcome === 'refused' && w.attack !== 'bad-input') return 'when.outcome refused needs when.attack bad-input';
  if (!inline && w.outcome === 'accepted' && w.attack !== 'bad-input' && w.attack !== 'fault') return 'when.outcome accepted needs when.attack fault or bad-input';
  if (!AT.includes(raw.at as (typeof AT)[number])) return 'at is settled, end or every-step';
  if (!inline && raw.at === 'settled' && w.attack === 'viewport') return 'at settled needs when.attack fault, bad-input or timing';
  const c = conditionOf(raw.assert);
  if (typeof c === 'string') return c;
  if ('outcome' in c && (raw.at !== 'settled' || (!inline && w.attack !== 'bad-input'))) return 'assert.outcome needs when.attack bad-input and at settled';
  // 45.8 gates 3 to 5 that need no run.
  const literals = [...('text' in c ? [c.text] : []), ...('text' in c && c.within ? locatorStrings(c.within) : []), ...('count' in c ? locatorStrings(c.count.of) : [])];
  if ('text' in c && (c.text.length < 3 || c.text.length > 200)) return 'a text literal is 3 to 200 characters';
  const dated = literals.find((l) => DATE_TIME.some((d) => d.test(l)));
  if (dated !== undefined) return `${JSON.stringify(dated)} is shaped like a date or time, which follows the machine's time zone and locale`;
  if (raw.at === 'every-step' && !isAbsence(c)) return 'every-step takes absence conditions only';
  const check: AppCheck = { id: raw.id, when: w as AppCheck['when'], at: raw.at as AppCheck['at'], assert: c, spec: raw.spec, because: raw.because };
  if (!inline) {
    check.flow = raw.flow as string;
    check.quote = raw.quote as string;
  }
  return check;
}

// 45.6 to 45.8: each entry on its own, then the cap. Gates that need a fresh
// baseline run apply only when facts carry one.
export function validateChecks(list: unknown[], facts: CheckFacts): ChecksResult {
  const kept: AppCheck[] = [];
  const entries: CheckEntry[] = [];
  const lines: string[] = [];
  const reject = (p: string, id: string | null, why: string) => {
    entries.push({ path: p, id, status: 'rejected', why });
    lines.push(`Rejected plan entry: ${p} (${why})`);
  };
  const ids = new Set<string>();
  for (const [i, raw] of list.entries()) {
    const p = `checks[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      reject(p, null, 'an entry is a mapping');
      continue;
    }
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : null;
    // 45.8 gate 1.
    if (facts.specs.size === 0) {
      reject(p, id, 'no spec: app-specific checks quote a spec file');
      continue;
    }
    const c = shapeOf(r, false);
    if (typeof c === 'string') {
      reject(p, id, c);
      continue;
    }
    if (ids.has(c.id)) {
      reject(p, c.id, `id ${c.id} is used twice`);
      continue;
    }
    ids.add(c.id);
    if (!facts.flows.has(c.flow!)) {
      reject(p, c.id, `no flow ${c.flow} in this run`);
      continue;
    }
    // 45.8 gate 2: the quote.
    const spec = facts.specs.get(c.spec);
    if (!spec) {
      reject(p, c.id, `no spec part ${c.spec} in this run`);
      continue;
    }
    if (spec.changed || spec.text === null) {
      reject(p, c.id, `spec ${c.spec} changed since the plan was made`);
      continue;
    }
    const quote = typeof c.quote === 'string' ? normText(c.quote) : '';
    if (typeof c.quote !== 'string' || [...quote].length < 12 || [...quote].length > 300) {
      reject(p, c.id, 'quote is 12 to 300 characters');
      continue;
    }
    if (!normText(spec.text).includes(quote)) {
      reject(p, c.id, `quote not found in spec ${c.spec}`);
      continue;
    }
    // 45.8 gate 3: anchors.
    const fp = facts.footprint(c.flow!);
    const a = c.assert;
    const anchor = ((): string | null => {
      if (!fp) return null;
      if (c.when.point !== undefined && !fp.requests.map(keyOf).includes(keyOf(c.when.point))) return `${c.when.point} is not an attack point of ${c.flow}`;
      if (c.when.field !== undefined && fp.steps && !fp.steps.some((s) => sameLocator(s, c.when.field!))) return `${describeLocator(c.when.field)} is not an attackable step of ${c.flow}`;
      if ('path' in a && a.path.is !== undefined && !fp.paths.some((x) => pathMatches(a.path.is!, x)) && !quote.includes(a.path.is)) return `path ${a.path.is} is neither a page ${c.flow} visited nor in the quote`;
      if ('requests' in a) {
        const k = keyOf(a.requests.key);
        const inFootprint = fp.requests.map(keyOf).includes(k);
        if (!inFootprint && !facts.apiKeys.map(keyOf).includes(k)) return `${a.requests.key} is neither in the footprint of ${c.flow} nor in an OpenAPI document`;
        if (!inFootprint && a.requests.atLeast !== undefined) return `atLeast needs ${a.requests.key} in the footprint of ${c.flow}`;
      }
      if ('text' in a && a.absent && !a.text.includes('${unique}') && fp.fills && fp.fills.some((v) => v.replace(/\$\{[^}]*\}/g, '').includes(a.text))) return `the absent text is part of a fill value of ${c.flow}`;
      return null;
    })();
    if (anchor) {
      reject(p, c.id, anchor);
      continue;
    }
    // 45.8 gate 7.
    if (kept.length >= CHECK_CAP) {
      reject(p, c.id, `over the check cap of ${CHECK_CAP}`);
      continue;
    }
    const base = facts.baseline?.(c.flow!);
    const disable = (why: string) => {
      entries.push({ path: p, id: c.id, status: 'disabled', why });
      lines.push(`App-specific check ${c.id}: disabled (${why})`);
    };
    if (base && 'text' in a && !a.absent && !a.text.includes('${unique}') && !quote.includes(normText(a.text)) && !base.lines.some((l) => normText(l).includes(normText(a.text)))) {
      disable('its text is in neither the quote nor a baseline run');
      kept.push(c);
      continue;
    }
    // A settled check's within element may appear only under the attack, so only end and every-step checks need it in a baseline run.
    if (base && c.at !== 'settled' && 'text' in a && a.within && !base.withinMatched(a.within)) {
      disable(`its within locator ${describeLocator(a.within)} matches nothing in a baseline run`);
      kept.push(c);
      continue;
    }
    kept.push(c);
    entries.push({ path: p, id: c.id, status: 'kept' });
  }
  const disabled = new Set(entries.filter((e) => e.status === 'disabled').map((e) => e.id));
  return { kept: kept.filter((c) => !disabled.has(c.id)), entries, lines };
}

// `{}` matches one segment; everything else literally.
export function pathMatches(template: string, actual: string): boolean {
  const t = template.split('/');
  const a = actual.split('/');
  return t.length === a.length && t.every((s, i) => s === '{}' || s === a[i]);
}

// A spec part as attack reads it again: its text and whether its sha256 changed since plan.
export function readSpecPart(folder: FolderState, name: string, sha256: string): { text: string | null; changed: boolean } {
  try {
    const text = decodeUtf8(readFileSync(path.join(folder.dir, 'specs', name)));
    if (text === null) return { text: null, changed: true };
    return { text, changed: createHash('sha256').update(text).digest('hex') !== sha256 };
  } catch {
    return { text: null, changed: true };
  }
}

export function specFacts(folder: FolderState, parts: { name: string; sha256: string }[]): CheckFacts['specs'] {
  return new Map(parts.map((p) => [p.name.replace(/\.txt$/, ''), readSpecPart(folder, p.name, p.sha256)]));
}

// What the runner reads from the live page at an evaluation point.
export interface PointProbe {
  step: number;
  end: boolean;
  recovery: boolean;
  // How many requests and step records the run had at this point.
  requests: number;
  records: number;
  path: string | null;
  // By locator, as describeLocator writes it: the visible matches' text, and their number.
  within: Record<string, string[]>;
  counts: Record<string, number>;
}

export type OnPoint = (page: Page, locate: (spec: LocatorSpec) => Locator, point: { step: number; end: boolean; recovery: boolean; requests: number; records: number }) => Promise<void>;

const MAX_MATCHES = 101;

// A probe for runFlow's onPoint hook: the main frame's path, and the locators these checks read.
export function probeFor(checks: AppCheck[]): { probes: PointProbe[]; onPoint: OnPoint } {
  const within = new Map<string, LocatorSpec>();
  const counts = new Map<string, LocatorSpec>();
  for (const c of checks) {
    if ('text' in c.assert && c.assert.within) within.set(describeLocator(c.assert.within), c.assert.within);
    if ('count' in c.assert) counts.set(describeLocator(c.assert.count.of), c.assert.count.of);
  }
  const probes: PointProbe[] = [];
  const visible = async (l: Locator) => {
    const out: Locator[] = [];
    for (const m of (await l.all().catch(() => [] as Locator[])).slice(0, MAX_MATCHES)) if (await m.isVisible().catch(() => false)) out.push(m);
    return out;
  };
  const onPoint: OnPoint = async (page, locate, point) => {
    let p: string | null = null;
    try {
      p = decodeURIComponent(new URL(page.url()).pathname);
    } catch {
      p = null;
    }
    const probe: PointProbe = { ...point, path: p, within: {}, counts: {} };
    for (const [k, l] of within) probe.within[k] = await Promise.all((await visible(locate(l))).map((m) => m.innerText({ timeout: 1000 }).catch(() => '')));
    for (const [k, l] of counts) probe.counts[k] = (await visible(locate(l))).length;
    probes.push(probe);
  };
  return { probes, onPoint };
}

// The attack a check is matched against: its kind, point, attacked step and ids.
export interface MatchedAttack {
  kind: 'fault' | 'viewport' | 'timing' | 'bad-input';
  fault: string | null;
  timing?: string;
  template: string;
  step: number;
  badInput?: { inputId: string; fillStep: number; submitStep: number };
}

// when's attack, point, field and ids (45.7); the outcome is known only after the run.
export function matchesWhen(c: AppCheck, a: MatchedAttack, flow: Flow): boolean {
  const w = c.when;
  if (c.flow !== undefined && c.flow !== flow.name) return false;
  if (w.attack !== undefined && w.attack !== a.kind) return false;
  if (w.point !== undefined && (a.kind === 'viewport' || keyOf(w.point) !== keyOf(a.template))) return false;
  if (w.field !== undefined) {
    const step = flow.steps[(a.badInput ? a.badInput.fillStep : a.step) - 1] as Record<string, unknown> | undefined;
    const loc = step ? Object.values(step).find(isLocator) : undefined;
    if (!loc || !sameLocator(loc, w.field)) return false;
  }
  if (w.ids !== undefined) {
    const id = a.badInput?.inputId ?? a.timing ?? a.fault;
    if (!id || !w.ids.includes(id)) return false;
  }
  return true;
}

// told, refused or accepted (45.7), or what the run was instead.
export function outcomeOf(a: MatchedAttack, run: FlowRunResult): { cls: 'told' | 'refused' | 'accepted' | null; shown: string } {
  if (a.kind === 'bad-input') {
    const o = run.badInput?.outcome ?? null;
    if (o === null) return { cls: null, shown: 'none' };
    if (REFUSED.includes(o)) return { cls: 'refused', shown: 'refused' };
    if (o === 'accepted') return { cls: 'accepted', shown: 'accepted' };
    return { cls: null, shown: o };
  }
  if (a.kind === 'fault' && a.fault && run.fault?.fired && !run.fault.pending) {
    if (run.fault.absorbed) return { cls: null, shown: 'absorbed' };
    if (toldFault(a.fault, run.fault)) return { cls: 'told', shown: 'told' };
    return { cls: 'accepted', shown: 'accepted' };
  }
  return { cls: null, shown: 'none' };
}

// A run that completed every step and every expect, recovery included.
export function endReached(run: FlowRunResult): boolean {
  return run.failure === null && run.voided === null && run.excluded === null && !run.endedAfterWindow && run.stoppedAt === null && run.recovery?.passed !== false;
}

export function describeCondition(c: Condition): string {
  const bound = (o: { is?: number; atLeast?: number; atMost?: number }) => (o.is !== undefined ? `is ${o.is}` : o.atLeast !== undefined ? `at least ${o.atLeast}` : `at most ${o.atMost}`);
  if ('text' in c) return `text ${JSON.stringify(c.text)}${c.absent ? ' absent' : ''}${c.within ? ` within ${describeLocator(c.within)}` : ''}`;
  if ('count' in c) return `count of ${describeLocator(c.count.of)} ${bound(c.count)}`;
  if ('path' in c) return c.path.is !== undefined ? `path is ${c.path.is}` : `path is not ${c.path.isNot}`;
  if ('requests' in c) return `requests ${c.requests.key}${c.requests.status ? ` ${c.requests.status}` : ''} ${bound(c.requests)}`;
  return `outcome ${c.outcome}`;
}

const within = (n: number, o: { is?: number; atLeast?: number; atMost?: number }) =>
  o.is !== undefined ? n === o.is : o.atLeast !== undefined ? n >= o.atLeast : n <= o.atMost!;

const linesAt = (s: StepRecord | undefined, window: boolean): string[] => {
  const o = s?.observation;
  if (!o) return [];
  return window ? [...o.samples.flatMap((x) => [...x.lines, ...x.live]), ...o.after.lines, ...o.after.live] : [...o.after.lines, ...o.after.live];
};

export interface EvalContext {
  run: FlowRunResult;
  probes: PointProbe[];
  // The attacked step; 1 on a baseline run.
  step: number;
  // The attack's outcome class, for the outcome condition.
  outcome?: { cls: 'told' | 'refused' | 'accepted' | null; shown: string };
  ownHost: (url: string) => boolean;
}

// One condition at one point: null when it holds, else what was seen.
function holds(c: Condition, x: EvalContext, probe: PointProbe | undefined, s: StepRecord | undefined, requests: number, unique: string, hide: string[]): string | null {
  const literal = (t: string) => normText(t.replace(/\$\{unique\}/g, unique));
  const shown = (t: string) => {
    let out = t;
    for (const v of hide) if (v.length >= 20) out = out.split(v).join(`<${v.length} chars typed>`);
    return out.length > 80 ? `${out.slice(0, 77)}...` : out;
  };
  if ('text' in c) {
    const want = literal(c.text);
    let texts: string[];
    if (c.within) {
      if (!probe) return 'the page was not read at this point';
      texts = probe.within[describeLocator(c.within)] ?? [];
    } else texts = linesAt(s, !c.absent);
    const hit = texts.find((t) => normText(t).includes(want));
    if (c.absent) return hit === undefined ? null : `visible: ${JSON.stringify(shown(normText(hit)))}`;
    if (hit !== undefined) return null;
    if (c.within) return texts.length === 0 ? `nothing matched ${describeLocator(c.within)}` : `${describeLocator(c.within)} showed ${JSON.stringify(shown(normText(texts.join(' '))))}`;
    return 'not visible';
  }
  if ('count' in c) {
    if (!probe) return 'the page was not read at this point';
    const n = probe.counts[describeLocator(c.count.of)] ?? 0;
    return within(n, c.count) ? null : `counted ${n}`;
  }
  if ('path' in c) {
    const p = probe?.path ?? null;
    if (p === null) return 'no path at this point';
    if (c.path.is !== undefined) return pathMatches(c.path.is, p) ? null : `the page was ${p}`;
    return pathMatches(c.path.isNot!, p) ? `the page was ${p}` : null;
  }
  if ('requests' in c) {
    const k = keyOf(c.requests.key);
    const st = c.requests.status;
    const n = x.run.requests.slice(0, requests).filter((q) =>
      q.step >= x.step && (q.resourceType === 'fetch' || q.resourceType === 'xhr') && x.ownHost(q.url) && !q.servedByFault && keyOf(q.key) === k &&
      (st === undefined || (st === 'failed' ? q.status === null && q.failure !== null : q.status !== null && Math.floor(q.status / 100) === Number(st[0])))).length;
    return within(n, c.requests) ? null : `${n} sent`;
  }
  const o = x.outcome ?? { cls: null, shown: 'none' };
  return o.cls === c.outcome ? null : `the outcome was ${o.shown}`;
}

// One check on one flow run (45.7): pass, fail, or not evaluated with why.
export function evaluateCheck(c: AppCheck, x: EvalContext): { result: 'pass' | 'fail' | 'not-evaluated'; reason: string } {
  const unique = x.run.unique;
  const hide = x.run.steps.map((s) => s.value).filter((v): v is string => !!v);
  const cond = describeCondition(c.assert);
  const fail = (seen: string) => ({ result: 'fail' as const, reason: `${cond} (${seen})` });
  if (c.at === 'settled') {
    const s = x.run.steps.find((r) => r.index === x.step);
    const probe = x.probes.find((p) => p.step === x.step && !p.end && !p.recovery);
    if (!s) return { result: 'not-evaluated', reason: 'the attacked step never settled' };
    const seen = holds(c.assert, x, probe, s, probe?.requests ?? x.run.requests.length, unique, hide);
    return seen === null ? { result: 'pass', reason: cond } : fail(seen);
  }
  if (c.at === 'end') {
    if (x.run.stoppedAt !== null) return { result: 'not-evaluated', reason: `the flow stopped at step ${x.run.stoppedAt}` };
    if (!endReached(x.run)) return { result: 'not-evaluated', reason: 'the flow run did not complete every step' };
    const probe = x.probes.find((p) => p.end);
    const seen = holds(c.assert, x, probe, x.run.steps.at(-1), x.run.requests.length, unique, hide);
    return seen === null ? { result: 'pass', reason: cond } : fail(`${seen} at the end`);
  }
  for (const [i, s] of x.run.steps.entries()) {
    const probe = x.probes.find((p) => !p.end && p.records === i + 1);
    const seen = holds(c.assert, x, probe, s, probe?.requests ?? x.run.requests.length, unique, hide);
    if (seen !== null) return fail(`${seen} after step ${s.index} (${s.label})`);
  }
  return { result: 'pass', reason: cond };
}

// The check's results on one attack run, as CheckResults the groups and records use.
export function judgeAppChecks(checks: AppCheck[], a: MatchedAttack, flow: Flow, run: FlowRunResult, probes: PointProbe[], verdict: string, ownHost: (url: string) => boolean): CheckResult[] {
  const out: CheckResult[] = [];
  const outcome = outcomeOf(a, run);
  for (const c of checks) {
    if (!matchesWhen(c, a, flow)) continue;
    const app = { spec: c.spec, inline: inlineCheck(c) };
    const push = (result: 'pass' | 'fail' | 'not-evaluated', reason: string) => out.push({ id: c.id as CheckResult['id'], result, evidence: evidence(reason), app });
    if (c.when.outcome !== undefined && c.when.outcome !== outcome.cls) {
      // A plan check whose outcome didn't happen never matched; a test's check reads not evaluated (45.9).
      if (c.flow === undefined) push('not-evaluated', `outcome now ${outcome.shown}; the check needs ${c.when.outcome}`);
      continue;
    }
    // 45.7: the evaluation point is never reached on these.
    if (['void', 'pending', 'not-applied', 'inconclusive', 'fault-never-fired'].includes(verdict)) {
      push('not-evaluated', `the attack was ${verdict.replace(/-/g, ' ')}`);
      continue;
    }
    const r = evaluateCheck(c, { run, probes, step: a.step, outcome, ownHost });
    push(r.result, r.reason);
  }
  return out;
}

// 45.9: what a regression test keeps of a check.
export function inlineCheck(c: AppCheck): Record<string, unknown> {
  return {
    id: c.id,
    at: c.at,
    ...(c.when.outcome !== undefined ? { when: { outcome: c.when.outcome } } : {}),
    assert: c.assert,
    spec: c.spec,
    because: c.because,
  };
}

// A regression test's listed checks: the inline app checks it carries, shape-checked again.
export function inlineChecks(listed: unknown[]): AppCheck[] {
  return listed
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && !Array.isArray(c))
    .map((c) => shapeOf(c, true))
    .filter((c): c is AppCheck => typeof c !== 'string');
}

// 45.8 gate 6: an end or every-step check must pass on the flow's fresh baseline run.
export function baselineGate(c: AppCheck, run: FlowRunResult, probes: PointProbe[], ownHost: (url: string) => boolean): string | null {
  if (c.at === 'settled') return null;
  const r = evaluateCheck(c, { run, probes, step: 1, ownHost });
  if (r.result === 'pass') return null;
  return `App-specific check ${c.id} fails with no attack: ${evidence(r.reason)}`;
}
