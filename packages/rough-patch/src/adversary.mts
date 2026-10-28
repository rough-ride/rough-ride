// What `plan` hands the adversary (spec part 11 section 43): the spec files a
// person wrote, the instruction-file line, and the ASCII views under
// runs/<id>/adversary/. The runner writes every file there; the adversary
// writes none.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Diff } from './diff.mjs';
import type { FolderState } from './folder.mjs';
import type { Note } from './output.mjs';
import type { NuxtRoute } from './tracing.mjs';
import { writeAtomic } from './write.mjs';

const SPEC_NAME = /^[a-z0-9][a-z0-9-]{0,47}\.txt$/;
const SPEC_TOTAL = 32 * 1024;
export const NO_SPEC_HINT = "For app-specific checks, write what you asked for in .rough-patch/specs/<name>.txt yourself (agents can't write there) and run again.";

export interface SpecPart {
  name: string;
  sha256: string;
  bytes: number;
  text: string;
}

// Rounded up to a tenth, so a short file never reads 0.0 KB.
const kb = (n: number) => `${(Math.ceil(n / 102.4) / 10).toFixed(1)} KB`;

// Each path's bytes at each revision, from one `git cat-file --batch` call; null when absent.
function blobsAt(root: string, revs: string[], paths: string[]): Map<string, (Buffer | null)[]> {
  const out = new Map<string, (Buffer | null)[]>(paths.map((p) => [p, revs.map(() => null)]));
  if (paths.length === 0 || revs.length === 0) return out;
  const queries = paths.flatMap((p) => revs.map((r) => `${r}:${p}`));
  const result = spawnSync('git', ['--no-optional-locks', 'cat-file', '--batch'], { cwd: root, input: queries.join('\n') + '\n', maxBuffer: 64 * 1024 * 1024 });
  const buf = result.stdout ?? Buffer.alloc(0);
  let at = 0;
  for (const q of queries) {
    const nl = buf.indexOf(10, at);
    if (nl === -1) break;
    const header = buf.subarray(at, nl).toString('utf8');
    at = nl + 1;
    const m = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!m) continue;
    const size = Number(m[1]);
    const [p, r] = [q.slice(q.indexOf(':') + 1), q.slice(0, q.indexOf(':'))];
    out.get(p)![revs.indexOf(r)] = buf.subarray(at, at + size);
    at += size + 1;
  }
  return out;
}

export function decodeUtf8(bytes: Buffer): string | null {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.replace(/^﻿/, '').replace(/\r\n/g, '\n').normalize('NFC');
  } catch {
    return null;
  }
}

// 43.1: every spec file whose bytes match neither reviewed version, in name
// order, up to 32 KB in total, with its header lines.
export function readSpecs(root: string, folder: FolderState, reviewed: string[], baseShown: string): { parts: SpecPart[]; notes: Note[] } {
  const dir = path.join(folder.dir, 'specs');
  let names: string[] = [];
  try {
    names = readdirSync(dir).sort();
  } catch {
    names = [];
  }
  const notes: Note[] = [];
  const candidates: string[] = [];
  for (const name of names) {
    let stat;
    try {
      stat = lstatSync(path.join(dir, name));
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.nlink > 1) continue;
    if (!SPEC_NAME.test(name)) {
      notes.push({ id: 'ignored', text: `Ignored: .rough-patch/specs/${name} (rough-patch reads only <name>.txt files)` });
      continue;
    }
    candidates.push(name);
  }
  const rel = path.relative(root, dir).split(path.sep).join('/');
  const blobs = blobsAt(root, reviewed, candidates.map((n) => `${rel}/${n}`));
  const parts: SpecPart[] = [];
  let total = 0;
  for (const name of candidates) {
    const bytes = readFileSync(path.join(dir, name));
    const before = blobs.get(`${rel}/${name}`) ?? [];
    if (before.some((b) => b !== null && b.equals(bytes))) continue;
    const text = decodeUtf8(bytes);
    if (text === null) {
      notes.push({ id: 'ignored', text: `Ignored: .rough-patch/specs/${name} (not UTF-8 text)` });
      continue;
    }
    const size = Buffer.byteLength(text);
    if (total + size > SPEC_TOTAL) {
      notes.push({ id: 'spec', text: `Spec cut: .rough-patch/specs/${name} (over 32 KB in total)` });
      continue;
    }
    total += size;
    const isNew = before.every((b) => b === null);
    notes.push({ id: 'spec', text: `Spec: .rough-patch/specs/${name} (${isNew ? 'new' : 'changed'} since ${baseShown}, ${kb(size)})` });
    parts.push({ name, sha256: createHash('sha256').update(text).digest('hex'), bytes: size, text });
  }
  if (parts.length === 0) {
    notes.push({ id: 'spec', text: `Spec: none (.rough-patch/specs/ has no file that is new or changed since ${baseShown}): only generic checks judge this run.` });
    notes.push({ id: 'spec', text: NO_SPEC_HINT });
  }
  return { parts, notes };
}

