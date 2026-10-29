// Every file the runner writes under .rough-ride/ goes through here (spec
// part 2 section 6.8): allowed names and extensions only, no links, and an
// atomic write through a temporary name in the same folder.

import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stopWith } from './exit.mjs';
import { redactSecrets } from './secrets.mjs';

export const RUN_EXTENSIONS = ['.json', '.jsonl', '.yaml', '.txt', '.log', '.patch', '.png', '.jpeg', '.webm', '.zip'];
export const FORBIDDEN_EXTENSIONS = [
  '.html', '.htm', '.md', '.mdx', '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts',
  '.jsx', '.tsx', '.vue', '.svelte', '.astro', '.css', '.py',
];
const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

export interface WriteTarget {
  // Absolute path of the .rough-ride folder.
  dir: string;
}

// Why a path under the folder may not be written, or null when it may.
// `parts` are the segments below .rough-ride/.
export function refusedName(parts: string[]): string | null {
  const base = parts.at(-1) ?? '';
  const ext = path.extname(base).toLowerCase();
  if (base === 'tsconfig.json' || base === 'package.json' || base === '.env' || base.startsWith('.env.') ||
      /\.config\./.test(base)) {
    return `${base} is a name rough-ride never writes`;
  }
  if (FORBIDDEN_EXTENSIONS.includes(ext)) return `${ext} files are never written`;
  if (parts[0] === 'runs') {
    if (!RUN_EXTENSIONS.includes(ext)) return `${ext || 'no extension'} is not a run-output extension`;
    for (const segment of [...parts.slice(1, -1), base.slice(0, base.length - ext.length)]) {
      if (!NAME.test(segment) || DEVICE.test(segment)) return `${segment} is not a valid name`;
    }
  }
  return null;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows reports EPERM or EBUSY while a scanner or indexer holds the file:
// 3 retries over about 1 s.
export function renameWithRetry(
  from: string,
  to: string,
  rename: (from: string, to: string) => void = renameSync,
  platform: NodeJS.Platform = process.platform,
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (platform !== 'win32' || (code !== 'EPERM' && code !== 'EBUSY') || attempt === 3) throw error;
      sleep(333);
    }
  }
}

// Creates the folders on the way, one level at a time, refusing any link.
function prepareFolders(target: WriteTarget, folders: string[]): void {
  let current = target.dir;
  for (const segment of ['', ...folders]) {
    current = segment === '' ? current : path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mkdirSync(current);
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      const error = new Error(`${current} is not a real folder`) as NodeJS.ErrnoException;
      error.code = 'ELINK';
      throw error;
    }
  }
}

export function writeAtomic(target: WriteTarget, parts: string[], data: string | Uint8Array): void {
  const shown = ['.rough-ride', ...parts].join('/');
  const refused = refusedName(parts);
  if (refused !== null) throw new Error(`refused write of ${shown}: ${refused}`);
  const file = path.join(target.dir, ...parts);
  const tmp = path.join(path.dirname(file), `tmp-${randomBytes(4).toString('hex')}${path.extname(file)}`);
  try {
    prepareFolders(target, parts.slice(0, -1));
    try {
      if (lstatSync(file).isSymbolicLink()) {
        const error = new Error(`${file} is a link`) as NodeJS.ErrnoException;
        error.code = 'ELINK';
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    writeFileSync(tmp, typeof data === 'string' ? redactSecrets(data) : data, { flag: 'wx' });
    renameWithRetry(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temporary file was never made, or is already gone.
    }
    stopWith('write-failed', `Can't write ${shown}: ${(error as NodeJS.ErrnoException).code ?? 'error'}.`);
  }
}
