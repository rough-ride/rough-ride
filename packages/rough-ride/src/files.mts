// Checks every committed file under .rough-ride/ before any of them is acted
// on (spec part 2 sections 7.5 to 7.8): config.yaml, flows, regression tests,
// accepted.yaml, and any other YAML a later release may add.

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { checkVersion, type CheckedVersion, type CommittedKind } from './committed.mjs';
import { makeStop, StopError, stopWith } from './exit.mjs';
import { ensureFolder, listYaml, readFolderFile, type FolderState } from './folder.mjs';
import { compareVersions, FORMATS, formatsReport, type FormatKind, type Formats, type FormatsReport } from './formats.mjs';
import type { Manifest, SavedEntry } from './manifest.mjs';
import type { Note } from './output.mjs';
import { ciMode, updateCommand, sourceText, versionSkew, type RunnerInfo } from './runner.mjs';
import { nuxtCandidates } from './target.mjs';
import { createRunFolder } from './runs.mjs';
import { redactSecrets } from './secrets.mjs';
import { buildUpgrade, upgradeFile, UPGRADERS, type Upgrader } from './upgrade.mjs';
import { writeAtomic, type WriteTarget } from './write.mjs';

const KIND_PLURAL: Record<FormatKind, string> = {
  config: 'config',
  flow: 'flows',
  tests: 'tests',
  accepted: 'accepted.yaml',
  plan: 'plan.json',
};

export interface CheckedFile extends CheckedVersion {
  kind: CommittedKind;
  text: string;
}

export interface CheckedFiles {
  config: CheckedFile | null;
  flows: CheckedFile[];
  tests: CheckedFile[];
  accepted: CheckedFile | null;
  // Flows and tests that fail only step 5: their reviewed version or saved copy
  // runs instead (ticket 30), so they never stop the invocation.
  invalid: CheckedFile[];
  notes: Note[];
  formats: FormatsReport;
  // Every committed file read with a schema, plus the files this invocation
  // writes (wroteFile): the skew line and `formats` both count them.
  written: { shown: string; schema: string; kind: FormatKind }[];
  // The runner version and formats the working copies were checked against,
  // so reviewed versions and saved copies get the same check.
  rules: { runner: string; formats: Formats };
  // The schema-newer stop above, for a reviewed version written for a newer
  // rough-ride (ADR 0002): it stops the invocation as a newer working copy does.
  stopNewer(newer: { shown: string; schema: string }[]): never;
}

export interface CheckContext {
  info: RunnerInfo;
  subcommand: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  formats?: Formats;
  upgraders?: Upgrader[];
}

function list(lines: { shown: string; schema: string }[], more: (n: number) => string): string[] {
  const sorted = [...lines].sort((a, b) => compareVersions(b.schema, a.schema) || a.shown.localeCompare(b.shown));
  const width = Math.max(...sorted.map((l) => l.shown.length));
  const shown = sorted.slice(0, 2).map((l) => `  ${l.shown.padEnd(width)}  schema: ${l.schema}`);
  if (sorted.length > 2) shown.push(`  ... and ${sorted.length - 2} more${more(sorted.length - 2)}`);
  return shown;
}

const files = (n: number) => (n === 1 ? '1 file' : `${n} files`);

// YAML under the folder that no kind claims, outside runs/: how a file kind
// from a later release looks to this runner.
function otherYaml(folder: FolderState): string[][] {
  const found: string[][] = [];
  const walk = (parts: string[]) => {
    for (const name of readdirSync(path.join(folder.dir, ...parts)).sort()) {
      const here = [...parts, name];
      const stat = lstatSync(path.join(folder.dir, ...here));
      if (stat.isSymbolicLink()) {
        stopWith('folder-shape', `.rough-ride/${here.join('/')} is a link. rough-ride reads only real files and folders inside .rough-ride/.`);
      }
      if (stat.isDirectory()) {
        if (parts.length === 0 && ['runs', 'flows', 'tests'].includes(name)) continue;
        walk(here);
      } else if (name.endsWith('.yaml') && !(parts.length === 0 && ['config.yaml', 'accepted.yaml'].includes(name))) {
        found.push(here);
      }
    }
  };
  walk([]);
  return found;
}

// The git root package.json's exact rough-ride pin, when it is below `version`.
function pinBelow(root: string, version: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const pin = pkg.devDependencies?.['rough-ride'] ?? pkg.dependencies?.['rough-ride'];
    if (pin && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(pin) && compareVersions(pin, version) < 0) return pin;
  } catch {
    // No package.json, or no pin.
  }
  return null;
}

