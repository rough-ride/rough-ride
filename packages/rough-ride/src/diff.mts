// The diff (spec part 4 section 15): every file that differs between the base
// commit and the working tree, read once at the start of an invocation,
// classified, and never written through git.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';
import { isFolderName } from '../hooks/path-check.mjs';
import { stopWith } from './exit.mjs';
import { git } from './git.mjs';
import type { Note } from './output.mjs';
import { DROPPED } from './target.mjs';

export type FileClass = 'flow' | 'tool' | 'generated' | 'binary' | 'dependency' | 'config' | 'not app code' | 'app';
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'type-changed';

export interface DiffFile {
  // Repo-relative, `/`, NFC: the spelling every stored and printed path uses.
  path: string;
  // The path as git printed it, for reading the file and for git pathspecs.
  // On Linux a decomposed name is stored as written, so NFC can miss it.
  raw: string;
  oldPath: string | null;
  status: FileStatus;
  class: FileClass;
  added: number | null;
  deleted: number | null;
  untracked: boolean;
  // `not traced (untracked folder of 1,001 files)`, `not traced (submodule)`, `not traced (nested repository)`.
  reason: string | null;
}

export interface BaseRef {
  ref: string;
  sha: string;
}

export interface Diff {
  base: BaseRef & { given: boolean; default?: BaseRef; leftOut?: string[] };
  files: DiffFile[];
  // Untracked folders dropped by name, with their counts.
  dropped: { path: string }[];
  digest: string;
}

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'uv.lock',
  'poetry.lock', 'Pipfile.lock', 'pdm.lock', 'go.sum', 'Gemfile.lock', 'composer.lock', 'Cargo.lock',
]);
const MANIFESTS = /^(package\.json|pyproject\.toml|requirements.*\.txt|Pipfile|setup\.cfg|setup\.py|go\.mod|Gemfile|composer\.json|Cargo\.toml)$/;
const CONFIG = /^((nuxt|app|vite|next|svelte|astro|tailwind|postcss)\.config\..+|tsconfig.*\.json|jsconfig\.json|\.npmrc|\.env.*)$/;
const TESTS = /(\.test\.|\.spec\.)|^test_.*\.py$|_test\.py$|^conftest\.py$|^(playwright|vitest|jest)\.config\./;
const DOCS = /^(README|CHANGELOG|LICENSE|CONTRIBUTING)/;
const AGENT_DOCS = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']);
const TOOL_DIRS = new Set(['.github', '.vscode', '.idea', '.claude']);
const TOOL_FILES = /^(\.editorconfig|\.gitignore|\.gitattributes|\.prettierrc.*|prettier\.config\..+|\.eslintrc.*|eslint\.config\..+|biome\.json.*|ruff\.toml|\.pre-commit-config\.yaml|Dockerfile.*|compose.*\.ya?ml|docker-compose.*\.ya?ml|Makefile)$/;
const SECRET_FILES = /(^|\/)\.env[^/]*$|\.(pem|key)$/;
const AUTOMATION = ['navigator.webdriver', 'HeadlessChrome', '__playwright', '__pwInitScripts', 'rough-ride', '.rough-ride'];
const UNTRACKED_FOLDER_LIMIT = 1000;

export interface ClassifyContext {
  // Repo-relative Nuxt roots ending in `/`, `` for the git root.
  nuxtRoots: string[];
  ignoreCase: boolean;
  generated: Set<string>;
  binary: Set<string>;
}

// The first match wins (15.6).
export function classify(file: string, ctx: ClassifyContext): FileClass {
  const segments = file.split('/');
  if (isFolderName(segments[0]!)) {
    return /^flows\/[^/]+\.yaml$/.test(segments.slice(1).join('/')) ? 'flow' : 'tool';
  }
  if (segments.slice(1).some((s) => isFolderName(s))) return 'tool';
  const name = segments.at(-1)!;
  const cmp = (s: string) => (ctx.ignoreCase ? s.toLowerCase() : s);
  if (ctx.generated.has(file) || segments.slice(0, -1).some((s) => DROPPED.has(s)) || /\.(min\.js|map|pyc)$/.test(name)) {
    return 'generated';
  }
  if (ctx.binary.has(file)) return 'binary';
  if (LOCKFILES.has(name) || MANIFESTS.test(name)) return 'dependency';
  if (CONFIG.test(name)) return 'config';
  const folders = segments.slice(0, -1);
  const testFolder = folders.findIndex((s) => ['test', 'tests', '__tests__', 'e2e'].includes(cmp(s)));
  const routeBefore = testFolder > 0 && folders.slice(0, testFolder).some((s) => ['pages', 'routes', 'api', 'server'].includes(cmp(s)));
  if (TESTS.test(name) || (testFolder !== -1 && !routeBefore)) return 'not app code';
  if (DOCS.test(name) || AGENT_DOCS.has(name)) return 'not app code';
  if (/\.mdx?$/.test(name) && !ctx.nuxtRoots.some((root) => file.startsWith(root))) return 'not app code';
  if (TOOL_DIRS.has(segments[0]!) || TOOL_FILES.test(name)) return 'not app code';
  return 'app';
}

