// Finding the git root, and the few git questions the folder rules ask
// (spec part 2 sections 6.1, 6.2, 6.6 and 6.9).

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { canon, samePath } from '../hooks/path-check.mjs';
import { makeStop, type Stop } from './exit.mjs';

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  // Set when git could not be started at all.
  spawnError?: NodeJS.ErrnoException;
}

// git runs with an argument array, never a shell, in the C locale so its
// messages can be matched. GIT_DIR and GIT_WORK_TREE pass through.
export function git(args: string[], cwd: string): GitResult {
  const result = spawnSync('git', ['--no-optional-locks', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C' },
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { spawnError: result.error as NodeJS.ErrnoException } : {}),
  };
}

export function isWindowsAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(p);
}

export type RootResult = { root: string } | { stop: Stop };

export function findGitRoot(cwd: string, platform: NodeJS.Platform = process.platform): RootResult {
  const result = git(['rev-parse', '--show-toplevel'], cwd);
  return classifyRevParse(result, cwd, platform, homedir());
}

export function classifyRevParse(result: GitResult, cwd: string, platform: NodeJS.Platform, home: string): RootResult {
  if (result.spawnError) {
    if (result.spawnError.code === 'ENOENT') {
      return { stop: makeStop('git-missing', ['git not found on PATH: rough-patch needs git to read the diff.']) };
    }
    return { stop: makeStop('git-failed', [`git rev-parse failed in ${cwd}: ${result.spawnError.message}`]) };
  }
  if (result.status !== 0) {
    if (/not a git repository/i.test(result.stderr)) {
      return {
        stop: makeStop('no-repository', [
          'No git repository here: rough-patch attacks what the diff changes. Run it inside the app\'s repository.',
        ]),
      };
    }
    const first = result.stderr.split(/\r?\n/).find((line) => line.trim() !== '') ?? `exit ${result.status}`;
    return { stop: makeStop('git-failed', [`git rev-parse failed in ${cwd}: ${first}`]) };
  }
  const printed = result.stdout.replace(/\r?\n$/, '');
  if (platform === 'win32' && !isWindowsAbsolute(printed)) {
    return {
      stop: makeStop('git-not-windows', [`git printed ${printed}, which isn't a Windows path. Use Git for Windows.`]),
    };
  }
  const root = canon(printed, platform);
  if (samePath(root, home)) {
    return {
      stop: makeStop('home-root', [
        `The git repository here is your home folder (${root}). Run rough-patch inside the app's own repository.`,
      ]),
    };
  }
  return { root };
}

// Paths git tracks under `paths`, NUL-separated so no name is quoted.
export function lsFiles(root: string, paths: string[]): string[] {
  const result = git(['ls-files', '-z', '--', ...paths], root);
  return result.status === 0 ? result.stdout.split('\0').filter(Boolean) : [];
}
