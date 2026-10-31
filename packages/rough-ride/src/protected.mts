// Protected files and reviewed versions (spec part 6 section 26, ADR 0003).
// A weakening change to a flow, test, config.yaml or accepted.yaml counts only
// once it is merged into the default branch: until then the reviewed version
// runs, or the copy rough-ride saved on the branch (26.8). Every version of a
// file gets the working copy's check before it is compared or run.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { entryIdentity } from './accepted.mjs';
import { checkVersion, type CommittedKind } from './committed.mjs';
import type { Config } from './config.mjs';
import type { ReviewedBase } from './diff.mjs';
import type { CheckedFiles } from './files.mjs';
import { describeLocator, type Flow, type LocatorSpec, type Step } from './flowrun.mjs';
import { compareVersions, type FormatKind } from './formats.mjs';
import { git } from './git.mjs';
import { fileHash, type Manifest } from './manifest.mjs';
import { canonicalJson, type Note } from './output.mjs';
import { normalisedText, openReviewed, type ReviewedVersions } from './reviewed.mjs';
import { isCi } from './runner.mjs';

export type Used = 'working-tree' | 'reviewed' | 'saved-copy' | 'none';

export interface ProtectedEntry {
  // Relative to .rough-ride/, as the block prints it: `flows/create-note.yaml`.
  path: string;
  kind: FormatKind | 'ci';
  change: string;
  weakening: boolean;
  // Attribution label from the checksum manifest (ticket 32).
  by: string | null;
  used: Used;
  notApplied: string[];
  // Block text after `->`.
  outcome: string;
  // report.txt only: how to remove a saved copy for good (27.7).
  hint?: string;
}

export interface EffectiveFlow {
  flow: Flow;
  used: Used;
  // A reviewed version exists, so one passing baseline run is enough (26.5).
  reviewed: boolean;
  // The working copy changed steps: it runs only if this reviewed version fails its baseline run.
  stepsChanged: { working: Flow; entry: ProtectedEntry } | null;
}

export interface ProtectedResult {
  base: ReviewedBase | null;
  entries: ProtectedEntry[];
  config: Config | null;
  flows: EffectiveFlow[];
  notRun: string[];
  // Tests and accepted entries as they apply (ticket 31 and 34 read them).
  tests: { name: string; value: Record<string, unknown>; used: Used; pending: boolean }[];
  accepted: Record<string, unknown>[];
  notes: Note[];
  // The in-memory text of each protected file, for the changed-during-run check.
  texts: Map<string, string | null>;
  compareLine: string;
  // Hashes of each file's reviewed versions, for pruning the manifest.
  reviewedHashes: Map<string, string[]>;
}

// ---- Versions: every copy of a protected file gets the working copy's check.

// A version that passed steps 1 to 5 and lies in this runner's schema range.
interface Version {
  text: string;
  value: Record<string, unknown>;
}

// A version that exists but can't be compared, and why: below this runner's
// floor, written for a newer runner, or failing steps 1 to 3 or 5.
interface Unreadable {
  schema: string | null;
  why: 'older' | 'newer' | 'invalid';
}

type Judged = { ok: true; version: Version } | { ok: false; unreadable: Unreadable };

// Null for an empty or comment-only file, which counts as no file (7.5).
function judge(text: string, p: string, rules: CheckedFiles['rules']): Judged | null {
  const f = checkVersion(text, `.rough-ride/${p}`, kindOf(p), rules.runner, rules.formats);
  if (f.value === null && f.schema === null && f.problems.length === 0) return null;
  if (f.range === 'older' || f.range === 'newer') return { ok: false, unreadable: { schema: f.schema!.text, why: f.range } };
  if (f.value === null || f.problems.length > 0 || f.step5.length > 0) return { ok: false, unreadable: { schema: f.schema?.text ?? null, why: 'invalid' } };
  return { ok: true, version: { text, value: f.value } };
}

const kindOf = (p: string): CommittedKind => (p === 'config.yaml' ? 'config' : p === 'accepted.yaml' ? 'accepted' : p.startsWith('flows/') ? 'flow' : 'tests');

// An R this runner can't compare (26.3, 26.13, ADR 0002, ADR 0003). Only one
// below the floor lets W be used uncompared. One written for a newer runner
// stops the invocation, as a newer W does. An invalid one is kept: it is not
// compared, and W is not used in its place, so neither version runs.
function unreadableText(u: Unreadable, refShown: string): string {
  return u.why === 'invalid' ? `the ${refShown} version doesn't pass this runner's checks` : `the ${refShown} version is in a format this runner can't read (schema ${u.schema})`;
}

