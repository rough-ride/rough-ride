// The checksum manifest (spec part 6 section 27): what rough-patch itself
// wrote, kept in <git dir>/.rough-patch/manifest.json. Saved copies sit beside
// it as copies/<sha256>.yaml. A failed write is a warning, never a stop, and
// nothing under the git dir outside .rough-patch/ is ever touched.

import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canon } from '../hooks/path-check.mjs';
import { stopWith } from './exit.mjs';
import { git } from './git.mjs';
import { canonicalJson, type Note } from './output.mjs';

export interface SavedEntry {
  branch: string;
  // Relative to .rough-patch/: `tests/create-note-500-a41f0c.yaml`.
  path: string;
  sha256: string;
  by: 'flow save' | 'runner';
  run: string;
  runner: string;
  at: string;
}

export interface ManifestData {
  version: 1;
  saved: SavedEntry[];
  runs: Record<string, Record<string, string>>;
  tests: Record<string, { outcome: string; run: string; at: string }>;
}

const empty = (): ManifestData => ({ version: 1, saved: [], runs: {}, tests: {} });

// sha256 over the stored bytes, after a leading BOM is removed and CRLF becomes LF (27.3).
export function fileHash(text: string): string {
  return createHash('sha256').update(text.replace(/^﻿/, '').replace(/\r\n/g, '\n')).digest('hex');
}

// Read-back run output: the sha256 of the canonical JSON of its parsed value.
export function valueHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

// A real folder or plain file with one link; never a symlink.
function plain(p: string, dir: boolean): boolean {
  try {
    const st = lstatSync(p);
    return !st.isSymbolicLink() && (dir ? st.isDirectory() : st.isFile() && st.nlink === 1);
  } catch {
    return false;
  }
}

export class Manifest {
  data: ManifestData = empty();
  notes: Note[] = [];
  writable = true;
  readonly dir: string | null;
  readonly branch: string | null;

  constructor(root: string) {
    const gitDir = git(['rev-parse', '--absolute-git-dir'], root);
    this.dir = gitDir.status === 0 ? path.join(canon(gitDir.stdout.trim()), '.rough-patch') : null;
    const head = git(['symbolic-ref', '--quiet', 'HEAD'], root);
    this.branch = head.status === 0 ? head.stdout.trim() : null;
    if (this.dir) this.read();
  }

  get file(): string | null {
    return this.dir ? path.join(this.dir, 'manifest.json') : null;
  }

  private read(): void {
    const dir = this.dir!;
    let exists = true;
    try {
      lstatSync(dir);
    } catch {
      exists = false;
    }
    if (!exists) return;
    const unreadable = (why: string) => {
      this.notes.push({ id: 'manifest', text: `Checksum manifest unreadable (${why}): changes to files not yet merged are only listed, and earlier run output can't be re-run.` });
      this.data = empty();
    };
    if (!plain(dir, true)) return unreadable(`${dir} is not a real folder`);
    try {
      lstatSync(this.file!);
    } catch {
      return;
    }
    if (!plain(this.file!, false)) return unreadable('manifest.json is not a plain file');
    try {
      const parsed = JSON.parse(readFileSync(this.file!, 'utf8')) as ManifestData;
      if (parsed?.version !== 1) return unreadable(`version ${String(parsed?.version)}`);
      this.data = { version: 1, saved: parsed.saved ?? [], runs: parsed.runs ?? {}, tests: parsed.tests ?? {} };
    } catch (error) {
      unreadable(String((error as Error).message).split('\n')[0]!.slice(0, 80));
    }
  }

