// The Target session: what every flow-running subcommand opens before its
// first flow run, always in the same order (spec part 2 sections 8 to 10, part
// 3 section 12.5): the proven Target, the flow lock, the run folder, the
// browser and the localhost guard, then reset and the sign-in flow. It hands
// out the Flow run defaults and closes everything in one teardown.

import type { Browser } from 'playwright-core';
import { chooseBrowser, installedOnThisMachine, launchBrowser, type BrowserName, type Launched } from './browser.mjs';
import type { Config } from './config.mjs';
import { StopError } from './exit.mjs';
import { wroteFile, type CheckedFiles } from './files.mjs';
import type { FolderState } from './folder.mjs';
import type { Flow, ReadyWait, RunFlowOptions } from './flowrun.mjs';
import { LocalhostGuard } from './guard.mjs';
import { hostPolicy, type HostPolicy } from './hosts.mjs';
import { takeFlowLock, type FlowLock } from './lock.mjs';
import type { Note } from './output.mjs';
import type { RunnerInfo } from './runner.mjs';
import type { RunReport } from './runoutput.mjs';
import { bashBlocksStart, bashDeadline } from './runcheck.mjs';
import { createRunFolder, pruneRuns, unfinishedRunNote, type RunFolder } from './runs.mjs';
import { credentialStrings } from './secrets.mjs';
import { envReader, runReset, signIn, type SignInOutcome } from './session.mjs';
import { findTarget, type Target } from './target.mjs';

type EnvReader = (name: string) => string | undefined;

// What every flow run of the session starts from; a subcommand adds the flow and its extras.
export type FlowRunDefaults = Omit<RunFlowOptions, 'flow'> & { hosts: HostPolicy };

export interface TargetSessionOptions {
  root: string;
  folder: FolderState;
  files: CheckedFiles;
  info: RunnerInfo;
  argv: string[];
  env: NodeJS.ProcessEnv;
  notes: Note[];
  // Told about the run folder the session makes, so an interrupt writes there (51.13).
  report: Pick<RunReport, 'madeRun'>;
  config: Config | null;
  // The flows sign-in picks its flow from: the effective ones, or flow save's new sign-in.
  flows: Flow[];
  // --start; snapshot never starts the app.
  start: boolean;
  againCommand: string;
  browserFlag: BrowserName | null;
  // Replaces the browser launch (tests).
  launch?: (name: BrowserName) => Promise<Launched>;
  elapsed: () => number;
  progress?: (line: string) => void;
  // A new run folder for this subcommand word, a run that already exists, or none (snapshot).
  run: { create: string } | { existing: RunFolder; prune: boolean } | null;
  // Whether reset runs before the sign-in flow; snapshot never resets (44.1).
  reset: boolean;
  // Notes an earlier run that stopped before its report, before this run's folder exists (tiers).
  noteUnfinishedRun?: boolean;
  // Whether the Bash limits (50.4) bound this session's flow runs; repro has none.
  bashLimits?: boolean;
  // The reader the subcommand already checked its flows' variables with.
  read?: EnvReader;
}

export interface TargetSession {
  readonly target: Target;
  readonly run: RunFolder | null;
  readonly hosts: HostPolicy;
  readonly launched: Launched;
  readonly guard: LocalhostGuard | undefined;
  readonly ready: ReadyWait;
  readonly exclude: string[];
  readonly read: EnvReader;
  // The Bash tool's 550 s stop, or Infinity without a plugin data folder.
  readonly bashStop: number;
  // No flow run starts after 500 s in a session (50.4).
  bashBlocks(): boolean;
  // The kept sign-in session's credential strings (20.6).
  readonly credentials: string[];
  // Runs reset; returns how long it took.
  reset(): Promise<number>;
  // The invocation's sign-in: it waits for a --start API, and every signed-in
  // flow starts from its session. flow save runs a new sign-in flow untrusted.
  signIn(options?: { untrusted?: boolean; onPoint?: RunFlowOptions['onPoint'] }): Promise<SignInOutcome>;
  // One more run of the sign-in flow; the kept session stays.
  signInAgain(options?: { untrusted?: boolean; deadline?: number }): Promise<SignInOutcome>;
  // The session refresh (49.5 step 8): keeps the new session when it passed.
  refreshSignIn(deadline?: number): Promise<boolean>;
  defaults(flow: Flow): FlowRunDefaults;
  // A stop after the run folder exists names the run, so its block lands in that run (46.5).
  withRun(error: unknown): unknown;
  // Guard, browser, --start children, then the flow lock. Safe to call twice.
  close(): Promise<void>;
}

export function readyWaitFor(target: Target, config: Config | null): ReadyWait {
  if (config?.target?.ready) return { kind: 'expression', expression: config.target.ready };
  return target.nuxtRoot && target.proof === 'nuxt-lock' ? { kind: 'nuxt' } : { kind: 'load' };
}

