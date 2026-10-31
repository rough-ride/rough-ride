// Before flows run (spec part 2 sections 9.2 to 9.4, part 3 section 12.5):
// reset, the ${env} check, then the sign-in flow once, alone, whose session
// stays in memory for every signed-in flow.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Browser } from 'playwright-core';
import { printed } from '../hooks/path-check.mjs';
import type { Config } from './config.mjs';
import { makeStop, StopError, stopWith } from './exit.mjs';
import { readFolderFile, type FolderState } from './folder.mjs';
import type { LocalhostGuard } from './guard.mjs';
import type { HostPolicy } from './hosts.mjs';
import { envNames, runFlow, type Flow, type FlowRunResult, type ReadyWait, type RunFlowOptions } from './flowrun.mjs';
import { addSecret, addSessionSecrets } from './secrets.mjs';
import { redact, runToEnd } from './start.mjs';

// KEY=VALUE lines; `#` comments, `export ` prefixes and matching quotes allowed.
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[1] === '"' ? quoted[2]!.replace(/\\n/g, '\n').replace(/\\"/g, '"') : quoted[2]!;
    else value = value.replace(/\s+#.*$/, '');
    out[m[1]!] = value;
  }
  return out;
}

// The process environment first, then <git root>/.rough-ride/.env. Never the
// app's own .env files. Every value read becomes a secret.
export function envReader(folder: FolderState, env: NodeJS.ProcessEnv = process.env): (name: string) => string | undefined {
  const file = parseDotenv(readFolderFile(folder, '.env') ?? '');
  return (name) => {
    const value = env[name] ?? file[name];
    if (value !== undefined) addSecret(value, `\${env.${name}}`);
    return value;
  };
}

function listNames(names: string[]): string {
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

// Every ${env...} the flow uses is set, or the invocation stops before it runs.
// A value that is set but empty counts as missing, because GitHub expands an
// unavailable secret to "" (51.8).
export function checkEnv(flow: Flow, read: (name: string) => string | undefined, folder: FolderState, env: NodeJS.ProcessEnv = process.env): void {
  const missing = envNames(flow.steps).filter((name) => {
    const value = read(name);
    return value === undefined || value === '';
  });
  if (missing.length === 0) return;
  const what = flow.name === 'sign-in' ? 'The sign-in flow' : `Flow ${flow.name}`;
  const lines = [
    `${what} uses ${listNames(missing)}, which ${missing.length === 1 ? "isn't" : "aren't"} set. Set ${missing.length === 1 ? 'it' : 'them'} in the environment, or set ${missing.length === 1 ? 'it' : 'them'} in .rough-ride/.env (${printed(path.join(folder.dir, '.env'))}).`,
  ];
  const pr = pullRequestLine(listNames(missing), missing.length, env);
  if (pr) lines.push(pr);
  stopWith('env-missing', ...lines);
}

// The missing-variable stop's line in a pull request, by who opened it (52.5).
export function pullRequestLine(names: string, count: number, env: NodeJS.ProcessEnv): string | null {
  if (env.GITHUB_EVENT_NAME !== 'pull_request') return null;
  let head: unknown = null;
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8')) as { pull_request?: { head?: { repo?: { full_name?: unknown } | null } } };
    head = event.pull_request?.head?.repo?.full_name ?? null;
  } catch {
    head = null;
  }
  if (head === null || head !== env.GITHUB_REPOSITORY) return "Pull requests from forks get no secrets, so the sign-in flow can't run here.";
  if (env.GITHUB_ACTOR === 'dependabot[bot]') return `Dependabot pull requests get only Dependabot secrets: add ${names} under Settings > Secrets and variables > Dependabot.`;
  return count === 1
    ? `This run got no value for ${names}: add it as a repository secret and map it in the workflow step's env, or use CI-only values (README: GitHub Actions).`
    : `This run got no value for ${names}: add them as repository secrets and map them in the workflow step's env, or use CI-only values (README: GitHub Actions).`;
}

// The sign-in flow's variables, checked as soon as flows are read: before
// --start, reset or any browser, in every mode (51.8).
export function checkSignInEnv(flows: Flow[], folder: FolderState, env: NodeJS.ProcessEnv): void {
  const flow = flows.find((f) => f.name === 'sign-in');
  if (flow) checkEnv(flow, envReader(folder, env), folder, env);
}

