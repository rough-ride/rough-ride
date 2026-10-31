// Not attacked accounting (spec part 4 section 18, and the full-load
// qualifiers of 19.4): every changed app, config and dependency file and every
// changed endpoint ends in exactly one state.

import type { ChangedEndpoint } from './backend.mjs';
import type { DiffFile } from './diff.mjs';
import type { FlowRunResult } from './flowrun.mjs';

// Section 18.3's reasons, in order; the first that fits wins.
export const REASONS = [
  'no sign-in flow',
  'sign-in failed',
  'sign-in needs a third-party account',
  'visits an excluded page',
  'its flows failed their baseline run',
  'over the budget',
  'no attack point after it loads',
  'no attack loaded it',
  'no attack ran',
  'no passing flow for',
  'new flow',
  'no flow sends it from the browser',
  'adversary: no flow',
  'no flow reaches it',
  'deleted',
  'not traced',
] as const;

const COUNTED = new Set(['passed', 'failed', 'pending', 'accepted-finding', 'faulted-flow-stopped', 'accepted-flow-stopped']);

// What ticket 18 onwards records per attack, as far as accounting needs it.
export interface AttackLink {
  flow: string;
  verdict: string;
  kind: 'fault' | 'bad-input' | 'timing' | 'viewport';
  step: number;
  page: string | null;
  // Fault: the request's template; bad input: the form's carrying template;
  // timing: write keys or the carrying key.
  endpoints: string[];
  // Repository files the attack's flow run loaded (module rule).
  loaded: string[];
}

export interface FlowInfo {
  name: string;
  signedIn: boolean;
  passed: boolean;
  excluded: boolean;
  // file -> rule ('module' | 'page' | 'app-wide') through which this flow reaches it.
  reach: Map<string, string>;
  // module-rule file -> the step that first loaded it.
  firstLoad: Map<string, number>;
  // Reaches a changed file through the module or page rule.
  reachesByRule: boolean;
  // Request templates (without #n) the flow sent from the browser.
  sent: Set<string>;
  pages: FlowRunResult['pages'];
  // Steps that hold an attack point (own-origin fetch or XHR, forms, page entries).
  attackPointSteps: number[];
}

export interface AccountingInput {
  files: DiffFile[];
  endpoints: ChangedEndpoint[];
  untraced: Map<string, string>;
  flows: FlowInfo[];
  signIn: 'none' | 'passed' | 'failed';
  modulesOn: boolean;
  attacks: AttackLink[];
  // False until attacks exist: reached items then read `no attack ran`.
  attacksBuilt: boolean;
  tier: string;
  // Attacks the cut or the clock left out, with their qualifier (`` or ` (time)`).
  cutAttacks?: (AttackLink & { qualifier: string })[];
}

export interface Entry {
  kind: 'file' | 'endpoint';
  file: string;
  endpoint: string | null;
  symbol: string | null;
  state: 'attacked' | 'not-attacked';
  reason: string | null;
}

export interface FullLoad {
  endpoint: string;
  page: string;
  kind: 'hidden-on-full-load' | 'only-after-load';
  flows: string[];
  inAppFlows: string[];
  line: string;
}

export interface Accounting {
  entries: Entry[];
  fullLoad: FullLoad[];
}

export class AccountingGap extends Error {}

const SERVER_ONLY = /(^|\/)(\+page\.server\.|\+layout\.server\.|hooks\.server\.)|\.server\.(?!vue$)[^/]+$/;