function run(root: string, args: string[]): string {
  const result = git(args, root);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.split('\n')[0]}`);
  return result.stdout;
}

function tryRun(root: string, args: string[]): string | null {
  const result = git(args, root);
  return result.status === 0 ? result.stdout : null;
}

const NUL = '\0';

function remoteName(root: string): string | null {
  const remotes = (tryRun(root, ['remote']) ?? '').split('\n').filter(Boolean);
  if (remotes.includes('origin')) return 'origin';
  return remotes.length === 1 ? remotes[0]! : null;
}

function verify(root: string, ref: string): string | null {
  return tryRun(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])?.trim() || null;
}

export function emptyTree(root: string): string {
  // git's empty tree for this repository's object format (SHA-1 or SHA-256).
  const result = spawnSync('git', ['--no-optional-locks', 'hash-object', '-t', 'tree', '--stdin'], { cwd: root, input: '', encoding: 'utf8' });
  return result.stdout.trim();
}

function defaultRefs(root: string, env: NodeJS.ProcessEnv): { refs: { ref: string; shown: string }[]; fromGithub: boolean } {
  const origin = remoteName(root);
  const refs: { ref: string; shown: string }[] = [];
  if (env.GITHUB_BASE_REF && origin) {
    return { refs: [{ ref: `refs/remotes/${origin}/${env.GITHUB_BASE_REF}`, shown: `${origin}/${env.GITHUB_BASE_REF}` }], fromGithub: true };
  }
  if (origin) {
    refs.push({ ref: `refs/remotes/${origin}/HEAD`, shown: `${origin}/HEAD` });
    refs.push({ ref: `refs/remotes/${origin}/main`, shown: `${origin}/main` });
    refs.push({ ref: `refs/remotes/${origin}/master`, shown: `${origin}/master` });
  }
  refs.push({ ref: 'refs/heads/main', shown: 'main' }, { ref: 'refs/heads/master', shown: 'master' });
  return { refs, fromGithub: false };
}

// The merge base of HEAD with the first ref that exists (15.2).
export function resolveBase(
  root: string,
  given: string | null,
  env: NodeJS.ProcessEnv,
  mode: 'tier' | 'regress' = 'tier',
): BaseRef & { given: boolean } {
  const head = verify(root, 'HEAD');
  if (head === null) return { ref: 'empty tree', sha: emptyTree(root), given: given !== null };
  const passBase = mode === 'tier' ? ' or pass --base <ref>' : '';
  let chosen: { ref: string; shown: string } | null = null;
  if (given !== null) {
    if (verify(root, given) === null) stopWith('unknown-ref', `Unknown ref for --base: ${given}.`);
    chosen = { ref: given, shown: given };
  } else {
    const { refs, fromGithub } = defaultRefs(root, env);
    chosen = refs.find((r) => verify(root, r.ref) !== null) ?? null;
    if (chosen === null && fromGithub) {
      stopWith('no-merge-base', `Can't find the merge base with ${refs[0]!.shown}: fetch full history (actions/checkout fetch-depth: 0)${passBase}.`);
    }
    if (chosen === null) stopWith('no-base', 'No base branch found (origin/HEAD, origin/main, origin/master, main, master). Pass --base <ref>.');
  }
  const base = tryRun(root, ['merge-base', 'HEAD', chosen!.ref])?.trim();
  if (!base) stopWith('no-merge-base', `Can't find the merge base with ${chosen!.shown}: fetch full history (actions/checkout fetch-depth: 0)${passBase}.`);
  return { ref: chosen!.shown, sha: base, given: given !== null };
}