// With no readable R, the unreadable one that decides: an invalid R is never
// passed over for one below the floor.
function unreadableOf(rs: Judged[]): Unreadable | undefined {
  const all = rs.flatMap((r) => (r.ok ? [] : [r.unreadable]));
  return all.find((u) => u.why === 'invalid') ?? all[0];
}

const canon = (v: unknown): string => canonicalJson(v ?? null);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- Flows (26.5).

const isExpect = (s: unknown) => isObject(s) && 'expect' in s;

function describeExpect(step: unknown): string {
  return isObject(step) && isObject(step.expect) ? describeLocator(step.expect as LocatorSpec) : 'an expect';
}

export type FlowChange =
  | { kind: 'same'; reformatted: boolean }
  | { kind: 'expects-added'; text: string }
  | { kind: 'steps-changed'; text: string }
  | { kind: 'weakened'; text: string };

// Rule 1 (expects and top-level fields), then rules 2 and 3.
export function compareFlow(working: Record<string, unknown>, reviewed: Record<string, unknown>, workingText = '', reviewedText = ''): FlowChange {
  if (canon(working) === canon(reviewed)) return { kind: 'same', reformatted: normalisedText(workingText) !== normalisedText(reviewedText) };
  const fields = new Set([...Object.keys(working), ...Object.keys(reviewed)].filter((k) => k !== 'steps' && k !== 'schema'));
  for (const f of [...fields].sort()) {
    if (canon(working[f]) !== canon(reviewed[f])) return { kind: 'weakened', text: `changes ${f}` };
  }
  const ws = Array.isArray(working.steps) ? working.steps : [];
  const rs = Array.isArray(reviewed.steps) ? reviewed.steps : [];
  // R's expects must appear in W in the same order, new expects allowed between them.
  let w = 0;
  for (const [i, step] of rs.entries()) {
    if (!isExpect(step)) continue;
    while (w < ws.length && !(isExpect(ws[w]) && canon(ws[w]) === canon(step))) w++;
    if (w >= ws.length) {
      const sameSpot = ws[i];
      if (isExpect(sameSpot)) return { kind: 'weakened', text: `changes the expect at step ${i + 1} (${describeExpect(step)} -> ${describeExpect(sameSpot)})` };
      return { kind: 'weakened', text: `removes the expect at step ${i + 1} (${describeExpect(step)})` };
    }
    w++;
  }
  const actions = (list: unknown[]) => list.filter((s) => !isExpect(s)).map(canon);
  const wa = actions(ws);
  const ra = actions(rs);
  if (wa.length === ra.length && wa.every((s, i) => s === ra[i])) {
    const added = ws.length - rs.length;
    return { kind: 'expects-added', text: `adds ${added} ${added === 1 ? 'expect' : 'expects'}` };
  }
  let first = 0;
  while (first < ws.length && first < rs.length && canon(ws[first]) === canon(rs[first])) first++;
  let last = 0;
  while (last < ws.length - first && last < rs.length - first && canon(ws[ws.length - 1 - last]) === canon(rs[rs.length - 1 - last])) last++;
  const from = first + 1;
  const to = Math.max(from, ws.length - last);
  return { kind: 'steps-changed', text: from === to ? `step ${from} changed` : `steps ${from} to ${to} changed` };
}

// ---- Tests (26.6).

function stripTest(v: Record<string, unknown>): Record<string, unknown> {
  const { found: _found, ...rest } = v;
  const checks = Array.isArray(rest.checks)
    ? rest.checks.map((c) => (isObject(c) ? Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'spec' && k !== 'because')) : c))
    : rest.checks;
  return { ...rest, checks };
}

export function compareTest(working: Record<string, unknown>, reviewed: Record<string, unknown>): { asWritten: boolean; text: string } {
  const w = stripTest(working);
  const r = stripTest(reviewed);
  if (canon(w) === canon(r)) return { asWritten: true, text: canon(working) === canon(reviewed) ? 'reformatted (same content)' : 'changes found or a check\'s spec or because' };
  const { checks: wc, ...wRest } = w;
  const { checks: rc, ...rRest } = r;
  const wChecks = (Array.isArray(wc) ? wc : []).map(canon);
  const rChecks = (Array.isArray(rc) ? rc : []).map(canon);
  if (canon(wRest) === canon(rRest) && rChecks.every((c) => wChecks.includes(c))) return { asWritten: true, text: 'adds checks' };
  for (const field of ['attack', 'flow', 'context']) if (canon(wRest[field]) !== canon(rRest[field])) return { asWritten: false, text: `changes ${field}` };
  if (rChecks.some((c) => !wChecks.includes(c))) return { asWritten: false, text: 'removes or changes a check' };
  return { asWritten: false, text: 'changes the test' };
}