// reset runs only when configured, never guessed, in the git root.
export async function runReset(config: Config | null, root: string): Promise<{ ran: boolean; ms: number }> {
  if (!config?.reset) return { ran: false, ms: 0 };
  const started = Date.now();
  const result = await runToEnd(config.reset, root);
  if (result.code !== 0) {
    throw new StopError(
      makeStop('reset-failed', [
        `reset failed: ${config.reset} exited with ${result.code === null ? result.signal : `code ${result.code}`}.`,
        "(last 20 lines of reset's output: printed only)",
      ]),
      null,
      ["Last 20 lines of reset's output:", ...result.tail.map((l) => `  ${redact(l, [])}`)],
    );
  }
  return { ran: true, ms: Date.now() - started };
}

// A refused connection to a loopback origin during a flow run.
export function refusedStop(result: FlowRunResult, targetUrl: string): void {
  if (result.refused === null) return;
  if (result.refused === new URL(targetUrl).origin) {
    stopWith('nothing-running', `Nothing answers at ${targetUrl} any more. Start the app again, then run again.`);
  }
  stopWith('nothing-at-api', `Nothing answers at ${result.refused}. Start the API or set target.start.`);
}

export interface SignInOutcome {
  // null when there is no sign-in flow.
  ran: boolean;
  passed: boolean;
  result: FlowRunResult | null;
  storageState: FlowRunResult['storageState'];
  // `Sign-in failed at step 3 (fill label "Email"): <message>.`
  line: string | null;
  // Refused runs and the waits before the run that got an HTTP answer.
  waitedMs: number;
}

export async function signIn(options: {
  browser: Browser;
  baseURL: string;
  flows: Flow[];
  read: (name: string) => string | undefined;
  folder: FolderState;
  ready: ReadyWait;
  exclude?: string[];
  // The Bash tool's 550 s stop, with a plugin data folder.
  deadline?: number;
  // flow save's own sign-in flow runs untrusted (44.5), with the guard and the host rules.
  untrusted?: boolean;
  hosts?: HostPolicy;
  guard?: LocalhostGuard;
  // App-specific checks' baseline probe (45.8 gate 6).
  onPoint?: RunFlowOptions['onPoint'];
  // --start: retry a run refused by a loopback origin every 2 s until then (51.6).
  waitUntil?: number | null;
}): Promise<SignInOutcome> {
  const flow = options.flows.find((f) => f.name === 'sign-in');
  if (!flow) return { ran: false, passed: false, result: null, storageState: null, line: null, waitedMs: 0 };
  checkEnv(flow, options.read, options.folder);
  const once = () => runFlow({
    browser: options.browser,
    baseURL: options.baseURL,
    flow,
    env: options.read,
    ready: options.ready,
    exclude: options.exclude ?? [],
    keepStorageState: true,
    shots: 'all',
    ...(options.deadline !== undefined && options.deadline !== Infinity ? { deadline: options.deadline } : {}),
    ...(options.untrusted ? { untrusted: true } : {}),
    ...(options.hosts ? { hosts: options.hosts } : {}),
    ...(options.guard ? { guard: options.guard } : {}),
    ...(options.onPoint ? { onPoint: options.onPoint } : {}),
  });
  // A slow API next to a fast app: refused runs and the waits between them are
  // app start, never budgeted time (resolution 133).
  const firstStarted = Date.now();
  let waitedMs = 0;
  let result = await once();
  while (result.refused !== null && options.waitUntil && Date.now() < options.waitUntil) {
    await new Promise((r) => setTimeout(r, 2000));
    waitedMs = Date.now() - firstStarted;
    result = await once();
  }
  refusedStop(result, options.baseURL);
  if (result.storageState) addSessionSecrets(result.storageState);
  const signedIn = options.flows.filter((f) => f.signedIn && f.name !== 'sign-in').length;
  const line = result.failure
    ? `Sign-in failed at step ${result.failure.step} (${result.failure.label}): ${result.failure.message.slice(result.failure.label.length + 2)}. ${signedIn} signed-in flows not attacked.`
    : null;
  return { ran: true, passed: result.passed, result, storageState: result.storageState, line, waitedMs };
}

// Flows that passed every check run; one failing only step 5 is listed and not
// run until ticket 30 adds its reviewed version.
export function runnableFlows(files: { shown: string; value: Record<string, unknown> | null; step5: string[] }[]): {
  flows: Flow[];
  notRun: string[];
} {
  const flows: Flow[] = [];
  const notRun: string[] = [];
  for (const file of files) {
    const name = file.shown.split('/').at(-1)!.replace(/\.yaml$/, '');
    if (file.step5.length > 0 || file.value === null) {
      notRun.push(name);
      continue;
    }
    flows.push({ name, signedIn: file.value.signedIn as boolean, steps: file.value.steps as Flow['steps'] });
  }
  return { flows, notRun };
}