export function serverOnly(file: string, text: string | null): boolean {
  return SERVER_ONLY.test(file) || (text !== null && /from\s+['"]server-only['"]|import\s+['"]server-only['"]/.test(text));
}

function reasonRank(reason: string): number {
  const i = REASONS.findIndex((r) => reason.startsWith(r) || reason.startsWith(r.replace('the budget', '')));
  if (reason.startsWith('over the ')) return REASONS.indexOf('over the budget');
  return i === -1 ? REASONS.length : i;
}

function counted(a: AttackLink): boolean {
  return COUNTED.has(a.verdict);
}

// When a reached item was not attacked: the first reached-but-not-attacked reason.
function reachedReason(flows: FlowInfo[], input: AccountingInput, file: string | null): string {
  const signedIn = flows.filter((f) => f.signedIn);
  if (signedIn.length === flows.length && flows.length > 0) {
    if (input.signIn === 'none') return 'no sign-in flow';
    if (input.signIn === 'failed') return 'sign-in failed';
  }
  if (flows.every((f) => f.excluded)) return 'visits an excluded page';
  if (flows.every((f) => !f.passed)) return 'its flows failed their baseline run';
  if (!input.attacksBuilt) return 'no attack ran';
  if (file !== null) {
    const moduleFlows = flows.filter((f) => f.reach.get(file) === 'module');
    if (moduleFlows.length > 0 && moduleFlows.every((f) => !f.attackPointSteps.some((s) => s >= (f.firstLoad.get(file) ?? 0)))) {
      return 'no attack point after it loads';
    }
    if (input.modulesOn && flows.some((f) => f.reach.get(file) === 'page')) return 'no attack loaded it';
  }
  return 'no attack loaded it';
}

function fileAttacked(file: DiffFile, input: AccountingInput, endpointsOfFile: ChangedEndpoint[]): boolean {
  const attacks = input.attacks.filter(counted);
  for (const a of attacks) {
    const flow = input.flows.find((f) => f.name === a.flow);
    if (!flow) continue;
    const rule = flow.reach.get(file.path);
    if (rule === 'app-wide') return true;
    if (a.kind === 'viewport') {
      if (rule === 'module' || rule === 'page') return true;
      continue;
    }
    if (endpointsOfFile.some((e) => a.endpoints.includes(e.endpoint))) return true;
    if (rule === 'module' && a.step >= (flow.firstLoad.get(file.path) ?? Infinity)) return true;
    if (rule === 'page' && a.page !== null && (!input.modulesOn || attacks.some((x) => x.loaded.includes(file.path)))) {
      if (flow.pages.some((p) => p.path === a.page)) return true;
    }
  }
  return false;
}

export function account(input: AccountingInput): Accounting {
  const entries: Entry[] = [];
  const counts = input.files.filter((f) => f.class === 'app' || f.class === 'config' || f.class === 'dependency');
  for (const file of counts) {
    const ofFile = input.endpoints.filter((e) => e.file === file.path);
    const reaching = input.flows.filter((f) => f.reach.has(file.path));
    const entry: Entry = { kind: 'file', file: file.path, endpoint: null, symbol: null, state: 'not-attacked', reason: null };
    if (reaching.length > 0 || ofFile.some((e) => input.flows.some((f) => f.sent.has(e.endpoint)))) {
      const flows = reaching.length > 0 ? reaching : input.flows.filter((f) => ofFile.some((e) => f.sent.has(e.endpoint)));
      if (fileAttacked(file, input, ofFile)) entry.state = 'attacked';
      else {
        entry.reason = reachedReason(flows, input, file.path);
        // A file whose linked attacks were all cut reads over the budget, with its earliest cut's qualifier (50.6).
        const cutLinks = (input.cutAttacks ?? []).map((a) => ({ ...a, verdict: 'passed' }));
        if (cutLinks.length > 0 && reasonRank(entry.reason) > reasonRank('over the budget') && fileAttacked(file, { ...input, attacks: cutLinks }, ofFile)) {
          const first = (input.cutAttacks ?? []).find((a) => fileAttacked(file, { ...input, attacks: [{ ...a, verdict: 'passed' }] }, ofFile));
          entry.reason = `over the ${input.tier} budget${first?.qualifier ?? ''}`;
        }
      }
    } else if (file.reason !== null) {
      entry.reason = `not traced (${file.reason.replace(/^not traced \(|\)$/g, '')})`;
    } else if (input.untraced.has(file.path)) {
      entry.reason = `not traced (${input.untraced.get(file.path)})`;
    } else if (ofFile.length > 0) {
      entry.reason = 'no flow sends it from the browser';
    } else if (file.status === 'deleted') {
      entry.reason = 'deleted';
    } else if (serverOnly(file.path, null)) {
      entry.reason = 'not traced (server-only file)';
    } else if (!input.modulesOn && file.class === 'app' && !file.path.endsWith('.py')) {
      entry.reason = 'not traced (module tracing unavailable)';
    } else {
      entry.reason = 'no flow reaches it';
    }
    entries.push(entry);
  }
  for (const e of input.endpoints) {
    const senders = input.flows.filter((f) => f.sent.has(e.endpoint));
    const entry: Entry = { kind: 'endpoint', file: e.file, endpoint: e.endpoint, symbol: e.symbol, state: 'not-attacked', reason: null };
    if (senders.length === 0) entry.reason = 'no flow sends it from the browser';
    else if (input.attacks.some((a) => counted(a) && a.endpoints.includes(e.endpoint))) entry.state = 'attacked';
    else entry.reason = reachedReason(senders, input, null);
    entries.push(entry);
  }
  // Every counted file and endpoint has exactly one state; a gap is a runner error.
  const keys = new Set(entries.map((x) => `${x.kind}|${x.file}|${x.endpoint ?? ''}`));
  if (keys.size !== entries.length || entries.some((x) => x.state === 'not-attacked' && !x.reason)) {
    throw new AccountingGap('accounting gap: an item has no state or two');
  }
  for (const f of counts) if (!keys.has(`file|${f.path}|`)) throw new AccountingGap(`accounting gap: ${f.path} has no state`);
  return { entries, fullLoad: fullLoadQualifiers(input) };
}

// `hidden-on-full-load`: some reached flow's in-app entry of page P sent K, and
// some reached flow's full-load entry of P did not.
function fullLoadQualifiers(input: AccountingInput): FullLoad[] {
  const out: FullLoad[] = [];
  for (const e of input.endpoints) {
    const [method] = e.endpoint.split(' ');
    if (method !== 'GET' && method !== 'HEAD') continue;
    const pages = new Set(input.flows.flatMap((f) => f.pages.map((p) => p.path)));
    for (const page of pages) {
      const inApp = input.flows.filter((f) => f.pages.some((p) => p.path === page && p.entry === 'in-app' && p.requests.includes(e.endpoint)));
      const fullNo = input.flows.filter((f) => f.pages.some((p) => p.path === page && p.entry === 'full-load' && !p.requests.includes(e.endpoint)));
      if (inApp.length === 0 || fullNo.length === 0) continue;
      out.push({
        endpoint: e.endpoint,
        page,
        kind: 'hidden-on-full-load',
        flows: fullNo.map((f) => f.name),
        inAppFlows: inApp.map((f) => f.name),
        line: `${e.endpoint}: not sent from the browser on the full page load of ${page} (${fullNo.map((f) => f.name).join(', ')}); in-app entry sends it (${inApp.map((f) => f.name).join(', ')}).`,
      });
    }
  }
  return out;
}

// A file's grouping folder: its first two folder segments, or its single folder.
function groupFolder(file: string): string {
  const folders = file.split('/').slice(0, -1);
  if (folders.length === 0) return '';
  return `${folders.slice(0, Math.min(2, folders.length)).join('/')}/`;
}

export interface NotAttackedLine {
  text: string;
  reason: string;
  members: string[];
}

export function notAttackedLines(entries: Entry[]): NotAttackedLine[] {
  const open = entries.filter((e) => e.state === 'not-attacked');
  const lines: NotAttackedLine[] = [];
  const files = open.filter((e) => e.kind === 'file');
  const groups = new Map<string, Entry[]>();
  for (const e of files) {
    const key = `${e.reason}|${groupFolder(e.file)}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  for (const [key, members] of groups) {
    const [reason, folder] = key.split('|') as [string, string];
    if (members.length >= 3) {
      const where = folder === '' ? 'at the repository root' : `under ${folder}`;
      lines.push({ text: `Not attacked: ${members.length} files ${where} (${reason})`, reason, members: members.map((m) => m.file).sort() });
    } else {
      for (const m of members) lines.push({ text: `Not attacked: ${m.file} (${reason})`, reason, members: [m.file] });
    }
  }
  const endpointGroups = new Map<string, Entry[]>();
  for (const e of open.filter((x) => x.kind === 'endpoint')) {
    const key = `${e.reason}|${e.file}`;
    endpointGroups.set(key, [...(endpointGroups.get(key) ?? []), e]);
  }
  for (const [key, members] of endpointGroups) {
    const [reason, file] = key.split('|') as [string, string];
    if (members.length >= 3) {
      lines.push({ text: `Not attacked: ${members.length} endpoints in ${file} (${reason})`, reason, members: members.map((m) => m.endpoint!).sort() });
    } else {
      for (const m of members) {
        lines.push({ text: `Not attacked: ${m.file}${m.symbol ? ` ${m.symbol}` : ''} -> ${m.endpoint} (${reason})`, reason, members: [m.endpoint!] });
      }
    }
  }
  return lines.sort((a, b) => reasonRank(a.reason) - reasonRank(b.reason) || b.members.length - a.members.length || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
}

export const SCOPE_LINE = "Requests your servers send are never attacked in v1, including data a page loads while it renders on the server. A page's data load is attacked only when a flow opens the page by in-app navigation and the browser sends the request.";

// The summary's Not attacked section: at most 3 lines, the overflow line, then
// the scope line when any line or qualifier exists.
export function summaryNotAttacked(lines: NotAttackedLine[], fullLoad: FullLoad[]): string[] {
  const out = lines.length > 3 ? [...lines.slice(0, 3).map((l) => l.text), `+${lines.length - 3} more not attacked (report.txt)`] : lines.map((l) => l.text);
  if (lines.length > 0 || fullLoad.length > 0) out.push(SCOPE_LINE);
  return out;
}

// report.txt's form: every line, with its members indented under a grouped line.
export function reportNotAttacked(lines: NotAttackedLine[], fullLoad: FullLoad[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    out.push(l.text);
    if (l.members.length > 1) for (const m of l.members) out.push(`  ${m}`);
  }
  for (const q of fullLoad) out.push(q.line);
  if (lines.length > 0 || fullLoad.length > 0) out.push(SCOPE_LINE);
  return out;
}

// The Nothing attacked line when no attack ran.
export function nothingAttackedLine(entries: Entry[]): string {
  const files = entries.filter((e) => e.kind === 'file');
  const n = files.length;
  if (files.every((e) => e.reason === 'no flow reaches it' || e.reason === 'no flow sends it from the browser')) {
    return `Nothing attacked: no flow reaches the ${n} changed ${n === 1 ? 'file' : 'files'}`;
  }
  const first = [...files].filter((e) => e.reason).sort((a, b) => reasonRank(a.reason!) - reasonRank(b.reason!))[0];
  if (!first) return `Nothing attacked: no attack ran on the ${n} changed ${n === 1 ? 'file' : 'files'}`;
  return `Nothing attacked: ${first.reason} (${n} changed ${n === 1 ? 'file' : 'files'})`;
}