// ---- config.yaml (26.7).

export function effectiveConfig(working: Config | null, reviewed: Config | null, refShown: string): { config: Config | null; entries: Omit<ProtectedEntry, 'path' | 'kind' | 'by'>[]; lines: string[] } {
  if (working === null) return { config: reviewed, entries: [], lines: [] };
  const entries: Omit<ProtectedEntry, 'path' | 'kind' | 'by'>[] = [];
  const lines: string[] = [];
  const config: Config = JSON.parse(JSON.stringify(working)) as Config;
  const rAllow = reviewed?.allow ?? {};
  const wAllow = working.allow ?? {};
  const notApplied: string[] = [];
  const added = (wAllow.remoteWrites ?? []).filter((h) => !(rAllow.remoteWrites ?? []).includes(h));
  if (added.length > 0) {
    config.allow = { ...config.allow, remoteWrites: (wAllow.remoteWrites ?? []).filter((h) => !added.includes(h)) };
    for (const host of added) {
      notApplied.push(`allow.remoteWrites adds ${host}`);
      lines.push(`config.yaml: allow.remoteWrites adds ${host}, which ${refShown}'s config doesn't have. Not applied until merged; browser writes there are still aborted.`);
    }
  }
  if (wAllow.remoteTarget && wAllow.remoteTarget !== rAllow.remoteTarget) {
    const allow = { ...config.allow };
    if (rAllow.remoteTarget) allow.remoteTarget = rAllow.remoteTarget;
    else delete allow.remoteTarget;
    config.allow = allow;
    notApplied.push(`allow.remoteTarget ${rAllow.remoteTarget ? 'changes to' : 'sets'} ${wAllow.remoteTarget}`);
  }
  const removed = (reviewed?.exclude ?? []).filter((e) => !(working.exclude ?? []).includes(e));
  if (removed.length > 0) {
    config.exclude = [...(working.exclude ?? []), ...removed];
    for (const e of removed) notApplied.push(`exclude removes ${e}`);
  }
  if (notApplied.length > 0) {
    entries.push({ change: notApplied.join('; '), weakening: true, used: 'reviewed', notApplied, outcome: 'not applied until merged' });
  }
  const outside: string[] = [];
  for (const f of ['url', 'ready', 'start'] as const) if (canon(working.target?.[f]) !== canon(reviewed?.target?.[f])) outside.push(`target.${f}`);
  if (canon(working.reset) !== canon(reviewed?.reset)) outside.push('reset');
  if ((working.exclude ?? []).some((e) => !(reviewed?.exclude ?? []).includes(e))) outside.push('exclude adds entries');
  if (outside.length > 0) entries.push({ change: `changes ${outside.join(', ')} (changed outside review)`, weakening: false, used: 'working-tree', notApplied: [], outcome: 'applied' });
  return { config, entries, lines };
}

// ---- The ladder for flows and tests: R, then S, then W (26.5, 26.6, 26.8).

type EntryFields = Omit<ProtectedEntry, 'path' | 'kind' | 'by'>;

// W against one R or S: which one runs, and the change to list (null: none).
interface Rung {
  runs: 'working' | 'reviewed';
  text: string | null;
  // Lower is better: the best rung against either reviewed version wins.
  rank: number;
  // Flows only: W runs if R fails its baseline run (26.5 rule 2).
  stepsChanged?: boolean;
}

interface KindRules {
  compare(w: Version, r: Version): Rung;
  // The outcome when R runs in W's place.
  reviewedOutcome(refShown: string): string;
  // The change listed for an invalid W with neither R nor S.
  invalidAlone: string;
  // The change listed for a valid W with no R, when a base exists.
  newAlone: string | null;
}

const FLOW_RULES: KindRules = {
  compare(w, r) {
    const c = compareFlow(w.value, r.value, w.text, r.text);
    if (c.kind === 'same') return { runs: 'working', text: c.reformatted ? 'reformatted (same content)' : null, rank: 0 };
    if (c.kind === 'expects-added') return { runs: 'working', text: c.text, rank: 1 };
    if (c.kind === 'steps-changed') return { runs: 'reviewed', text: c.text, rank: 2, stepsChanged: true };
    return { runs: 'reviewed', text: c.text, rank: 3 };
  },
  reviewedOutcome: (refShown) => `ran the ${refShown} version`,
  invalidAlone: 'invalid, no reviewed version',
  newAlone: 'new, no reviewed version',
};

