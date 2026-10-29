// Finding, proving and starting the target (spec part 2 section 8) and the
// loopback rule (section 10.1).

import { lookup } from 'node:dns/promises';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import { canon, isFolderName, samePath } from '../hooks/path-check.mjs';
import type { Config } from './config.mjs';
import { stopWith } from './exit.mjs';
import { configHeader, FORMATS } from './formats.mjs';
import { git } from './git.mjs';
import type { Note } from './output.mjs';
import { startCommands, type Started } from './start.mjs';

// Ticket 14 item 3's dropped folders.
export const DROPPED = new Set([
  'node_modules', '.venv', 'venv', '__pycache__', '.nuxt', '.output', '.next', '.svelte-kit', 'dist', 'build',
  'coverage', '.turbo', '.vercel', '.pytest_cache', '.mypy_cache', '.ruff_cache',
]);

export interface NuxtCandidate {
  // Absolute path of the folder holding nuxt.config.*.
  dir: string;
  // Repo-relative with `/`, ending in `/`; `` for the root.
  rel: string;
}

export interface NuxtLock {
  raw: Buffer;
  pid: number;
  cwd: string;
  port: number | null;
}

export interface Target {
  url: string;
  proof: 'nuxt-lock' | 'config';
  started: boolean;
  // The proven Nuxt root page tracing uses, when there is one.
  nuxtRoot: NuxtCandidate | null;
  children: Started | null;
  // With --start: from the start command to the first answer, and when
  // target.startTimeout runs out, counted from the start command (51.6).
  startMs: number;
  apiWaitUntil: number | null;
}

export interface FindOptions {
  root: string;
  config: Config | null;
  // Whether a config.yaml with content exists, and its schema, for the ask YAML.
  configSchema: string | null;
  start: boolean;
  pluginData: string | null;
  // The tier command a person runs again, in the form that ran the runner.
  againCommand: string;
  notes: Note[];
  // Values to redact from a failing --start's output.
  secrets?: string[];
  // How long an attached Nuxt app may take to finish its lock file.
  attachWaitMs?: number;
}

// One listing from the git root: nuxt.config.* whose folder's package.json
// depends on nuxt, outside dropped and .rough-ride folders.
export function nuxtCandidates(root: string): NuxtCandidate[] {
  const listed = git(
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ':(glob)**/nuxt.config.*', ':(glob,icase)**/.rough-ride/**'],
    root,
  );
  const found: NuxtCandidate[] = [];
  for (const file of listed.stdout.split('\0').filter(Boolean)) {
    const segments = file.split('/');
    if (!/^nuxt\.config\.[a-z]+$/.test(segments.at(-1)!)) continue;
    if (segments.slice(0, -1).some((s) => DROPPED.has(s) || isFolderName(s))) continue;
    const dir = path.join(root, ...segments.slice(0, -1));
    if (!dependsOnNuxt(dir)) continue;
    const rel = segments.slice(0, -1).join('/');
    if (!found.some((c) => c.dir === dir)) found.push({ dir, rel: rel === '' ? '' : `${rel}/` });
  }
  return found.sort((a, b) => a.rel.localeCompare(b.rel));
}

function dependsOnNuxt(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
    return ['dependencies', 'devDependencies'].some((key) => pkg[key]?.nuxt !== undefined);
  } catch {
    return false;
  }
}

function processAlive(pid: number): boolean {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// A lock left by a dev server that was killed hard counts as no lock.
export function readLock(candidate: NuxtCandidate): NuxtLock | null {
  try {
    const raw = readFileSync(path.join(candidate.dir, '.nuxt', 'nuxt.lock'));
    const parsed = JSON.parse(raw.toString('utf8')) as { pid?: number; cwd?: string; port?: number };
    if (typeof parsed.cwd !== 'string') return null;
    if (typeof parsed.pid === 'number' && !processAlive(parsed.pid)) return null;
    return { raw, pid: parsed.pid ?? 0, cwd: parsed.cwd, port: typeof parsed.port === 'number' ? parsed.port : null };
  } catch {
    return null;
  }
}

// `/_nuxt/@fs<cwd>/.nuxt/nuxt.lock`, in the lock's own spelling of cwd; a
// Windows drive path gains the leading slash Vite expects.
export function lockUrlPath(cwd: string): string {
  const forward = cwd.replace(/\\/g, '/');
  return `/_nuxt/@fs${forward.startsWith('/') ? '' : '/'}${encodeURI(forward)}/.nuxt/nuxt.lock`;
}

function fetchBytes(address: string, port: number, urlPath: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const req = request(
      { host: address, port, path: urlPath, headers: { host: `localhost:${port}` }, timeout: 3000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(res.statusCode === 200 ? Buffer.concat(chunks) : null));
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

// The lock proof: the server that answers for localhost:<port> serves the
// lock file's own bytes. Nuxt dev binds ::1 only and 127.0.0.1 can be another
// process, so every address localhost resolves to is tried.
export async function proveLock(candidate: NuxtCandidate): Promise<{ lock: NuxtLock; url: string } | null> {
  const lock = readLock(candidate);
  if (lock === null || lock.port === null) return null;
  try {
    if (!samePath(lock.cwd, candidate.dir)) return null;
  } catch {
    return null;
  }
  const addresses = await lookup('localhost', { all: true }).catch(() => [{ address: '::1' }, { address: '127.0.0.1' }]);
  for (const { address } of addresses) {
    const served = await fetchBytes(address, lock.port, lockUrlPath(lock.cwd));
    if (served !== null && served.equals(lock.raw)) return { lock, url: `http://localhost:${lock.port}` };
  }
  return null;
}

export function isLoopbackAddress(address: string): boolean {
  if (isIP(address) === 4) return address.startsWith('127.');
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    return lower === '::1' || /^::ffff:127\./.test(lower) || /^0{0,4}(:0{0,4}){6}:0{0,3}1$/.test(lower);
  }
  return false;
}

// A host is loopback only when it resolves only to loopback addresses.
export async function isLoopbackHost(host: string): Promise<boolean> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare)) return isLoopbackAddress(bare);
  const lower = bare.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  try {
    const addresses = await lookup(bare, { all: true });
    return addresses.length > 0 && addresses.every((a) => isLoopbackAddress(a.address));
  } catch {
    return false;
  }
}