const INSTRUCTION = /(^|\/)(CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md)$|(^|\/)\.claude\//;

// 43.6: instruction files below the root that changed since the reviewed version.
export function instructionNotes(diff: Diff, baseShown: string): Note[] {
  return diff.files
    .filter((f) => f.status !== 'deleted' && f.path.includes('/') && INSTRUCTION.test(f.path) && !/^\.claude\//.test(f.path))
    .map((f) => ({
      id: 'instruction-file',
      text: `Instruction file below the root changed since ${baseShown}: ${f.path}. Claude Code loads it into the adversary when it reads files in ${path.posix.dirname(f.path)}/, so its text could steer the adversary.`,
    }));
}

// JSON with every code unit outside printable ASCII escaped (43.3, 43.5).
export function asciiJson(text: string): string {
  return text.replace(/[^\x20-\x7e\n]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// One array entry per line, so Read can page through it (43.3).
export function linedJson(value: unknown): string {
  const render = (v: unknown, depth: number): string => {
    const pad = '  '.repeat(depth);
    if (Array.isArray(v)) return v.length === 0 ? '[]' : `[\n${v.map((x) => `${pad}  ${JSON.stringify(x)}`).join(',\n')}\n${pad}]`;
    if (v && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      return entries.length === 0 ? '{}' : `{\n${entries.map(([k, x]) => `${pad}  ${JSON.stringify(k)}: ${render(x, depth + 1)}`).join(',\n')}\n${pad}}`;
    }
    return JSON.stringify(v);
  };
  return asciiJson(render(value, 0)) + '\n';
}

// Each file's [first, last] line range in diff.patch, 1-based: from its
// `diff --git` or `# <path>:` line to the line before the next section.
export function patchRanges(patch: Buffer): Map<string, [number, number]> {
  const lines = patch.toString('latin1').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const starts: { file: string; at: number }[] = [];
  for (const [i, line] of lines.entries()) {
    const m = /^diff --git a\/.+ b\/(.+)$/.exec(line) ?? /^# (.+?): /.exec(line);
    if (m) starts.push({ file: Buffer.from(m[1]!, 'latin1').toString('utf8'), at: i + 1 });
  }
  const ranges = new Map<string, [number, number]>();
  for (const [k, { file, at }] of starts.entries()) {
    const last = k + 1 < starts.length ? starts[k + 1]!.at - 1 : lines.length;
    const r = ranges.get(file);
    ranges.set(file, r ? [r[0], last] : [at, last]);
  }
  return ranges;
}

export interface NeedsFlow {
  id: string;
  page: string;
  file: string;
  entry: string | null;
  source: 'page-trace' | 'link';
}

// 12.8 item 1: Nuxt pages whose import closure holds a changed file no saved flow reached.
export function needsFlowItems(routes: NuxtRoute[] | null, changed: string[], reached: Set<string>): NeedsFlow[] {
  if (!routes) return [];
  const items: NeedsFlow[] = [];
  for (const route of routes) {
    for (const file of route.closure.filter((f) => changed.includes(f) && !reached.has(f)).sort()) {
      items.push({ id: `n${items.length + 1}`, page: route.path, file, entry: null, source: 'page-trace' });
    }
  }
  return items;
}

export interface AdversaryViews {
  diffMap: Record<string, unknown>;
  patch: Buffer;
  needsFlow: NeedsFlow[];
  selection: Record<string, unknown>;
  specs: SpecPart[];
}

// The adversary's views; selection.json is written (and hashed) by the caller.
export function writeAdversaryFolder(folder: FolderState, runId: string, views: AdversaryViews): void {
  const ranges = patchRanges(views.patch);
  const files = ((views.diffMap.files as { path: string }[] | undefined) ?? []).map((f) => ({ ...f, patch: ranges.get(f.path) ?? null }));
  writeAtomic(folder, ['runs', runId, 'adversary', 'diff-map.json'], linedJson({ ...views.diffMap, files, needsFlow: views.needsFlow }));
  writeAtomic(folder, ['runs', runId, 'adversary', 'diff.patch'], views.patch);
  writeAtomic(folder, ['runs', runId, 'adversary', 'spec.json'], linedJson({ parts: views.specs }));
}