const TEST_RULES: KindRules = {
  compare(w, r) {
    const c = compareTest(w.value, r.value);
    if (!c.asWritten) return { runs: 'reviewed', text: c.text, rank: 3 };
    const listed = canon(w.value) !== canon(r.value) || normalisedText(w.text) !== normalisedText(r.text);
    return { runs: 'working', text: listed ? c.text : null, rank: listed ? 1 : 0 };
  },
  reviewedOutcome: (refShown) => `ran the ${refShown} version (pending until merged)`,
  invalidAlone: 'invalid, no reviewed version (stale)',
  newAlone: null,
};

interface Resolved {
  used: Used;
  version: Version | null;
  reviewed: boolean;
  stepsChanged: boolean;
  entry: EntryFields | null;
  notRun: boolean;
}

// Which version of one flow or test runs. `w.version` is null when the file
// is missing or failed step 5, and `w.present` tells the two apart.
function resolve(
  rules: KindRules,
  w: { version: Version | null; present: boolean },
  rs: Judged[],
  saved: { judged: Judged | null; run: string } | null,
  refShown: string,
  hasBase: boolean,
): Resolved {
  const readable = rs.flatMap((r) => (r.ok ? [r.version] : []));
  const missing = w.present ? 'invalid' : 'deleted';
  if (readable.length > 0) {
    // R runs as the merge-base version when both exist; W against either.
    const r = readable[0]!;
    if (!w.version) return { used: 'reviewed', version: r, reviewed: true, stepsChanged: false, entry: { change: missing, weakening: true, used: 'reviewed', notApplied: [], outcome: rules.reviewedOutcome(refShown) }, notRun: false };
    const best = readable.map((x) => rules.compare(w.version!, x)).sort((a, b) => a.rank - b.rank)[0]!;
    if (best.runs === 'working') {
      return { used: 'working-tree', version: w.version, reviewed: true, stepsChanged: false, entry: best.text === null ? null : { change: best.text, weakening: false, used: 'working-tree', notApplied: [], outcome: 'ran this version' }, notRun: false };
    }
    return { used: 'reviewed', version: r, reviewed: true, stepsChanged: !!best.stepsChanged, entry: { change: best.text!, weakening: true, used: 'reviewed', notApplied: [], outcome: rules.reviewedOutcome(refShown) }, notRun: false };
  }
  const unreadable = unreadableOf(rs);
  if (unreadable) {
    const why = unreadableText(unreadable, refShown);
    if (w.version && unreadable.why === 'older') return { used: 'working-tree', version: w.version, reviewed: true, stepsChanged: false, entry: { change: `${why}, so this version is used`, weakening: false, used: 'working-tree', notApplied: [], outcome: 'ran this version' }, notRun: false };
    const change = w.version ? `${why}, so neither version runs` : `${missing}; ${why}`;
    return { used: 'none', version: null, reviewed: true, stepsChanged: false, entry: { change, weakening: false, used: 'none', notApplied: [], outcome: 'not run' }, notRun: w.present };
  }
  // No R: the copy rough-ride saved on this branch runs when W is gone or weakens it (26.8).
  const s = saved?.judged?.ok ? saved.judged.version : null;
  if (s) {
    const rung = w.version ? rules.compare(w.version, s) : null;
    if (!rung || (rung.runs === 'reviewed' && !rung.stepsChanged)) {
      const change = w.present ? `${rung?.text ?? 'invalid'} after rough-ride wrote it (run ${saved!.run})` : `deleted after rough-ride wrote it (run ${saved!.run})`;
      return { used: 'saved-copy', version: s, reviewed: false, stepsChanged: false, entry: { change, weakening: true, used: 'saved-copy', notApplied: [], outcome: 'ran the saved copy', hint: REMOVE_HINT }, notRun: false };
    }
  }
  if (w.version) return { used: 'working-tree', version: w.version, reviewed: false, stepsChanged: false, entry: hasBase && rules.newAlone ? { change: rules.newAlone, weakening: false, used: 'working-tree', notApplied: [], outcome: 'ran this version' } : null, notRun: false };
  if (w.present) return { used: 'none', version: null, reviewed: false, stepsChanged: false, entry: { change: rules.invalidAlone, weakening: false, used: 'none', notApplied: [], outcome: 'not run' }, notRun: true };
  return { used: 'none', version: null, reviewed: false, stepsChanged: false, entry: null, notRun: false };
}