function isBinaryFile(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(8000);
    const n = readSync(fd, buffer, 0, 8000, 0);
    return buffer.subarray(0, n).includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function lineCount(file: string): number {
  try {
    const text = readFileSync(file);
    if (text.length === 0) return 0;
    let n = 0;
    for (const byte of text) if (byte === 10) n++;
    return text[text.length - 1] === 10 ? n : n + 1;
  } catch {
    return 0;
  }
}

const STATUS: Record<string, FileStatus> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'added', T: 'type-changed' };
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--ignore-cr-at-eol', '-M'];

interface RawChange {
  path: string;
  raw: string;
  oldPath: string | null;
  status: FileStatus;
  added: number | null;
  deleted: number | null;
  untracked: boolean;
  reason: string | null;
}

function trackedChanges(root: string, base: string): RawChange[] {
  const names = run(root, ['diff', '--name-status', '-z', ...DIFF_FLAGS, base]).split(NUL);
  const changes: RawChange[] = [];
  for (let i = 0; i < names.length - 1; ) {
    const code = names[i++]!;
    if (code === '') continue;
    const letter = code[0]!;
    if (letter === 'R' || letter === 'C') {
      const oldRaw = names[i++]!;
      const newRaw = names[i++]!;
      changes.push({ path: newRaw.normalize('NFC'), raw: newRaw, oldPath: letter === 'R' ? oldRaw.normalize('NFC') : null, status: STATUS[letter]!, added: null, deleted: null, untracked: false, reason: null });
      if (letter === 'R') changes.push({ path: oldRaw.normalize('NFC'), raw: oldRaw, oldPath: null, status: 'deleted', added: null, deleted: null, untracked: false, reason: null });
    } else {
      const raw = names[i++]!;
      changes.push({ path: raw.normalize('NFC'), raw, oldPath: null, status: STATUS[letter] ?? 'modified', added: null, deleted: null, untracked: false, reason: null });
    }
  }
  // --numstat -z: `added<TAB>deleted<TAB>path` or, for a rename, `added<TAB>deleted<TAB>` then old and new paths.
  const stats = run(root, ['diff', '--numstat', '-z', ...DIFF_FLAGS, base]).split(NUL);
  const counted = new Set<RawChange>();
  for (let i = 0; i < stats.length - 1; ) {
    const entry = stats[i++]!;
    if (entry === '') continue;
    const [added, deleted, rest] = entry.split('\t');
    let file = rest ?? '';
    if (file === '') {
      i++;
      file = stats[i++]!;
    }
    const change = changes.find((c) => c.raw === file && c.status !== 'deleted') ?? changes.find((c) => c.raw === file);
    if (change) {
      change.added = added === '-' ? null : Number(added);
      change.deleted = deleted === '-' ? null : Number(deleted);
      counted.add(change);
    }
  }
  // Submodules are one path, never looked inside.
  const gitlinks = run(root, ['ls-files', '-s', '-z']).split(NUL).filter((l) => l.startsWith('160000 ')).map((l) => l.split('\t')[1]!);
  for (const change of changes) if (gitlinks.includes(change.raw)) change.reason = 'not traced (submodule)';
  // git 2.43 still lists a file whose only change is CRLF line endings under
  // --name-status, while --numstat leaves it out (or newer gits count 0 and 0).
  return changes.filter((c) => !(c.status === 'modified' && (!counted.has(c) || (c.added === 0 && c.deleted === 0))));
}

function untrackedChanges(root: string, dropped: { path: string }[]): RawChange[] {
  const listed = run(root, ['ls-files', '--others', '--exclude-standard', '--directory', '--no-empty-directory', '-z']).split(NUL).filter(Boolean);
  const changes: RawChange[] = [];
  const add = (file: string, reason: string | null = null) =>
    changes.push({ path: file.normalize('NFC'), raw: file, oldPath: null, status: 'added', added: null, deleted: null, untracked: true, reason });
  for (const entry of listed) {
    if (!entry.endsWith('/')) {
      add(entry);
      continue;
    }
    const dir = entry.slice(0, -1);
    if (DROPPED.has(path.posix.basename(dir))) {
      dropped.push({ path: entry });
      continue;
    }
    if (existsSync(path.join(root, dir, '.git'))) {
      add(dir, 'not traced (nested repository)');
      continue;
    }
    const inside = run(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', dir]).split(NUL).filter(Boolean);
    if (inside.length > UNTRACKED_FOLDER_LIMIT) add(dir, `not traced (untracked folder of ${inside.length.toLocaleString('en-US')} files)`);
    else inside.forEach((file) => add(file));
  }
  return changes;
}

function generatedPaths(root: string, files: string[]): Set<string> {
  if (files.length === 0) return new Set();
  const result = spawnSync('git', ['--no-optional-locks', 'check-attr', '-z', '--stdin', 'linguist-generated', 'diff'], {
    cwd: root,
    input: files.join(NUL) + NUL,
    encoding: 'utf8',
  });
  const parts = (result.stdout ?? '').split(NUL);
  const generated = new Set<string>();
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const [file, attr, value] = [parts[i]!, parts[i + 1]!, parts[i + 2]!];
    if ((attr === 'linguist-generated' && (value === 'set' || value === 'true')) || (attr === 'diff' && value === 'unset')) generated.add(file);
  }
  return generated;
}

