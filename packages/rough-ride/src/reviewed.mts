// Reviewed versions (spec part 6 section 26.3, ADR 0003): each path as it is
// at the merge base with the default branch, and at the base ref's own commit
// when that differs. Protected files, spec files and contract detection all
// read them here, from one `git cat-file --batch` call per invocation when
// they ask for their paths before the first read.

import { spawnSync } from 'node:child_process';
import { reflogMessage, reviewedBase, type ReviewedBase } from './diff.mjs';
import { git } from './git.mjs';

// The seam: git in production, an in-memory set of commits in tests
// (test/helpers.mjs memoryBlobs).
export interface BlobSource {
  // Paths under `dir` (git-root-relative, ending in `/`) at `commit`.
  list(commit: string, dir: string): string[];
  // Each `<commit>:<path>` blob's bytes; null when absent or not a blob.
  read(specs: string[]): Map<string, Buffer | null>;
  // The base ref's latest reflog message, or null when it has none.
  lastMove(ref: string): string | null;
}

export function gitBlobs(root: string): BlobSource {
  return {
    list: (commit, dir) => git(['ls-tree', '-r', '--name-only', '-z', commit, '--', dir], root).stdout.split('\0').filter(Boolean),
    read: (specs) => catFileBatch(root, specs),
    lastMove: (ref) => reflogMessage(root, ref),
  };
}

// One `git cat-file --batch` call. Every object's body is skipped by its
// size, so a tree or commit at a requested path keeps the later answers in step.
function catFileBatch(root: string, specs: string[]): Map<string, Buffer | null> {
  const out = new Map<string, Buffer | null>();
  if (specs.length === 0) return out;
  const result = spawnSync('git', ['--no-optional-locks', 'cat-file', '--batch'], { cwd: root, input: specs.join('\n') + '\n', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  const buf = result.stdout ?? Buffer.alloc(0);
  let at = 0;
  for (const spec of specs) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) break;
    const header = buf.subarray(at, nl).toString('utf8');
    at = nl + 1;
    // `<sha> <type> <size>`, or `<spec> missing` with no body.
    const m = /^[0-9a-f]+ ([a-z]+) (\d+)$/.exec(header);
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

// The one normalisation for comparing stored text (26.4, 27.3): a leading BOM
// removed and CRLF turned into LF. A checkout with core.autocrlf changes nothing.
export function normalisedText(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

export class ReviewedVersions {
  readonly base: ReviewedBase | null;
  // The merge base, then the base ref's own commit when it differs.
  readonly commits: string[];
  private readonly source: BlobSource;
  private readonly wanted = new Set<string>();
  private readonly blobs = new Map<string, Buffer | null>();

  constructor(source: BlobSource, base: ReviewedBase | null) {
    this.source = source;
    this.base = base;
    this.commits = base ? [...new Set([base.mergeBase, base.refSha])] : [];
  }

  // Paths under `dir` at any reviewed commit, sorted.
  list(dir: string): string[] {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    return [...new Set(this.commits.flatMap((c) => this.source.list(c, prefix)))].sort();
  }

  // Asks for paths ahead of the first read, so they join its single batch.
  want(paths: Iterable<string>): void {
    for (const p of paths) if (!this.blobs.has(this.spec(this.commits[0] ?? '', p))) this.wanted.add(p);
  }

  // Each path's bytes per reviewed commit, in `commits` order; null where absent.
  bytes(p: string): (Buffer | null)[] {
    this.want([p]);
    this.flush();
    return this.commits.map((c) => this.blobs.get(this.spec(c, p)) ?? null);
  }

  // The path's reviewed versions as UTF-8 text, absent ones left out.
  texts(p: string): string[] {
    return this.bytes(p).filter((b): b is Buffer => b !== null).map((b) => b.toString('utf8'));
  }

  // The bytes at the merge base only (contract detection, 40.4); null with no base.
  atMergeBase(paths: readonly string[]): Map<string, Buffer | null> | null {
    if (!this.base) return null;
    this.want(paths);
    return new Map(paths.map((p) => [p, this.bytes(p)[0] ?? null]));
  }

  // The base ref's latest reflog message, for the protected-trust note.
  lastMove(): string | null {
    return this.base ? this.source.lastMove(this.base.ref) : null;
  }

  private spec(commit: string, p: string): string {
    return `${commit}:${p}`;
  }

  private flush(): void {
    if (this.wanted.size === 0) return;
    const paths = [...this.wanted].sort();
    this.wanted.clear();
    const specs = paths.flatMap((p) => this.commits.map((c) => this.spec(c, p)));
    const read = this.source.read(specs);
    for (const s of specs) this.blobs.set(s, read.get(s) ?? null);
  }
}

// The production adapter: the base from 26.3's rules, blobs from git.
export function openReviewed(root: string, env: NodeJS.ProcessEnv, pluginData: boolean, mode: 'tier' | 'regress' = 'tier'): ReviewedVersions {
  return new ReviewedVersions(gitBlobs(root), reviewedBase(root, env, pluginData, mode));
}
