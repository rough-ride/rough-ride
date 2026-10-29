// The one .rough-ride/ folder at the git root: what counts as it, reading
// files inside it, and its .gitignore (spec part 2 sections 6.5, 6.6, 6.8 and 6.9).

import { lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fold, isFolderName } from '../hooks/path-check.mjs';
import { stopWith } from './exit.mjs';
import { git, lsFiles } from './git.mjs';
import type { Note } from './output.mjs';
import { writeAtomic } from './write.mjs';

export const FOLDER = '.rough-ride';

export const GITIGNORE_COMMENT = '# Written by rough-ride. Keep these lines; add your own below them.';
export const GITIGNORE_RULES = ['/.env', '/.env.*', '/runs/'];

export interface FolderState {
  root: string;
  // Absolute path of <root>/.rough-ride, whether or not it exists yet.
  dir: string;
  exists: boolean;
}

// Steps 1 and 2 of an invocation's start: the entry at the root is exactly one
// real folder spelled `.rough-ride`, or absent. Stops are folder-shape (78),
// or sparse-checkout when git lists files the checkout left out.
export function checkRootEntry(root: string): FolderState {
  const dir = path.join(root, FOLDER);
  const matches = readdirSync(root).filter((name) => isFolderName(name));
  const variant = matches.find((name) => name !== FOLDER);
  if (variant !== undefined) {
    stopWith(
      'folder-shape',
      `Found ${variant}/ at the repository root. rough-ride reads only .rough-ride/ in lowercase: rename it with git mv.`,
    );
  }
  if (matches.length === 0) {
    if (lsFiles(root, [FOLDER]).length > 0) {
      stopWith('sparse-checkout', '.rough-ride/ is outside your sparse checkout. Run: git sparse-checkout add .rough-ride');
    }
    return { root, dir, exists: false };
  }
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) {
    stopWith('folder-shape', '.rough-ride at the repository root is a link. rough-ride needs a real folder there.');
  }
  if (!stat.isDirectory()) {
    stopWith('folder-shape', '.rough-ride at the repository root is a file. rough-ride needs a real folder there.');
  }
  return { root, dir, exists: true };
}

// Notes about where the folder sits, produced once per invocation.
export function locationNotes(root: string, cwd: string, platform: NodeJS.Platform = process.platform): Note[] {
  const notes: Note[] = [];
  if (root !== cwd) notes.push({ id: 'root', text: `root: ${root}` });
  if (root.split('/').some((segment) => isFolderName(segment))) {
    notes.push({
      id: 'inside-rough-ride-folder',
      text: "The repository sits inside a folder named .rough-ride, so the plugin's hook blocks every Edit and Write in it.",
    });
  }
  const longest = root.length + 1 + 120;
  if (platform === 'win32' && longest > 259) {
    notes.push({
      id: 'long-path',
      text: `Long path: run output can reach ${longest} characters under ${root}, over Windows' 260 limit. Tools without long-path support (Explorer, git without core.longpaths) may fail on it.`,
    });
  }
  return notes;
}

function rel(parts: string[]): string {
  return [FOLDER, ...parts].join('/');
}

// lstat every folder from .rough-ride down to `parts`' parent and the file
// itself: links stop, and so does a file with another hard link.
function checkInside(folder: FolderState, parts: string[]): void {
  for (let i = 1; i <= parts.length; i++) {
    const stat = lstatSync(path.join(folder.dir, ...parts.slice(0, i)));
    const shown = rel(parts.slice(0, i));
    if (stat.isSymbolicLink()) {
      stopWith('folder-shape', `${shown} is a link. rough-ride reads only real files and folders inside .rough-ride/.`);
    }
    if (i === parts.length && stat.isFile() && stat.nlink > 1) {
      stopWith('folder-shape', `${shown} has another hard link. rough-ride reads only plain files in .rough-ride/.`);
    }
  }
}