// A checked version as the runner uses it: the schema check has already
// proved the shape these fields claim.
function asFlow(p: string, v: Version): Flow {
  return { name: p.slice('flows/'.length).replace(/\.yaml$/, ''), signedIn: v.value.signedIn as boolean, steps: v.value.steps as Step[] };
}

function asConfig(v: Version): Config {
  return v.value as unknown as Config;
}

// ---- The comparison for one invocation.

export interface CompareOptions {
  root: string;
  folderDir: string;
  files: CheckedFiles;
  env: NodeJS.ProcessEnv;
  pluginData: boolean;
  mode?: 'tier' | 'regress';
  manifest?: Manifest;
  // The invocation's reviewed versions, when other readers ask for paths in
  // the same read (40.4, 43.1); opened from git with `mode` otherwise.
  reviewed?: ReviewedVersions;
}

const REMOVE_HINT = 'To remove it for good, delete the file, then in your own terminal remove its entry from .git/.rough-ride/manifest.json, or delete .git/.rough-ride/ to forget every saved copy in this worktree.';

const PROTECTED = /^(config\.yaml|accepted\.yaml|flows\/[^/]+\.yaml|tests\/[^/]+\.yaml)$/;

// The invocation's comparison, so a stop after it still reports the block in
// its JSON (53.2). One CLI process runs one invocation.
let last: ProtectedResult | null = null;
export function lastProtected(): ProtectedResult | null {
  return last;
}