export function checkCommittedFiles(folder: FolderState, ctx: CheckContext): CheckedFiles {
  const formats = ctx.formats ?? FORMATS;
  const runner = ctx.info.version;
  const notes: Note[] = [];
  const read: CheckedFile[] = [];
  const check = (kind: CommittedKind, parts: string[]): CheckedFile | null => {
    const text = readFolderFile(folder, ...parts);
    if (text === null) return null;
    const shown = ['.rough-ride', ...parts].join('/');
    const file = { ...checkVersion(text, shown, kind, runner, formats), kind, text };
    read.push(file);
    return file;
  };

  const config = check('config', ['config.yaml']);
  const flows = listYaml(folder, 'flows', notes).map((name) => check('flow', ['flows', name])!).filter(Boolean);
  const tests = listYaml(folder, 'tests', notes).map((name) => check('tests', ['tests', name])!).filter(Boolean);
  const accepted = check('accepted', ['accepted.yaml']);

  const newer: { shown: string; schema: string }[] = [];
  const older: CheckedFile[] = [];
  const problems: string[] = [];
  const seen: Partial<Record<FormatKind, string[]>> = {};
  for (const file of read) {
    // An empty or comment-only file counts as no file.
    if (file.value === null && file.schema === null && file.problems.length === 0) continue;
    problems.push(...file.problems);
    if (file.schema === null) continue;
    (seen[file.kind] ??= []).push(file.schema.text);
    if (file.range === 'newer') newer.push({ shown: file.shown, schema: file.schema.text });
    else if (file.range === 'older') older.push(file);
  }

  for (const parts of folder.exists ? otherYaml(folder) : []) {
    const shown = ['.rough-ride', ...parts].join('/');
    const schema = /^schema:\s*["']?([0-9]+\.[0-9]+\.[0-9]+)["']?\s*(#.*)?$/m.exec(readFolderFile(folder, ...parts) ?? '')?.[1];
    if (schema && compareVersions(schema, runner) > 0) newer.push({ shown, schema });
    else notes.push({ id: 'ignored', text: `Ignored: ${shown} (rough-ride ${runner} doesn't use it).` });
  }

  // The skew line prints in every runner block from here on, stops included.
  // Until the target is found, a Nuxt root counts only when it is the one candidate.
  const written = read.flatMap((f) => (f.schema ? [{ shown: f.shown, schema: f.schema.text, kind: f.kind }] : []));
  const skewInput = [...written, ...newer.filter((n) => !read.some((f) => f.shown === n.shown))];
  const candidates = nuxtCandidates(folder.root);
  ctx.info.versionSkew = versionSkew(ctx.info, folder.root, ['', ...(candidates.length === 1 ? [candidates[0]!.rel] : [])], skewInput, ctx.argv);

  const stopNewer = (found: { shown: string; schema: string }[]): never => {
    const highest = found.map((n) => n.schema).sort(compareVersions).at(-1)!;
    stopWith(
      'schema-newer',
      `rough-ride ${runner} can't read ${files(found.length)} written for a newer rough-ride:`,
      ...list(found, () => ''),
      `They need rough-ride ${highest} or later. This invocation used ${runner} from ${sourceText(ctx.info)}.`,
      `Update it: ${updateCommand(ctx.info, highest, ctx.argv)}`,
    );
  };
  if (newer.length > 0) stopNewer(newer);

  if (older.length > 0) throw olderStop(folder, ctx, formats, older, problems);

  const stopping = [...problems];
  for (const file of [config, accepted]) if (file) stopping.push(...file.step5);
  if (stopping.length > 0) stopWith('files-invalid', ...stopping);

  return {
    config,
    flows,
    tests,
    accepted,
    invalid: [...flows, ...tests].filter((f) => f.step5.length > 0),
    notes,
    formats: formatsReport(seen, formats),
    written,
    rules: { runner, formats },
    stopNewer,
  };
}

// Counts a file this invocation wrote (a saved flow, a new regression test)
// in `formats` and the skew line, replacing what was read at that path, then
// recomputes the skew line against the git root and the detected Nuxt root.
export function wroteFile(files: CheckedFiles, info: RunnerInfo, root: string, nuxtRel: string | null, argv: string[], file?: { shown: string; schema: string; kind: FormatKind }): void {
  if (file) {
    files.written = [...files.written.filter((w) => w.shown !== file.shown), file];
    const seen: Partial<Record<FormatKind, string[]>> = {};
    for (const w of files.written) (seen[w.kind] ??= []).push(w.schema);
    files.formats = formatsReport(seen);
  }
  info.versionSkew = versionSkew(info, root, ['', ...(nuxtRel ? [nuxtRel] : [])], files.written, argv);
}

export interface ProtectedWrite {
  folder: WriteTarget;
  manifest: Manifest;
  files: CheckedFiles;
  info: RunnerInfo;
  root: string;
  nuxtRel: string | null;
  argv: string[];
}

// A flow or test rough-ride wrote (26.8) in one step: the file, its saved copy
// and manifest entry from the very bytes written (secrets already redacted),
// and its count in `formats` and the skew line.
export function writeProtected(at: ProtectedWrite, rel: `flows/${string}.yaml` | `tests/${string}.yaml`, text: string, by: SavedEntry['by'], run: string): void {
  const kind = rel.startsWith('flows/') ? 'flow' : 'tests';
  const bytes = redactSecrets(text);
  // As bytes, so writeAtomic writes them as they are instead of redacting a second time.
  writeAtomic(at.folder, rel.split('/'), Buffer.from(bytes, 'utf8'));
  at.manifest.saveCopy(rel, bytes, by, run, at.info.version);
  wroteFile(at.files, at.info, at.root, at.nuxtRel, at.argv, { shown: `.rough-ride/${rel}`, schema: FORMATS[kind].current, kind });
}

function olderStop(
  folder: FolderState,
  ctx: CheckContext,
  formats: Formats,
  older: CheckedFile[],
  problems: string[],
): StopError {
  const runner = ctx.info.version;
  const kinds = [...new Set(older.map((f) => f.kind))].sort(
    (a, b) => compareVersions(formats[b].floor, formats[a].floor) || a.localeCompare(b),
  );
  const changed = kinds
    .map((kind, i) => `${KIND_PLURAL[kind]}${i === 0 ? ' changed' : ''} in ${formats[kind].floor}`)
    .join(', ');
  const headline = `rough-ride ${runner} no longer reads the format of ${files(older.length)} (${changed}):`;

  const ready = ensureFolder(folder);
  const run = createRunFolder(ready, ctx.subcommand);
  const rel = `.rough-ride/runs/${run.id}`;
  const applyLine = `git -C "${folder.root}" apply ${rel}/upgrade.patch`;
  const upgraded = older.map((f) =>
    upgradeFile({ shown: f.shown, kind: f.kind, text: f.text, schema: f.schema! }, formats, ctx.upgraders ?? UPGRADERS),
  );
  const upgrade = buildUpgrade(upgraded, headline, applyLine);
  writeAtomic(ready, ['runs', run.id, 'upgrade.patch'], upgrade.patch);
  writeAtomic(ready, ['runs', run.id, 'upgrade.txt'], upgrade.text);

  // In CI mode paths point into the job's uploaded run output, which is rooted
  // at runs/, and the git -C line, whose path exists only on the runner, is left out (52.3).
  const ci = ciMode(ctx.env, ctx.info);
  const upgradeTxt = ci ? `${run.id}/upgrade.txt in the job's uploaded run output` : `${rel}/upgrade.txt`;
  const lines = [
    headline,
    ...list(
      older.map((f) => ({ shown: f.shown, schema: f.schema!.text })),
      () => ` (all listed in ${upgradeTxt})`,
    ),
  ];
  for (const f of upgraded) for (const d of f.dropped) lines.push(`Dropped in the patch: ${f.shown} ${d}`);
  for (const f of upgraded) for (const d of f.handEdits) lines.push(`Edit by hand: ${f.shown} ${d}`);
  if (upgrade.inPatch.length === 0) {
    lines.push(`No upgrade patch: every file needs the hand edits in ${upgradeTxt}.`);
  } else if (!ci) {
    lines.push('An upgrade patch is ready. Review it, then run this in your terminal and commit the result:', `  ${applyLine}`);
  }
  const highest = upgraded.map((f) => formats[f.kind].current).sort(compareVersions).at(-1)!;
  const pin = pinBelow(folder.root, highest);
  if (pin) {
    lines.push(`Raise the pin in the same commit, or CI stops on the upgraded files: npm i -D -E rough-ride@${runner}`);
  }
  if (ci && upgrade.inPatch.length > 0) {
    lines.push(
      `This ran in CI: take ${run.id}/upgrade.patch from the job's uploaded run output and apply it at the repository root with git apply, or run rough-ride ${runner} locally to get the same patch.`,
    );
  }
  lines.push(`Release notes: https://github.com/rough-ride/rough-ride/releases/tag/v${runner}`, ...problems);
  return new StopError(makeStop('schema-older', lines), run);
}