export interface StartCommand {
  command: string;
  // Absolute working folder.
  cwd: string;
}

function packageManager(dir: string, root: string): string {
  for (const folder of [dir, root]) {
    if (existsSync(path.join(folder, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(path.join(folder, 'yarn.lock'))) return 'yarn';
    if (existsSync(path.join(folder, 'bun.lock')) || existsSync(path.join(folder, 'bun.lockb'))) return 'bun';
    if (existsSync(path.join(folder, 'package-lock.json'))) return 'npm';
  }
  return 'npm';
}

function hasDevScript(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    return typeof pkg.scripts?.dev === 'string';
  } catch {
    return false;
  }
}

// The git root's dev script, else the Nuxt folder's, with the package manager
// its lockfile names. Each runs in its own folder.
export function detectStartCommand(root: string, candidate: NuxtCandidate | null): StartCommand | null {
  for (const dir of [root, candidate?.dir].filter((d): d is string => d !== undefined)) {
    if (hasDevScript(dir)) return { command: `${packageManager(dir, root)} run dev`, cwd: dir };
  }
  return null;
}

// The port a Nuxt dev script asks for, so a stop can name the URL nothing answers at.
function nuxtPort(candidate: NuxtCandidate): number {
  try {
    const pkg = JSON.parse(readFileSync(path.join(candidate.dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const port = /--port[= ](\d+)/.exec(pkg.scripts?.dev ?? '')?.[1];
    return port ? Number(port) : 3000;
  } catch {
    return 3000;
  }
}

function askYaml(options: FindOptions, lines: string[]): string[] {
  const yaml = configHeader().trimEnd().split('\n');
  if (options.configSchema !== null && options.configSchema !== FORMATS.config.current) {
    yaml.push(`# Also change schema: ${options.configSchema} at the top of .rough-ride/config.yaml to schema: ${FORMATS.config.current}.`);
  }
  return [...yaml, ...lines];
}

function ask(options: FindOptions, found: string, candidates: NuxtCandidate[]): never {
  const example = candidates[0];
  const start = example ? detectStartCommand(options.root, example) : null;
  const yaml = ['target:', `  url: http://localhost:${example ? nuxtPort(example) : 3000}`];
  if (start) yaml.push(`  start: ${start.command}`);
  else yaml.push('  start: <the command that starts your app>');
  return stopWith('ask', found, 'Add this to .rough-ride/config.yaml, with the URL your app answers at:', ...askYaml(options, yaml));
}

function nothingRunning(options: FindOptions, url: string, start: StartCommand | null): never {
  if (start === null) {
    return stopWith(
      'nothing-running',
      `Nothing answers at ${url}, and no dev script was found to start it. Add this to .rough-ride/config.yaml:`,
      ...askYaml(options, ['target:', `  url: ${url}`, '  start: <the command that starts your app>']),
    );
  }
  const where = `${start.command} in ${canon(start.cwd)}`;
  if (options.pluginData !== null) {
    return stopWith(
      'nothing-running',
      `Nothing answers at ${url}. Start the app in a background shell (${where}), then run ${options.againCommand} again.`,
    );
  }
  return stopWith('nothing-running', `Nothing answers at ${url}. Start the app (${where}), or run again with --start.`);
}

// Any HTTP response at all.
export function answers(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    let req;
    try {
      req = request(url, { method: 'GET', timeout: 3000 }, (res) => {
        res.resume();
        resolve(res.statusCode ?? null);
      });
    } catch {
      resolve(null);
      return;
    }
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function proveWithin(candidate: NuxtCandidate, ms: number) {
  const until = Date.now() + ms;
  for (;;) {
    const proof = await proveLock(candidate);
    if (proof || Date.now() >= until) return proof;
    await sleep(250);
  }
}

export async function findTarget(options: FindOptions): Promise<Target> {
  const { root, config } = options;
  const candidates = nuxtCandidates(root);
  const attachWait = options.attachWaitMs ?? 10_000;
  const proofs = await Promise.all(
    candidates.map(async (c) => ({ candidate: c, lock: readLock(c), proof: readLock(c) ? await proveWithin(c, attachWait) : null })),
  );

  if (config?.target?.url) {
    const url = config.target.url;
    const host = new URL(url).hostname;
    const loopback = await isLoopbackHost(host);
    if (!loopback && config.allow?.remoteTarget !== host.replace(/^\[|\]$/g, '')) {
      stopWith(
        'target-not-loopback',
        `target.url ${url} is not on this machine (${host} does not resolve only to loopback addresses). rough-ride attacks local apps; allow.remoteTarget in .rough-ride/config.yaml can name one other host.`,
      );
    }
    // A proven Nuxt candidate serving the same loopback port gives page tracing its root.
    const port = new URL(url).port || '80';
    const same = loopback ? proofs.find((p) => p.proof && new URL(p.proof.url).port === port) : undefined;
    if (!same) {
      options.notes.push({ id: 'tracing', text: 'Page tracing: unavailable (no proven Nuxt root for target.url)' });
    }
    const nuxtRoot = same?.candidate ?? null;
    const status = await answers(url);
    if (options.start) {
      if (status !== null) {
        stopWith('start-conflict', `Something already answers at ${url}, so --start won't start a second copy. Stop it, or run again without --start.`);
      }
      const commands = config.target.start ?? detectStartCommand(root, candidates[0] ?? null)?.command;
      if (!commands) nothingRunning(options, url, null);
      const startedAt = Date.now();
      const timeoutMs = (config.target.startTimeout ?? 120) * 1000;
      const children = await startCommands({
        commands: Array.isArray(commands) ? commands : [commands],
        cwd: root,
        timeoutMs,
        ready: async () => {
          const code = await answers(url);
          return code !== null && code >= 200 && code < 400;
        },
        describe: url,
        secrets: options.secrets ?? [],
      });
      return { url, proof: 'config', started: true, nuxtRoot, children, startMs: Date.now() - startedAt, apiWaitUntil: startedAt + timeoutMs };
    }
    if (status === null) {
      const start = config.target.start
        ? { command: [config.target.start].flat().join(' and '), cwd: root }
        : detectStartCommand(root, candidates[0] ?? null);
      nothingRunning(options, url, start);
    }
    return { url, proof: 'config', started: false, nuxtRoot, children: null, startMs: 0, apiWaitUntil: null };
  }

  const proven = proofs.filter((p) => p.proof !== null);
  if (proven.length === 1) {
    const { candidate, proof } = proven[0]!;
    // --start with a proven running app attaches and starts nothing.
    return { url: proof!.url, proof: 'nuxt-lock', started: false, nuxtRoot: candidate, children: null, startMs: 0, apiWaitUntil: null };
  }
  if (candidates.length === 0) {
    ask(options, 'No Nuxt app found in this repository and no target.url in .rough-ride/config.yaml.', []);
  }
  if (candidates.length > 1) {
    const names = candidates.map((c) => c.rel || './').join(', ');
    const running = proven.length === 0 ? 'none of them is running' : `${proven.length} of them are running`;
    ask(options, `Found ${candidates.length} Nuxt apps (${names}) and ${running}, so rough-ride can't tell which one to attack.`, candidates);
  }

  const candidate = candidates[0]!;
  const lock = proofs[0]!.lock;
  if (lock !== null && !options.start) {
    stopWith(
      'target-unproven',
      `${candidate.rel}.nuxt/nuxt.lock names a dev server, but what answers at http://localhost:${lock.port ?? nuxtPort(candidate)} doesn't serve that lock file. Restart the dev server, or set target.url in .rough-ride/config.yaml.`,
    );
  }
  const start = config?.target?.start
    ? { command: [config.target.start].flat().join(' and '), cwd: root }
    : detectStartCommand(root, candidate);
  if (!options.start) nothingRunning(options, `http://localhost:${nuxtPort(candidate)}`, start);
  if (start === null) nothingRunning(options, `http://localhost:${nuxtPort(candidate)}`, null);

  let proof: Awaited<ReturnType<typeof proveLock>> = null;
  const startedAt = Date.now();
  const timeoutMs = (config?.target?.startTimeout ?? 120) * 1000;
  const children = await startCommands({
    commands: config?.target?.start ? [config.target.start].flat() : [start.command],
    cwd: config?.target?.start ? root : start.cwd,
    timeoutMs,
    ready: async () => {
      proof = await proveLock(candidate);
      return proof !== null;
    },
    describe: `the Nuxt app in ${candidate.rel || './'}`,
    secrets: options.secrets ?? [],
  });
  return { url: proof!.url, proof: 'nuxt-lock', started: true, nuxtRoot: candidate, children, startMs: Date.now() - startedAt, apiWaitUntil: startedAt + timeoutMs };
}