export function compareProtected(options: CompareOptions): ProtectedResult {
  const { root, files } = options;
  const rel = path.relative(root, options.folderDir).split(path.sep).join('/');
  const versions = options.reviewed ?? openReviewed(root, options.env, options.pluginData, options.mode);
  const { base } = versions;
  const notes: Note[] = [];
  // Working copies passed steps 1 to 4 in files.mts; a step 5 failure leaves no version.
  const working = new Map<string, { text: string; version: Version | null }>();
  for (const f of [files.config, files.accepted, ...files.flows, ...files.tests].filter((x): x is NonNullable<typeof x> => !!x)) {
    working.set(f.shown.replace(/^\.rough-ride\//, ''), { text: f.text, version: f.value !== null && f.step5.length === 0 ? { text: f.text, value: f.value } : null });
  }
  // Reviewed versions of every protected path at either commit, and the CI
  // inputs' merge-base versions, asked for together so one read serves them.
  const reviewedPaths = base ? [...new Set([...versions.list(rel).map((p) => p.slice(rel.length + 1)).filter((p) => PROTECTED.test(p)), ...working.keys()])].sort() : [];
  const ciChanged = ciChanges(root, base);
  versions.want([...reviewedPaths.map((p) => `${rel}/${p}`), ...ciChanged.packages]);
  const reviewed = new Map(reviewedPaths.map((p) => [p, versions.texts(`${rel}/${p}`)]));
  const refShown = base?.shown ?? 'the base branch';
  const entries: ProtectedEntry[] = [];
  const judged = new Map(reviewedPaths.map((p) => [p, (reviewed.get(p) ?? []).flatMap((text) => judge(text, p, files.rules) ?? [])]));
  // A reviewed version written for a newer runner stops here, before anything is compared or run (ADR 0002).
  const newer = [...judged].flatMap(([p, js]) => {
    const schema = js.flatMap((j) => (!j.ok && j.unreadable.why === 'newer' ? [j.unreadable.schema!] : [])).sort(compareVersions).at(-1);
    return schema ? [{ shown: `.rough-ride/${p} (${refShown} version)`, schema }] : [];
  });
  if (newer.length > 0) files.stopNewer(newer);
  const reviewedOf = (p: string): Judged[] => judged.get(p) ?? [];
  const savedOf = (p: string) => {
    const saved = options.manifest?.savedCopy(p);
    return saved ? { judged: judge(saved.text, p, files.rules), run: saved.entry.run } : null;
  };
  // Files rough-ride saved on this branch count too, so a deleted one is noticed.
  const savedPaths = (options.manifest?.data.saved ?? []).filter((e) => e.branch === options.manifest?.branch).map((e) => e.path);
  const pathsOf = (prefix: string) => [...new Set([...working.keys(), ...reviewed.keys(), ...savedPaths])].filter((p) => p.startsWith(prefix)).sort();
  const resolveAt = (p: string, kind: 'flow' | 'tests', rules: KindRules) => {
    const w = working.get(p);
    const out = resolve(rules, { version: w?.version ?? null, present: !!w }, reviewedOf(p), savedOf(p), refShown, !!base);
    const entry = out.entry ? { path: p, kind, by: null, ...out.entry } : null;
    if (entry) entries.push(entry);
    return { ...out, entry, working: w?.version ?? null };
  };

  // Flows.
  const flows: EffectiveFlow[] = [];
  const notRun: string[] = [];
  for (const p of pathsOf('flows/')) {
    const out = resolveAt(p, 'flow', FLOW_RULES);
    if (out.notRun) notRun.push(asFlow(p, { text: '', value: {} }).name);
    if (!out.version) continue;
    const stepsChanged = out.stepsChanged && out.working && out.entry ? { working: asFlow(p, out.working), entry: out.entry } : null;
    flows.push({ flow: asFlow(p, out.version), used: out.used, reviewed: out.reviewed, stepsChanged });
  }

  // Tests.
  const tests: ProtectedResult['tests'] = [];
  for (const p of pathsOf('tests/')) {
    const out = resolveAt(p, 'tests', TEST_RULES);
    if (out.version) tests.push({ name: p.slice('tests/'.length).replace(/\.yaml$/, ''), value: out.version.value, used: out.used, pending: out.used === 'reviewed' });
  }

  // accepted.yaml: entries added since R wait; removed ones stop at once; no R,
  // or an invalid one, applies none. An entry in either reviewed version counts as reviewed.
  const wAccepted = working.get('accepted.yaml')?.version ?? null;
  const wEntries = wAccepted && Array.isArray(wAccepted.value.accepted) ? (wAccepted.value.accepted as unknown[]).filter(isObject) : [];
  const rAccepted = reviewedOf('accepted.yaml');
  const readableAccepted = rAccepted.flatMap((r) => (r.ok ? [r.version] : []));
  const cantReadAccepted = readableAccepted.length === 0 ? unreadableOf(rAccepted) : undefined;
  const waitingLine = (e: Record<string, unknown>) => `Accepted outside review, not applied until merged: ${String(e.page)} ${String(e.step)} ${String(e.action)} ${String(e.check)}.`;
  let accepted: Record<string, unknown>[];
  if (cantReadAccepted?.why === 'older') {
    accepted = wEntries;
    if (wAccepted) entries.push({ path: 'accepted.yaml', kind: 'accepted', by: null, change: `${unreadableText(cantReadAccepted, refShown)}, so this version is used`, weakening: false, used: 'working-tree', notApplied: [], outcome: 'applied' });
  } else if (cantReadAccepted) {
    accepted = [];
    if (wAccepted) entries.push({ path: 'accepted.yaml', kind: 'accepted', by: null, change: `${unreadableText(cantReadAccepted, refShown)}, so no entry in this version applies`, weakening: wEntries.length > 0, used: 'none', notApplied: wEntries.map(waitingLine), outcome: 'not applied until merged' });
  } else {
    const rIds = new Set(readableAccepted.flatMap((r) => (Array.isArray(r.value.accepted) ? (r.value.accepted as unknown[]).filter(isObject).map(entryIdentity) : [])));
    accepted = wEntries.filter((e) => rIds.has(entryIdentity(e)));
    const waiting = wEntries.filter((e) => !rIds.has(entryIdentity(e)));
    if (waiting.length > 0) {
      entries.push({ path: 'accepted.yaml', kind: 'accepted', by: null, change: `adds ${waiting.length} ${waiting.length === 1 ? 'entry' : 'entries'}`, weakening: true, used: 'reviewed', notApplied: waiting.map(waitingLine), outcome: 'not applied until merged' });
    }
  }

  // config.yaml: against the reviewed version that holds back the least.
  const wConfig = working.get('config.yaml')?.version ?? null;
  const rConfig = reviewedOf('config.yaml');
  const readableConfig = rConfig.flatMap((r) => (r.ok ? [r.version] : []));
  const cantReadConfig = readableConfig.length === 0 ? unreadableOf(rConfig) : undefined;
  let cfg: ReturnType<typeof effectiveConfig>;
  let configR: Version | null = null;
  if (cantReadConfig?.why === 'older' && wConfig) {
    cfg = { config: asConfig(wConfig), entries: [{ change: `${unreadableText(cantReadConfig, refShown)}, so this version is used`, weakening: false, used: 'working-tree', notApplied: [], outcome: 'applied' }], lines: [] };
  } else if (cantReadConfig && wConfig) {
    // An invalid R: W's safety values wait as they do with no R. Its other
    // values (target, reset) still apply, as they would against any R (26.7).
    const alone = effectiveConfig(asConfig(wConfig), null, refShown);
    const notApplied = alone.entries.flatMap((e) => e.notApplied);
    cfg = { config: alone.config, entries: [{ change: `${unreadableText(cantReadConfig, refShown)}, so this version's allow values are not applied`, weakening: notApplied.length > 0, used: 'none', notApplied, outcome: 'not applied until merged' }], lines: [] };
  } else {
    const held = (c: ReturnType<typeof effectiveConfig>) => c.entries.reduce((n, e) => n + e.notApplied.length, 0);
    const w = wConfig && asConfig(wConfig);
    const candidates = readableConfig.length > 0 ? readableConfig.map((r) => ({ r, c: effectiveConfig(w, asConfig(r), refShown) })) : [{ r: null, c: effectiveConfig(w, null, refShown) }];
    const best = candidates.reduce((a, b) => (held(b.c) < held(a.c) ? b : a));
    cfg = best.c;
    configR = best.r;
  }
  for (const e of cfg.entries) entries.push({ path: 'config.yaml', kind: 'config', by: null, ...e });
  if (wConfig && configR && canon(wConfig.value) === canon(configR.value) && normalisedText(wConfig.text) !== normalisedText(configR.text)) {
    entries.push({ path: 'config.yaml', kind: 'config', by: null, change: 'reformatted (same content)', weakening: false, used: 'working-tree', notApplied: [], outcome: 'applied' });
  }

  // Attribution labels from the manifest (26.10).
  // CI mode leaves them out: its manifest is always empty, so every label would
  // read changed outside rough-ride (52.4).
  if (options.manifest) {
    const ci = isCi(options.env) && !options.pluginData;
    if (!ci) for (const e of entries) if (e.kind === 'flow' || e.kind === 'tests') e.by = options.manifest.label(e.path, working.get(e.path)?.text ?? null);
    // Only when some branch has a saved copy to leave unused (52.4, in every mode).
    if (options.manifest.dir && options.manifest.branch === null && options.manifest.data.saved.length > 0) notes.push({ id: 'protected-trust', text: 'Saved copies: not used (detached HEAD).' });
  }
  entries.push(...ciInputs(root, ciChanged, versions));

  // The protected-trust note (26.3).
  let compareLine = '';
  if (!base) {
    notes.push({ id: 'protected-trust', text: 'Protected files: no reviewed version (no base branch found). Files are used as they are.' });
  } else if (base.local) {
    notes.push({ id: 'protected-trust', text: `Protected files compared with local ${base.shown} (no remote). Commits on ${base.shown} count as reviewed, so rough-ride can't tell your commits there from an agent's.` });
  } else {
    compareLine = `Protected files compared with ${base.shown} (${base.mergeBase.slice(0, 7)}).`;
    const message = versions.lastMove();
    // git writes `fetch: ...`, `pull: ...`, `clone: ...` and `update by push`.
    if (message !== null && !/^(fetch|pull|push|clone|update by push)\b/.test(message)) {
      notes.push({ id: 'protected-trust', text: `${base.shown} was last moved by something other than fetch, pull or push: protected files may be compared with an unreviewed commit.` });
    }
  }
  const texts = new Map<string, string | null>([...working].map(([p, w]) => [p, w.text]));
  const reviewedHashes = new Map([...reviewed].map(([p, texts]) => [p, texts.map(fileHash)]));
  last = { base, entries, config: cfg.config, flows, notRun, tests, accepted, notes, texts, compareLine, reviewedHashes };
  return last;
}

// CI inputs changed since the merge base (26.12): workflows, and the package
// files whose rough-ride lines are compared.
function ciChanges(root: string, base: ReviewedBase | null): { workflows: string[]; packages: string[] } {
  if (!base) return { workflows: [], packages: [] };
  const changed = git(['diff', '--name-only', '-z', base.mergeBase, '--', '.github/workflows', 'package.json', 'package-lock.json'], root).stdout.split('\0').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--', '.github/workflows'], root).stdout.split('\0').filter(Boolean);
  const all = [...new Set([...changed, ...untracked])].sort();
  return { workflows: all.filter((p) => p.startsWith('.github/workflows/')), packages: all.filter((p) => !p.startsWith('.github/workflows/')) };
}

// CI inputs (26.12): listed, never judged.
function ciInputs(root: string, ci: { workflows: string[]; packages: string[] }, versions: ReviewedVersions): ProtectedEntry[] {
  const out: ProtectedEntry[] = [];
  for (const p of [...ci.workflows, ...ci.packages].sort()) {
    if (p.startsWith('.github/workflows/')) {
      out.push({ path: p, kind: 'ci', by: null, change: 'CI workflow changed', weakening: false, used: 'working-tree', notApplied: [], outcome: 'listed, not judged' });
      continue;
    }
    const before = versions.bytes(p)[0]?.toString('utf8') ?? '';
    let now = '';
    try {
      now = readFileSync(path.join(root, p), 'utf8');
    } catch {
      // Deleted.
    }
    const pins = (text: string) => text.split('\n').filter((l) => l.includes('rough-ride')).join('\n');
    if (pins(before) !== pins(now)) out.push({ path: p, kind: 'ci', by: null, change: 'the rough-ride pin changed', weakening: false, used: 'working-tree', notApplied: [], outcome: 'listed, not judged' });
  }
  return out;
}

// Protected files rewritten during the run (by `reset` or the dev server) are not used (26.9).
export function changedDuringRun(folderDir: string, texts: Map<string, string | null>): Note | null {
  const changed: string[] = [];
  for (const [p, text] of texts) {
    let now: string | null = null;
    try {
      now = readFileSync(path.join(folderDir, p), 'utf8');
    } catch {
      now = null;
    }
    if (now !== text) changed.push(`.rough-ride/${p}`);
  }
  return changed.length > 0 ? { id: 'changed-during-run', text: `Changed during this run, not used: ${changed.join(', ')}.` } : null;
}

// Node loading extra code into the runner (26.12): a disclosure, not a stop.
export function extraNodeCodeNote(execArgv: string[], nodeOptions: string | undefined): Note | null {
  const flags = /^(--require|-r|--import|--loader|--experimental-loader)(=|$)/;
  const find = (args: string[]) => {
    for (const [i, a] of args.entries()) {
      if (flags.test(a)) return a.includes('=') ? a.replace('=', ' ') : `${a} ${args[i + 1] ?? ''}`.trim();
    }
    return null;
  };
  const fromArgv = find(execArgv);
  const fromEnv = find((nodeOptions ?? '').split(/\s+/).filter(Boolean));
  const hit = fromArgv ? `${fromArgv} from the command line` : fromEnv ? `${fromEnv} from NODE_OPTIONS` : null;
  return hit ? { id: 'extra-node-code', text: `Node loads extra code into rough-ride (${hit}); code loaded this way could change its verdicts.` } : null;
}

// ---- The Protected files block (26.10).

export function blockLines(result: ProtectedResult): string[] {
  if (result.entries.length === 0) return [];
  const ref = result.base ? `${result.base.shown} (${result.base.mergeBase.slice(0, 7)})` : 'the base branch';
  return [
    `Protected files changed since ${ref}:`,
    ...ordered(result.entries).map((e) => `  ${e.path}: ${e.change} -> ${e.outcome}${e.by ? ` (${e.by})` : ''}`),
  ];
}

// The block plus each entry's hint, as report.txt prints it (also each
// document's `protectedLines`).
export function blockWithHints(result: ProtectedResult): string[] {
  const lines = blockLines(result);
  if (lines.length === 0) return lines;
  return [lines[0]!, ...ordered(result.entries).flatMap((e) => [`  ${e.path}: ${e.change} -> ${e.outcome}${e.by ? ` (${e.by})` : ''}`, ...(e.hint ? [`    ${e.hint}`] : [])])];
}

function ordered(entries: ProtectedEntry[]): ProtectedEntry[] {
  const group = (e: ProtectedEntry) => (e.used !== 'working-tree' || e.notApplied.length > 0 ? 0 : e.kind === 'ci' ? 1 : 2);
  return [...entries].sort((a, b) => group(a) - group(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// The summary's section: at most 4 lines, one line when everything ran as written.
export function summaryLines(result: ProtectedResult): string[] {
  if (result.entries.length === 0) return [];
  const asWritten = result.entries.every((e) => e.used === 'working-tree' && e.notApplied.length === 0);
  const ref = result.base?.shown ?? 'the base branch';
  if (asWritten) {
    const n = result.entries.length;
    return [`Protected files: ${n} ${n === 1 ? 'change' : 'changes'} since ${ref}, used as written (report.txt)`];
  }
  const lines = blockLines(result);
  if (lines.length <= 4) return lines;
  return [...lines.slice(0, 3), `  +${lines.length - 3} more changes (report.txt)`];
}

// report.txt's section 3: the compare line and the full block.
export function reportLines(result: ProtectedResult): string[] {
  return [...(result.compareLine ? [result.compareLine] : []), ...blockWithHints(result)];
}

export function protectedJson(result: ProtectedResult): Record<string, unknown>[] {
  return result.entries.map((e) => ({ path: e.path, kind: e.kind, change: e.change, weakening: e.weakening, by: e.by, used: e.used, notApplied: e.notApplied }));
}
