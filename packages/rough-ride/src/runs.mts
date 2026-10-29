// Run folders under .rough-ride/runs/ (spec part 9 section 38 and part 2
// section 6.8): ids, creation, retention and the unfinished-run note.

import { randomInt } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { stopWith } from './exit.mjs';
import type { FlowLock } from './lock.mjs';
import type { Note } from './output.mjs';
import type { FolderState } from './folder.mjs';

export const RUN_ID = /^[0-9]{8}-[0-9]{6}-[a-z]+-[a-z0-9]{4}$/;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const KEEP = 10;
const YOUNG_MS = 10 * 60 * 1000;
const TIER_WORDS = new Set(['quick', 'standard', 'plan']);

export function randomSuffix(): string {
  let out = '';
  for (let i = 0; i < 4; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

// YYYYMMDD-HHMMSS-<first word of the subcommand>-<4 characters>, in UTC.
export function makeRunId(subcommand: string, now: Date, suffix: string): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${stamp}-${subcommand.split(' ')[0]}-${suffix}`;
}

function runTime(id: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(id)!;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
}

function word(id: string): string {
  return id.split('-')[2]!;
}

export interface RunFolder {
  id: string;
  dir: string;
}

// The run folder this invocation created, so an interrupt can write its
// summary there (51.13). One CLI process runs one invocation.
let created: RunFolder | null = null;
export function lastRunFolder(): RunFolder | null {
  return created;
}

// A non-recursive mkdir; on EEXIST a new suffix is drawn, up to 5 times.
export function createRunFolder(
  folder: FolderState,
  subcommand: string,
  options: { now?: Date; suffix?: () => string } = {},
): RunFolder {
  const runs = path.join(folder.dir, 'runs');
  const draw = options.suffix ?? randomSuffix;
  const now = options.now ?? new Date();
  let lastCode = 'EEXIST';
  try {
    mkdirSync(runs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      stopWith('write-failed', `Can't write .rough-ride/runs/: ${(error as NodeJS.ErrnoException).code}.`);
    }
  }
  if (lstatSync(runs).isSymbolicLink()) stopWith('write-failed', "Can't write .rough-ride/runs/: ELINK.");
  for (let attempt = 0; attempt < 6; attempt++) {
    const id = makeRunId(subcommand, now, draw());
    const dir = path.join(runs, id);
    try {
      mkdirSync(dir);
      created = { id, dir };
      return created;
    } catch (error) {
      lastCode = (error as NodeJS.ErrnoException).code ?? 'error';
      if (lastCode !== 'EEXIST') break;
    }
  }
  return stopWith('write-failed', `Can't write .rough-ride/runs/<run id>/: ${lastCode}.`);
}

function runFolders(folder: FolderState): string[] {
  const runs = path.join(folder.dir, 'runs');
  if (!existsSync(runs)) return [];
  return readdirSync(runs)
    .filter((name) => RUN_ID.test(name))
    .filter((name) => {
      const stat = lstatSync(path.join(runs, name));
      return stat.isDirectory() && !stat.isSymbolicLink();
    })
    .sort();
}

// Keeps the newest 10 tier runs and the newest 10 other runs, by name. Never
// the current run or one under 10 minutes old. Only under the flow lock.
export function pruneRuns(folder: FolderState, _lock: FlowLock, current: string | null, now = Date.now()): string[] {
  const all = runFolders(folder);
  const removed: string[] = [];
  for (const tier of [true, false]) {
    const group = all.filter((id) => TIER_WORDS.has(word(id)) === tier).reverse();
    for (const id of group.slice(KEEP)) {
      if (id === current || now - runTime(id) < YOUNG_MS) continue;
      rmSync(path.join(folder.dir, 'runs', id), { recursive: true, force: true });
      removed.push(id);
    }
  }
  return removed;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// When the newest quick, standard, regress or plan run (other than this one)
// never finished: no summary.json, or for a plan run, attacks in attacks.jsonl
// while its summary still says planned.
export function unfinishedRunNote(folder: FolderState, _lock: FlowLock, current: string | null): Note | null {
  const candidates = runFolders(folder)
    .filter((id) => id !== current && ['quick', 'standard', 'regress', 'plan'].includes(word(id)))
    .reverse();
  for (const id of candidates) {
    const dir = path.join(folder.dir, 'runs', id);
    const summary = readJson(path.join(dir, 'summary.json')) as { phase?: string } | null;
    let unfinished: boolean;
    if (word(id) === 'plan') {
      let attacks = '';
      try {
        attacks = readFileSync(path.join(dir, 'attacks.jsonl'), 'utf8');
      } catch {
        // No attacks yet.
      }
      unfinished = attacks.trim() !== '' && summary?.phase === 'planned';
    } else {
      unfinished = !existsSync(path.join(dir, 'summary.json'));
    }
    if (!unfinished) return null;
    return {
      id: 'unfinished-run',
      text: `Unfinished run ${id}: it stopped before its report (killed or crashed); attacks so far are in its attacks.jsonl.`,
    };
  }
  return null;
}