// Reads one file under the folder, or null when it doesn't exist.
export function readFolderFile(folder: FolderState, ...parts: string[]): string | null {
  if (!folder.exists) return null;
  try {
    checkInside(folder, parts);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return readFileSync(path.join(folder.dir, ...parts), 'utf8');
}

// The .yaml names in a folder under .rough-ride (such as flows/), after the
// collision and link checks. `.yml` files are not read and get an Ignored note.
export function listYaml(folder: FolderState, sub: string, notes: Note[]): string[] {
  if (!folder.exists) return [];
  let entries: string[];
  try {
    checkInside(folder, [sub]);
    entries = readdirSync(path.join(folder.dir, sub));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const seen = new Map<string, string>();
  for (const name of [...entries].sort()) {
    const key = fold(name);
    const other = seen.get(key);
    if (other !== undefined) {
      stopWith(
        'folder-shape',
        `${rel([sub])} holds both ${other} and ${name}, which are one file on macOS and Windows. Keep one of them.`,
      );
    }
    seen.set(key, name);
  }
  const names: string[] = [];
  for (const name of entries.sort()) {
    if (name.endsWith('.yml')) notes.push(ymlNote([sub, name]));
    else if (name.endsWith('.yaml')) names.push(name);
  }
  return names;
}

function ymlNote(parts: string[]): Note {
  const name = parts.at(-1)!;
  return {
    id: 'ignored',
    text: `Ignored: ${rel(parts)} (rough-ride reads only .yaml files; rename it to ${name.slice(0, -4)}.yaml).`,
  };
}

// Notes about the folder's own files: a config.yml, and a config or flow that a
// rule outside .rough-ride/.gitignore ignores.
export function folderNotes(folder: FolderState, flows: string[]): Note[] {
  const notes: Note[] = [];
  if (!folder.exists) return notes;
  const top = readdirSync(folder.dir);
  if (top.includes('config.yml')) notes.push(ymlNote(['config.yml']));

  const candidates = [rel(['config.yaml']), ...flows.map((name) => rel(['flows', name]))];
  const result = git(['check-ignore', '-v', '--no-index', '--', ...candidates], folder.root);
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^(.*):(\d+):.*\t(.*)$/.exec(line);
    if (!match) continue;
    const [, source, lineNumber, file] = match;
    if (source === rel(['.gitignore'])) continue;
    notes.push({
      id: 'git-ignored-config',
      text: `${file} is git-ignored (${source}:${lineNumber}): it won't reach CI or your team.`,
    });
    break;
  }

  if (lsFiles(folder.root, [rel(['runs']), rel(['.env'])]).length > 0) {
    notes.push({
      id: 'tracked-run-output',
      text: 'Tracked run output: .rough-ride/runs is committed. Run git rm -r --cached .rough-ride/runs.',
    });
  }
  return notes;
}

// Other .rough-ride folders below the root, never read; one note names them.
export function nestedFoldersNote(root: string): Note | null {
  const listed = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root);
  const found = new Set<string>();
  for (const file of listed.stdout.split('\0')) {
    const segments = file.split('/');
    for (let i = 1; i < segments.length - 1; i++) {
      if (isFolderName(segments[i]!)) {
        found.add(segments.slice(0, i + 1).join('/') + '/');
        break;
      }
    }
  }
  if (found.size === 0) return null;
  const [first, ...rest] = [...found].sort();
  const more = rest.length > 0 ? ` and ${rest.length} more` : '';
  return {
    id: 'ignored',
    text: `Ignored: other .rough-ride/ folders (${first}${more}). rough-ride reads only the one at the repository root.`,
  };
}

// Step 4 of a writing invocation: create the folder and its .gitignore when
// missing, or append only the missing lines to an incomplete one. A complete
// file, by git's own reading, is never touched. The root .gitignore never is.
export function ensureFolder(folder: FolderState): FolderState {
  if (!folder.exists) {
    try {
      mkdirSync(folder.dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'error';
      if (code !== 'EEXIST') stopWith('write-failed', `Can't write ${FOLDER}/: ${code}.`);
    }
    folder = { ...folder, exists: true };
  }
  const existing = readFolderFile(folder, '.gitignore');
  if (existing === null) {
    writeAtomic(folder, ['.gitignore'], [GITIGNORE_COMMENT, ...GITIGNORE_RULES].join('\n') + '\n');
    return folder;
  }
  const probe = [rel(['.env']), rel(['runs', 'x'])];
  const ignored = git(['check-ignore', '--no-index', '--', ...probe], folder.root).stdout;
  if (probe.every((p) => ignored.split(/\r?\n/).includes(p))) return folder;

  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const have = new Set(existing.split(/\r?\n/));
  const missing = [GITIGNORE_COMMENT, ...GITIGNORE_RULES].filter((line) => !have.has(line));
  const lead = existing === '' || existing.endsWith('\n') ? '' : eol;
  writeAtomic(folder, ['.gitignore'], existing + lead + missing.join(eol) + eol);
  return folder;
}