export async function openTargetSession(options: TargetSessionOptions): Promise<TargetSession> {
  const { root, folder, config, info, notes } = options;
  options.progress?.('Finding the target');
  const target = await findTarget({
    root,
    config,
    configSchema: options.files.config?.schema?.text ?? null,
    start: options.start,
    pluginData: info.pluginData?.path ?? null,
    againCommand: options.againCommand,
    notes,
  });
  const hosts = hostPolicy(config?.allow);
  let lock: FlowLock | null = null;
  let browser: Browser | null = null;
  let guard: LocalhostGuard | undefined;
  // Also what a failed open closes: only what it opened.
  const teardown = async () => {
    guard?.close();
    await browser?.close().catch(() => {});
    target.children?.stop();
    lock?.release();
  };
  let run: RunFolder | null = null;
  let launched: Launched;
  try {
    wroteFile(options.files, info, root, target.nuxtRoot?.rel ?? null, options.argv);
    lock = takeFlowLock(root, notes);
    if (options.noteUnfinishedRun) {
      const unfinished = unfinishedRunNote(folder, lock, null);
      if (unfinished) notes.push(unfinished);
    }
    if (options.run && 'create' in options.run) {
      run = createRunFolder(folder, options.run.create);
      options.report.madeRun(run);
      pruneRuns(folder, lock, run.id);
    } else if (options.run) {
      run = options.run.existing;
      if (options.run.prune) pruneRuns(folder, lock, run.id);
    }
    const choice = chooseBrowser(options.browserFlag, config?.browser ?? null, installedOnThisMachine(options.env));
    options.progress?.('Starting the browser');
    launched = options.launch ? await options.launch(choice.name) : await launchBrowser(choice, notes);
    browser = launched.browser;
    guard = launched.debugPort ? await LocalhostGuard.connect(launched.debugPort, hosts) : undefined;
  } catch (error) {
    await teardown();
    throw error;
  }

  const ready = readyWaitFor(target, config);
  const exclude = config?.exclude ?? [];
  // The Bash limits count from process start and cover every flow run (50.4).
  const limited = (options.bashLimits ?? true) && !!info.pluginData;
  const processStart = Date.now() - options.elapsed();
  const bashStop = bashDeadline(limited, processStart);
  let read = options.read;
  // Made after reset, which may write .rough-ride/.env.
  const reader = () => (read ??= envReader(folder, options.env));
  let resetDone = !options.reset;
  let kept: SignInOutcome['storageState'] = null;
  let credentials: string[] = [];
  let closed = false;

  const signInRun = async (extra: { untrusted?: boolean; deadline?: number; waitUntil?: number | null; onPoint?: RunFlowOptions['onPoint'] }) => {
    if (!resetDone) throw new Error('the sign-in flow runs only after reset');
    return signIn({
      browser: launched.browser,
      baseURL: target.url,
      flows: options.flows,
      read: reader(),
      folder,
      ready,
      exclude,
      deadline: extra.deadline ?? bashStop,
      ...(extra.waitUntil !== undefined ? { waitUntil: extra.waitUntil } : {}),
      // An untrusted sign-in flow gets the guard and the host rules of any untrusted run (44.5).
      ...(extra.untrusted ? { untrusted: true, hosts, guard } : {}),
      ...(extra.onPoint ? { onPoint: extra.onPoint } : {}),
    });
  };
  const keep = (state: SignInOutcome['storageState']) => {
    kept = state;
    credentials = credentialStrings(state);
  };

  return {
    target,
    run,
    hosts,
    launched,
    guard,
    ready,
    exclude,
    get read() {
      return reader();
    },
    bashStop,
    bashBlocks: () => bashBlocksStart(limited, processStart, Date.now()),
    get credentials() {
      return credentials;
    },
    async reset() {
      options.progress?.('Running reset');
      const started = Date.now();
      await runReset(config, root);
      resetDone = true;
      return Date.now() - started;
    },
    async signIn(extra = {}) {
      options.progress?.('Signing in');
      const outcome = await signInRun({ ...extra, waitUntil: target.apiWaitUntil });
      keep(outcome.storageState);
      return outcome;
    },
    signInAgain: (extra = {}) => signInRun(extra),
    async refreshSignIn(deadline) {
      const again = await signInRun({ ...(deadline !== undefined ? { deadline } : {}) });
      if (again.passed) keep(again.storageState);
      return again.passed;
    },
    defaults: (flow) => ({
      browser: launched.browser,
      baseURL: target.url,
      env: reader(),
      ready,
      exclude,
      hosts,
      storageState: flow.signedIn ? kept ?? undefined : undefined,
      credentials,
      guard,
      deadline: bashStop,
    }),
    withRun(error) {
      if (run && error instanceof StopError && error.run === null) return new StopError(error.stop, { id: run.id, dir: run.dir }, error.tail);
      return error;
    },
    async close() {
      if (closed) return;
      closed = true;
      await teardown();
    },
  };
}