function contentHash(root: string, file: string): string {
  try {
    return createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex');
  } catch {
    return 'missing';
  }
}

// sha256 over the base sha plus the sorted path, status and content hash of
// every changed app, config and dependency file (15.11).
export function computeDigest(root: string, base: string, files: DiffFile[]): string {
  const hash = createHash('sha256').update(base + '\n');
  const counted = files.filter((f) => ['app', 'config', 'dependency'].includes(f.class)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const f of counted) hash.update(`${f.path}\0${f.status}\0${f.status === 'deleted' ? 'deleted' : contentHash(root, f.raw)}\n`);
  return hash.digest('hex');
}

export interface DiffOptions {
  root: string;
  given: string | null;
  env: NodeJS.ProcessEnv;
  nuxtRoots: string[];
}

function unmerged(root: string): void {
  const paths = run(root, ['diff', '--name-only', '--diff-filter=U', '-z']).split(NUL).filter(Boolean);
  if (paths.length > 0) stopWith('unmerged-paths', `Unmerged paths: ${[...new Set(paths)].join(', ')}. Finish the merge or rebase first.`);
}

function changesAgainst(root: string, base: string, dropped: { path: string }[]): RawChange[] {
  const tracked = trackedChanges(root, base);
  const trackedPaths = new Set(tracked.map((c) => c.path));
  return [...tracked, ...untrackedChanges(root, dropped).filter((c) => !trackedPaths.has(c.path))];
}