  private writeFile(name: string, data: string): boolean {
    if (!this.dir || !this.writable) return false;
    try {
      try {
        lstatSync(this.dir);
      } catch {
        mkdirSync(this.dir);
      }
      if (!plain(this.dir, true)) {
        const error = new Error('not a real folder') as NodeJS.ErrnoException;
        error.code = 'ELINK';
        throw error;
      }
      const target = path.join(this.dir, name);
      try {
        if (lstatSync(target).isSymbolicLink()) {
          const error = new Error('a link') as NodeJS.ErrnoException;
          error.code = 'ELINK';
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      mkdirSync(path.dirname(target), { recursive: true });
      const tmp = path.join(path.dirname(target), `tmp-${randomBytes(4).toString('hex')}${path.extname(target)}`);
      writeFileSync(tmp, data, { flag: 'wx' });
      try {
        renameSync(tmp, target);
      } catch (error) {
        unlinkSync(tmp);
        throw error;
      }
      return true;
    } catch (error) {
      this.writable = false;
      this.notes.push({ id: 'manifest', text: `Checksum manifest: can't write ${this.file} (${(error as NodeJS.ErrnoException).code ?? 'error'}). Saved copies and run-output checks are off for this run.` });
      return false;
    }
  }

  save(): void {
    this.writeFile('manifest.json', JSON.stringify(this.data, null, 2) + '\n');
  }

  // A read-back run-output file's hash, in the same step as its write.
  recordRun(runId: string, file: string, value: unknown): void {
    (this.data.runs[runId] ??= {})[file] = valueHash(value);
    this.save();
  }

  // Altered or unknown run output is refused with exit 75 (27.6).
  verifyRun(runId: string, file: string, value: unknown, label: string, again: string): void {
    if (this.data.runs[runId]?.[file] !== valueHash(value)) {
      stopWith('refused-run-output', `Refused: run ${runId}'s ${label} changed after rough-patch wrote it, or this worktree has no record of it. Run ${again} again.`);
    }
  }

  // A saved copy of a flow or test rough-patch wrote, on this branch (26.8).
  saveCopy(rel: string, text: string, by: SavedEntry['by'], run: string, runner: string): void {
    if (!this.branch) return;
    const sha = fileHash(text);
    if (!this.writeFile(path.join('copies', `${sha}.yaml`), text.replace(/^﻿/, '').replace(/\r\n/g, '\n'))) return;
    this.data.saved = this.data.saved.filter((e) => !(e.branch === this.branch && e.path === rel));
    this.data.saved.push({ branch: this.branch, path: rel, sha256: sha, by, run, runner, at: new Date().toISOString() });
    this.save();
  }

  // Whether this run has a hash recorded for `file`.
  hasRun(runId: string, file: string): boolean {
    return this.data.runs[runId]?.[file] !== undefined;
  }

  entry(rel: string): SavedEntry | null {
    if (!this.branch) return null;
    return this.data.saved.find((e) => e.branch === this.branch && e.path === rel) ?? null;
  }

  // The saved copy's text, or null when there is none or its content doesn't match its name.
  savedCopy(rel: string): { text: string; entry: SavedEntry } | null {
    const entry = this.entry(rel);
    if (!entry || !this.dir) return null;
    const file = path.join(this.dir, 'copies', `${entry.sha256}.yaml`);
    if (!plain(file, false)) return null;
    const text = readFileSync(file, 'utf8');
    return fileHash(text) === entry.sha256 ? { text, entry } : null;
  }

  // 26.10's attribution label for a working copy.
  label(rel: string, working: string | null): string {
    const entry = this.entry(rel);
    if (entry && working !== null && fileHash(working) === entry.sha256) return entry.by === 'flow save' ? 'saved by flow save' : 'written by rough-patch';
    return 'changed outside rough-patch';
  }

  // Drops entries whose branch is gone or whose file equals a reviewed version, and runs whose folders are gone.
  prune(root: string, equalsReviewed: (rel: string, sha: string) => boolean, runIds: Set<string>): void {
    const branches = new Set(git(['for-each-ref', '--format=%(refname)', 'refs/heads'], root).stdout.split('\n').filter(Boolean));
    const before = JSON.stringify(this.data);
    this.data.saved = this.data.saved.filter((e) => branches.has(e.branch) && !equalsReviewed(e.path, e.sha256));
    for (const id of Object.keys(this.data.runs)) if (!runIds.has(id)) delete this.data.runs[id];
    if (JSON.stringify(this.data) !== before) this.save();
  }
}
