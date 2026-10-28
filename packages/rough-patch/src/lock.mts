// One flow-running invocation per repository (spec part 2 section 9.5): a
// lock file in the OS temp folder, keyed by the git root's (dev, ino).

import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stopWith } from './exit.mjs';
import type { Note } from './output.mjs';

export interface FlowLock {
  file: string;
  release(): void;
}

interface Holder {
  pid: number;
  startedAt: string;
}

export function lockPath(root: string): string {
  const stat = statSync(root, { bigint: true });
  return path.join(tmpdir(), `rough-patch-lock-${stat.dev}-${stat.ino}.json`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readHolder(file: string): Holder | null {
  try {
    const holder = JSON.parse(readFileSync(file, 'utf8')) as Holder;
    return Number.isInteger(holder.pid) ? holder : null;
  } catch {
    return null;
  }
}

// `2026-10-27 14:12:07 UTC`
function shownTime(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+Z$|Z$/, '') + ' UTC';
}

export function takeFlowLock(root: string, notes: Note[]): FlowLock {
  const file = lockPath(root);
  const mine: Holder = { pid: process.pid, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(mine), { flag: 'wx' });
      const release = () => {
        try {
          if (readHolder(file)?.pid === process.pid) unlinkSync(file);
        } catch {
          // Already gone.
        }
      };
      process.once('exit', release);
      return { file, release };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        stopWith('write-failed', `Can't write ${file}: ${(error as NodeJS.ErrnoException).code}.`);
      }
    }
    const holder = readHolder(file);
    if (holder !== null && alive(holder.pid)) {
      stopWith(
        'busy',
        `Another rough-patch invocation (pid ${holder.pid}, started ${shownTime(holder.startedAt)}) is running flows for this repository. Wait for it, or stop it (Ctrl-C in its terminal).`,
      );
    }
    if (holder !== null) {
      notes.push({
        id: 'lock-taken-over',
        text: `Took over the flow lock of rough-patch invocation pid ${holder.pid}, started ${shownTime(holder.startedAt)}: that process is gone.`,
      });
    }
    try {
      unlinkSync(file);
    } catch {
      // Another invocation took it over first; the next attempt sees its lock.
    }
  }
  return stopWith('busy', 'Another rough-patch invocation is taking the flow lock for this repository. Run again in a moment.');
}