// Computes the diff once; nothing that happens later in the invocation moves it.
export function computeDiff(options: DiffOptions): Diff {
  const { root } = options;
  const base = resolveBase(root, options.given, options.env);
  unmerged(root);
  const dropped: { path: string }[] = [];
  const raw = changesAgainst(root, base.sha, dropped);
  const ignoreCase = tryRun(root, ['config', '--get', 'core.ignorecase'])?.trim() === 'true';
  const generatedRaw = generatedPaths(root, raw.map((c) => c.raw));
  const generated = new Set(raw.filter((c) => generatedRaw.has(c.raw)).map((c) => c.path));
  const binary = new Set<string>();
  for (const c of raw) {
    if (c.untracked && c.reason === null && isBinaryFile(path.join(root, c.raw))) binary.add(c.path);
    if (!c.untracked && c.status !== 'deleted' && c.added === null && c.deleted === null && c.reason === null) binary.add(c.path);
  }
  const ctx: ClassifyContext = { nuxtRoots: options.nuxtRoots, ignoreCase, generated, binary };
  const files: DiffFile[] = raw
    .map((c) => {
      const untrackedLines = c.untracked && c.reason === null && !binary.has(c.path) ? lineCount(path.join(root, c.raw)) : null;
      return {
        ...c,
        added: c.untracked ? untrackedLines : c.added,
        deleted: c.untracked ? (untrackedLines === null ? null : 0) : c.deleted,
        class: c.reason ? ('not app code' as FileClass) : classify(c.path, ctx),
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.status < b.status ? -1 : 1));

  const diff: Diff = { base, files, dropped, digest: computeDigest(root, base.sha, files) };
  if (base.given) {
    try {
      const fallback = resolveBase(root, null, options.env);
      if (fallback.sha !== base.sha) {
        const defaultPaths = changesAgainst(root, fallback.sha, []).map((c) => c.path);
        const here = new Set(files.map((f) => f.path));
        diff.base.default = { ref: fallback.ref, sha: fallback.sha };
        diff.base.leftOut = [...new Set(defaultPaths.filter((p) => !here.has(p)))].sort();
      }
    } catch {
      // No default base to compare with: nothing to say about left-out files.
    }
  }
  return diff;
}

// No app, config or dependency file changed or was deleted, and no flow file changed.
export function isEmpty(diff: Diff): boolean {
  return !diff.files.some((f) => ['app', 'config', 'dependency', 'flow'].includes(f.class));
}

const short = (sha: string) => sha.slice(0, 7);

function leftOutClause(diff: Diff): string {
  if (!diff.base.leftOut || diff.base.leftOut.length === 0 || !diff.base.default) return '';
  const n = diff.base.leftOut.length;
  return `--base given: leaves out ${n} ${n === 1 ? 'file' : 'files'} that differ from ${diff.base.default.ref}`;
}

// The Nothing to attack line, naming .rough-ride files from the diff's own list.
export function nothingToAttackLine(diff: Diff, regressCommand: string): string {
  const clause = leftOutClause(diff);
  if (diff.files.length === 0) {
    if (clause) return `Nothing to attack: no changes between ${diff.base.ref} (${short(diff.base.sha)}) and the working tree (${clause}).`;
    return `Nothing to attack: no changes between ${diff.base.ref} (${short(diff.base.sha)}) and the working tree. Pass --base <ref> to compare with another commit.`;
  }
  const n = diff.files.length;
  const own = diff.files.filter((f) => isFolderName(f.path.split('/')[0]!));
  let line = `Nothing to attack: the ${n} changed files are tests, docs, tooling, generated or binary files`;
  if (own.length > 0) {
    const named = own.map((f) => `${f.path} ${f.status === 'deleted' ? 'deleted' : f.status === 'added' ? 'added' : 'changed'}`).join(', ');
    line += ` (${named}). Run ${regressCommand} to run regression tests.`;
  } else {
    line += '.';
  }
  return clause ? line.replace(/\.( Run .*)?$/, (m) => ` (${clause})${m}`) : line;
}

// `diff: origin/main 3f2a91c..working tree | 7 files`; ticket 17 adds the reach counts.
export function headerLine2(diff: Diff): string {
  const n = diff.files.length;
  let line = `diff: ${diff.base.ref} ${short(diff.base.sha)}..working tree | ${n.toLocaleString('en-US')} ${n === 1 ? 'file' : 'files'}`;
  const clause = leftOutClause(diff);
  if (clause) line += ` (${clause})`;
  else if (diff.base.given) line += ' (--base given)';
  return line;
}

export function largeDiffNote(diff: Diff): Note | null {
  const n = diff.files.filter((f) => f.class === 'app').length;
  if (n <= 200) return null;
  return { id: 'large-diff', text: `Large diff: ${n.toLocaleString('en-US')} app files against ${diff.base.ref} ${short(diff.base.sha)}. Check the base.` };
}

// Added lines of app and config files, with their new line numbers.
export function addedLines(root: string, diff: Diff): { file: string; line: number; text: string }[] {
  const targets = diff.files.filter((f) => (f.class === 'app' || f.class === 'config') && f.status !== 'deleted' && f.reason === null && !SECRET_FILES.test(f.path));
  const out: { file: string; line: number; text: string }[] = [];
  const tracked = targets.filter((f) => !f.untracked).map((f) => f.raw);
  if (tracked.length > 0) {
    const patch = run(root, ['-c', 'core.quotePath=false', 'diff', '-U0', ...DIFF_FLAGS, diff.base.sha, '--', ...tracked]);
    let file = '';
    let line = 0;
    for (const raw of patch.split('\n')) {
      if (raw.startsWith('+++ ')) file = raw.startsWith('+++ b/') ? raw.slice(6) : '';
      else if (raw.startsWith('@@')) line = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0);
      else if (raw.startsWith('+') && file) out.push({ file: file.normalize('NFC'), line: line++, text: raw.slice(1) });
    }
  }
  for (const f of targets.filter((t) => t.untracked)) {
    readFileSync(path.join(root, f.raw), 'utf8').split('\n').forEach((text, i) => out.push({ file: f.path, line: i + 1, text }));
  }
  return out;
}

export function automationNote(root: string, diff: Diff): Note | null {
  for (const added of addedLines(root, diff)) {
    const match = AUTOMATION.find((token) => added.text.includes(token));
    if (match) {
      return {
        id: 'automation-detection',
        text: `The diff adds code that can tell automation apart (${added.file} line ${added.line}: ${match}). Verdicts may not match what users see.`,
      };
    }
  }
  return null;
}

