// Protected files and reviewed versions (spec part 6 section 26, ADR 0003).
// A weakening change to a flow, test, config.yaml or accepted.yaml counts only
// once it is merged into the default branch: until then the reviewed version
// runs. Saved copies and attribution labels come in ticket 32.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { Config } from './config.mjs';
import { reflogMessage, reviewedBase, type ReviewedBase } from './diff.mjs';
import type { CheckedFiles } from './files.mjs';
import { describeLocator, type Flow, type LocatorSpec, type Step } from './flowrun.mjs';
import { compareVersions, FORMATS, type FormatKind } from './formats.mjs';
import { git } from './git.mjs';
import { fileHash, type Manifest } from './manifest.mjs';
import { canonicalJson, type Note } from './output.mjs';
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
  // The four root instruction files at the merge base, when asked for (40.4);
  // null when not asked for or there is no merge base.
  instructionBase: Map<string, Buffer | null> | null;
}

// ---- Reading: one `git cat-file --batch` for every reviewed version (26.3).

export function catFileBatch(root: string, specs: string[]): Map<string, string | null> {
  return new Map([...catFileBatchRaw(root, specs)].map(([spec, bytes]) => [spec, bytes === null ? null : bytes.toString('utf8')]));
}

// The same read, keeping each blob's bytes.
export function catFileBatchRaw(root: string, specs: string[]): Map<string, Buffer | null> {
  const out = new Map<string, Buffer | null>();
  if (specs.length === 0) return out;
  const result = spawnSync('git', ['--no-optional-locks', 'cat-file', '--batch'], { cwd: root, input: specs.join('\n') + '\n', maxBuffer: 256 * 1024 * 1024 });
  const buf = result.stdout ?? Buffer.alloc(0);
  let at = 0;
  for (const spec of specs) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) break;
    const header = buf.subarray(at, nl).toString('utf8');
    at = nl + 1;
    const m = /^\S+ (\S+) (\d+)$/.exec(header);
    if (!m) {
      out.set(spec, null);
      continue;
    }
    const size = Number(m[2]);
    out.set(spec, m[1] === 'blob' ? buf.subarray(at, at + size) : null);
    at += size + 1;
  }
  return out;
}

function parsed(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return parse(text.replace(/^﻿/, ''), { uniqueKeys: true });
  } catch {
    return undefined;
  }
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
  if (canon(working) === canon(reviewed)) return { kind: 'same', reformatted: workingText !== reviewedText };
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

// ---- The comparison for one invocation.