// diff.patch: app and config files and manifests in full (untracked as
// additions), lockfiles, generated and binary files by name and line counts,
// secret files by name only. The repository's own bytes.
export function diffPatch(root: string, diff: Diff): Buffer {
  const parts: Buffer[] = [];
  const full = diff.files.filter((f) => f.reason === null && !SECRET_FILES.test(f.path) &&
    (f.class === 'app' || f.class === 'config' || (f.class === 'dependency' && MANIFESTS.test(path.posix.basename(f.path)))));
  const tracked = full.filter((f) => !f.untracked);
  if (tracked.length > 0) {
    const rawOf = new Map(diff.files.map((f) => [f.path, f.raw]));
    const paths = [...new Set(tracked.flatMap((f) => (f.oldPath ? [rawOf.get(f.oldPath) ?? f.oldPath, f.raw] : [f.raw])))];
    const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.quotePath=false', 'diff', ...DIFF_FLAGS, diff.base.sha, '--', ...paths], { cwd: root });
    parts.push(result.stdout);
  }
  for (const f of full.filter((t) => t.untracked)) {
    const body = readFileSync(path.join(root, f.raw));
    const lines = body.length === 0 ? [] : body.toString('latin1').split('\n');
    if (lines.at(-1) === '') lines.pop();
    const header = `diff --git a/${f.path} b/${f.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${f.path}\n@@ -0,0 +1,${lines.length} @@\n`;
    const text = lines.map((l) => `+${l}\n`).join('') + (body.length > 0 && body[body.length - 1] !== 10 ? '\\ No newline at end of file\n' : '');
    parts.push(Buffer.from(header, 'utf8'), Buffer.from(text, 'latin1'));
  }
  for (const f of diff.files.filter((x) => !full.includes(x))) {
    if (SECRET_FILES.test(f.path)) parts.push(Buffer.from(`# ${f.path}: ${f.status} (contents not shown)\n`, 'utf8'));
    else if (['dependency', 'generated', 'binary'].includes(f.class)) {
      const counts = f.added === null ? 'binary' : `+${f.added} -${f.deleted}`;
      parts.push(Buffer.from(`# ${f.path}: ${f.status}, ${counts} (${f.class}, not shown)\n`, 'utf8'));
    }
  }
  return Buffer.concat(parts);
}

// diff-map.json's content at this stage: base, digest and files. Reach and
// selection fields join it in tickets 16 and 17.
export function diffMap(diff: Diff, startedAt: string): Record<string, unknown> {
  return {
    base: diff.base,
    digest: diff.digest,
    files: diff.files.map((f) => ({ path: f.path, oldPath: f.oldPath, status: f.status, class: f.class, ...(f.reason ? { reason: f.reason } : {}) })),
    meta: { startedAt },
  };
}

// Whether the changed path is a real file the runner can read (not a gitlink or folder).
export function isPlainFile(root: string, file: string): boolean {
  try {
    return lstatSync(path.join(root, file)).isFile();
  } catch {
    return false;
  }
}

export interface ReviewedBase {
  // As printed (`origin/main`), the full ref, the merge base and the ref's own commit.
  shown: string;
  ref: string;
  mergeBase: string;
  refSha: string;
  local: boolean;
}

// The reviewed-version base (26.3): the merge base of HEAD with the first
// existing default ref. Never `--base`; `GITHUB_BASE_REF` only without a plugin
// data folder. Null when no base ref exists; a stop when the merge base is missing.
export function reviewedBase(root: string, env: NodeJS.ProcessEnv, pluginData: boolean, mode: 'tier' | 'regress' = 'tier'): ReviewedBase | null {
  if (verify(root, 'HEAD') === null) return null;
  const { refs } = defaultRefs(root, pluginData ? { ...env, GITHUB_BASE_REF: undefined } : env);
  const chosen = refs.find((r) => verify(root, r.ref) !== null);
  if (!chosen) return null;
  const mergeBase = tryRun(root, ['merge-base', 'HEAD', chosen.ref])?.trim();
  if (!mergeBase) {
    stopWith('no-merge-base', `Can't find the merge base with ${chosen.shown}: fetch full history (actions/checkout fetch-depth: 0)${mode === 'tier' ? ' or pass --base <ref>' : ''}.`);
  }
  return { shown: chosen.shown, ref: chosen.ref, mergeBase: mergeBase!, refSha: verify(root, chosen.ref)!, local: chosen.ref.startsWith('refs/heads/') };
}

// The latest reflog message of a ref, or null when it has no reflog.
export function reflogMessage(root: string, ref: string): string | null {
  const out = tryRun(root, ['reflog', 'show', '-1', '--format=%gs', ref, '--']);
  return out === null ? null : out.trim();
}