export interface CompareOptions {
  root: string;
  folderDir: string;
  files: CheckedFiles;
  env: NodeJS.ProcessEnv;
  pluginData: boolean;
  mode?: 'tier' | 'regress';
  manifest?: Manifest;
  // Contract detection: these git-root-relative paths join the same read at the merge base.
  instructionPaths?: readonly string[];
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
  const base = reviewedBase(root, options.env, options.pluginData, options.mode);
  const notes: Note[] = [];
  const working = new Map<string, { text: string; value: unknown; kind: FormatKind; step5: string[] }>();
  for (const f of [files.config, files.accepted, ...files.flows, ...files.tests].filter((x): x is NonNullable<typeof x> => !!x)) {
    working.set(f.shown.replace(/^\.rough-ride\//, ''), { text: f.text, value: f.value, kind: f.kind, step5: f.step5 });
  }
  // Reviewed versions: at the merge base, and at the base ref's own commit when it differs.
  const reviewed = new Map<string, { merge: string | null; ref: string | null }>();
  let instructionBase: Map<string, Buffer | null> | null = null;
  if (base) {
    const listed = new Set<string>();
    for (const sha of new Set([base.mergeBase, base.refSha])) {
      const ls = git(['ls-tree', '-r', '--name-only', '-z', sha, '--', `${rel}/`], root);
      for (const p of ls.stdout.split('\0').filter(Boolean)) {
        const inner = p.slice(rel.length + 1);
        if (PROTECTED.test(inner)) listed.add(inner);
      }
    }
    for (const p of working.keys()) listed.add(p);
    const paths = [...listed].sort();
    const specs = paths.flatMap((p) => [`${base.mergeBase}:${rel}/${p}`, ...(base.refSha !== base.mergeBase ? [`${base.refSha}:${rel}/${p}`] : [])]);
    const instructionSpecs = (options.instructionPaths ?? []).map((p) => `${base.mergeBase}:${p}`);
    const raw = catFileBatchRaw(root, [...specs, ...instructionSpecs]);
    const blobs = (spec: string) => {
      const bytes = raw.get(spec);
      return bytes === undefined || bytes === null ? null : bytes.toString('utf8');
    };
    for (const p of paths) reviewed.set(p, { merge: blobs(`${base.mergeBase}:${rel}/${p}`), ref: base.refSha !== base.mergeBase ? blobs(`${base.refSha}:${rel}/${p}`) : null });
    if (options.instructionPaths) instructionBase = new Map(options.instructionPaths.map((p) => [p, raw.get(`${base.mergeBase}:${p}`) ?? null]));
  }
  const refShown = base?.shown ?? 'the base branch';
  const entries: ProtectedEntry[] = [];
  const kindOf = (p: string): FormatKind => (p === 'config.yaml' ? 'config' : p === 'accepted.yaml' ? 'accepted' : p.startsWith('flows/') ? 'flow' : 'tests');
  const reviewedValues = (p: string) => {
    const r = reviewed.get(p);
    return [r?.merge ?? null, r?.ref ?? null].filter((t): t is string => t !== null).map((text) => ({ text, value: parsed(text) }));
  };
  // A reviewed version below this runner's floor can't be compared: W runs.
  const belowFloor = (p: string, value: unknown) => {
    const schema = isObject(value) && typeof value.schema === 'string' ? value.schema : null;
    return schema !== null && compareVersions(schema, FORMATS[kindOf(p)].floor) < 0 ? schema : null;
  };

  // Flows.
  const flows: EffectiveFlow[] = [];
  const notRun: string[] = [];
  // Files rough-ride saved on this branch count too, so a deleted one is noticed.
  const savedPaths = (options.manifest?.data.saved ?? []).filter((e) => e.branch === options.manifest?.branch).map((e) => e.path);
  const flowPaths = [...new Set([...working.keys(), ...reviewed.keys(), ...savedPaths])].filter((p) => p.startsWith('flows/')).sort();
  const toFlow = (p: string, v: Record<string, unknown>): Flow => ({ name: p.slice('flows/'.length).replace(/\.yaml$/, ''), signedIn: v.signedIn as boolean, steps: v.steps as Step[] });
  for (const p of flowPaths) {
    const w = working.get(p);
    const rs = reviewedValues(p).filter((r) => isObject(r.value));
    const add = (e: Omit<ProtectedEntry, 'path' | 'kind' | 'by'>) => entries.push({ path: p, kind: 'flow', by: null, ...e });
    const wValid = w && isObject(w.value) && w.step5.length === 0;
    if (rs.length === 0) {
      // No reviewed version: the copy rough-ride saved on this branch runs when W is gone or weakens it (26.8).
      const saved = options.manifest?.savedCopy(p);
      const sv = saved ? parsed(saved.text) : undefined;
      if (saved && isObject(sv)) {
        const change = !wValid ? null : compareFlow(w!.value as Record<string, unknown>, sv, w!.text, saved.text);
        if (!wValid || change!.kind === 'weakened') {
          flows.push({ flow: toFlow(p, sv), used: 'saved-copy', reviewed: false, stepsChanged: null });
          add({ change: w ? `${change && 'text' in change ? change.text : 'invalid'} after rough-ride wrote it (run ${saved.entry.run})` : `deleted after rough-ride wrote it (run ${saved.entry.run})`, weakening: true, used: 'saved-copy', notApplied: [], outcome: 'ran the saved copy', hint: REMOVE_HINT });
          continue;
        }
      }
      if (wValid) {
        flows.push({ flow: toFlow(p, w!.value as Record<string, unknown>), used: 'working-tree', reviewed: false, stepsChanged: null });
        if (base) add({ change: 'new, no reviewed version', weakening: false, used: 'working-tree', notApplied: [], outcome: 'ran this version' });
      } else if (w) notRun.push(toFlow(p, {}).name);
      continue;
    }
    const r = rs[0]!;
    const floor = belowFloor(p, r.value);
    if (floor && wValid) {
      flows.push({ flow: toFlow(p, w!.value as Record<string, unknown>), used: 'working-tree', reviewed: true, stepsChanged: null });
      add({ change: `the ${refShown} version is in a format this runner can't read (schema ${floor}), so this version is used`, weakening: false, used: 'working-tree', notApplied: [], outcome: 'ran this version' });
      continue;
    }
    const reviewedFlow = toFlow(p, r.value as Record<string, unknown>);
    if (!w || !wValid) {
      flows.push({ flow: reviewedFlow, used: 'reviewed', reviewed: true, stepsChanged: null });
      add({ change: w ? 'invalid' : 'deleted', weakening: true, used: 'reviewed', notApplied: [], outcome: `ran the ${refShown} version` });
      continue;
    }
    const wv = w.value as Record<string, unknown>;
    // The best outcome against either reviewed version.
    const changes = rs.map((x) => compareFlow(wv, x.value as Record<string, unknown>, w.text, x.text));
    const order = ['same', 'expects-added', 'steps-changed', 'weakened'];
    const best = changes.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0]!;
    if (best.kind === 'same') {
      flows.push({ flow: toFlow(p, wv), used: 'working-tree', reviewed: true, stepsChanged: null });
      if (best.reformatted) add({ change: 'reformatted (same content)', weakening: false, used: 'working-tree', notApplied: [], outcome: 'ran this version' });
    } else if (best.kind === 'expects-added') {
      flows.push({ flow: toFlow(p, wv), used: 'working-tree', reviewed: true, stepsChanged: null });
      add({ change: best.text, weakening: false, used: 'working-tree', notApplied: [], outcome: 'ran this version' });
    } else if (best.kind === 'steps-changed') {
      const entry: ProtectedEntry = { path: p, kind: 'flow', by: null, change: best.text, weakening: true, used: 'reviewed', notApplied: [], outcome: `ran the ${refShown} version` };
      entries.push(entry);
      flows.push({ flow: reviewedFlow, used: 'reviewed', reviewed: true, stepsChanged: { working: toFlow(p, wv), entry } });
    } else {
      flows.push({ flow: reviewedFlow, used: 'reviewed', reviewed: true, stepsChanged: null });
      add({ change: best.text, weakening: true, used: 'reviewed', notApplied: [], outcome: `ran the ${refShown} version` });
    }
  }

  // Tests.
  const tests: ProtectedResult['tests'] = [];
  const testPaths = [...new Set([...working.keys(), ...reviewed.keys(), ...savedPaths])].filter((p) => p.startsWith('tests/')).sort();
  for (const p of testPaths) {
    const w = working.get(p);
    const r = reviewedValues(p).find((x) => isObject(x.value));
    const name = p.slice('tests/'.length).replace(/\.yaml$/, '');
    const add = (e: Omit<ProtectedEntry, 'path' | 'kind' | 'by'>) => entries.push({ path: p, kind: 'tests', by: null, ...e });
    const wValid = w && isObject(w.value) && w.step5.length === 0;
    if (!r) {
      const saved = options.manifest?.savedCopy(p);
      const sv = saved ? parsed(saved.text) : undefined;
      if (saved && isObject(sv) && (!wValid || !compareTest(w!.value as Record<string, unknown>, sv).asWritten)) {
        tests.push({ name, value: sv, used: 'saved-copy', pending: false });
        add({ change: w ? `${wValid ? compareTest(w.value as Record<string, unknown>, sv).text : 'invalid'} after rough-ride wrote it (run ${saved.entry.run})` : `deleted after rough-ride wrote it (run ${saved.entry.run})`, weakening: true, used: 'saved-copy', notApplied: [], outcome: 'ran the saved copy', hint: REMOVE_HINT });
        continue;
      }
      if (wValid) tests.push({ name, value: w!.value as Record<string, unknown>, used: 'working-tree', pending: false });
      else if (w) add({ change: 'invalid, no reviewed version (stale)', weakening: false, used: 'none', notApplied: [], outcome: 'not run' });
      continue;
    }
    if (!wValid) {
      tests.push({ name, value: r.value as Record<string, unknown>, used: 'reviewed', pending: true });
      add({ change: w ? 'invalid' : 'deleted', weakening: true, used: 'reviewed', notApplied: [], outcome: `ran the ${refShown} version (pending until merged)` });
      continue;
    }
    const c = compareTest(w!.value as Record<string, unknown>, r.value as Record<string, unknown>);
    if (c.asWritten) {
      tests.push({ name, value: w!.value as Record<string, unknown>, used: 'working-tree', pending: false });
      if (canon(w!.value) !== canon(r.value) || w!.text !== r.text) add({ change: c.text, weakening: false, used: 'working-tree', notApplied: [], outcome: 'ran this version' });
    } else {
      tests.push({ name, value: r.value as Record<string, unknown>, used: 'reviewed', pending: true });
      add({ change: c.text, weakening: true, used: 'reviewed', notApplied: [], outcome: `ran the ${refShown} version (pending until merged)` });
    }
  }

  // accepted.yaml: entries added since R wait; removed ones stop at once; no R applies none.
  const identity = (e: unknown) => (isObject(e) ? canon({ page: e.page, step: e.step, action: e.action, check: e.check }) : '');
  const wAccepted = working.get('accepted.yaml');
  const rAccepted = reviewedValues('accepted.yaml').find((x) => isObject(x.value));
  const wEntries = isObject(wAccepted?.value) && Array.isArray(wAccepted.value.accepted) ? wAccepted.value.accepted : [];
  const rIds = new Set((isObject(rAccepted?.value) && Array.isArray(rAccepted.value.accepted) ? rAccepted.value.accepted : []).map(identity));
  const accepted = wEntries.filter((e) => rIds.has(identity(e))) as Record<string, unknown>[];
  const waiting = wEntries.filter((e) => !rIds.has(identity(e)));
  if (waiting.length > 0) {
    const shownEntry = (e: unknown) => (isObject(e) ? `${String(e.page)} ${String(e.step)} ${String(e.action)} ${String(e.check)}` : '?');
    entries.push({ path: 'accepted.yaml', kind: 'accepted', by: null, change: `adds ${waiting.length} ${waiting.length === 1 ? 'entry' : 'entries'}`, weakening: true, used: 'reviewed', notApplied: waiting.map((e) => `Accepted outside review, not applied until merged: ${shownEntry(e)}.`), outcome: 'not applied until merged' });
  }

  // config.yaml.
  const rConfig = reviewedValues('config.yaml').find((x) => isObject(x.value));
  const cfg = effectiveConfig((files.config?.value ?? null) as Config | null, (rConfig?.value ?? null) as Config | null, refShown);
  for (const e of cfg.entries) entries.push({ path: 'config.yaml', kind: 'config', by: null, ...e });
  if (files.config && rConfig && canon(files.config.value) === canon(rConfig.value) && files.config.text !== rConfig.text) {
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
  entries.push(...ciInputs(root, base));

  // The protected-trust note (26.3).
  let compareLine = '';
  if (!base) {
    notes.push({ id: 'protected-trust', text: 'Protected files: no reviewed version (no base branch found). Files are used as they are.' });
  } else if (base.local) {
    notes.push({ id: 'protected-trust', text: `Protected files compared with local ${base.shown} (no remote). Commits on ${base.shown} count as reviewed, so rough-ride can't tell your commits there from an agent's.` });
  } else {
    compareLine = `Protected files compared with ${base.shown} (${base.mergeBase.slice(0, 7)}).`;
    const message = reflogMessage(root, base.ref);
    // git writes `fetch: ...`, `pull: ...`, `clone: ...` and `update by push`.
    if (message !== null && !/^(fetch|pull|push|clone|update by push)\b/.test(message)) {
      notes.push({ id: 'protected-trust', text: `${base.shown} was last moved by something other than fetch, pull or push: protected files may be compared with an unreviewed commit.` });
    }
  }
  const texts = new Map<string, string | null>([...working].map(([p, w]) => [p, w.text]));
  const reviewedHashes = new Map([...reviewed].map(([p, r]) => [p, [r.merge, r.ref].filter((t): t is string => t !== null).map(fileHash)]));
  last = { base, entries, config: cfg.config, flows, notRun, tests, accepted, notes, texts, compareLine, reviewedHashes, instructionBase };
  return last;
}

// CI inputs (26.12): listed, never judged.
function ciInputs(root: string, base: ReviewedBase | null): ProtectedEntry[] {
  if (!base) return [];
  const out: ProtectedEntry[] = [];
  const changed = git(['diff', '--name-only', '-z', base.mergeBase, '--', '.github/workflows', 'package.json', 'package-lock.json'], root).stdout.split('\0').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--', '.github/workflows'], root).stdout.split('\0').filter(Boolean);
  for (const p of [...new Set([...changed, ...untracked])].sort()) {
    if (p.startsWith('.github/workflows/')) {
      out.push({ path: p, kind: 'ci', by: null, change: 'CI workflow changed', weakening: false, used: 'working-tree', notApplied: [], outcome: 'listed, not judged' });
      continue;
    }
    const before = catFileBatch(root, [`${base.mergeBase}:${p}`]).get(`${base.mergeBase}:${p}`) ?? '';
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
