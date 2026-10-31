// The Run output of one invocation (spec part 9 sections 37 to 39, part 13
// section 51.13): what the run reports while it goes, and the one writer of
// its summary.txt, record.json, summary.json and adversary/summary.txt and of
// the stdout document, whether the invocation finishes, stops or is interrupted.

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ParsedArgs } from './args.mjs';
import { contractJson, type ContractStatus } from './contract.mjs';
import type { Diff } from './diff.mjs';
import { resolveExit, TAIL_PLACEHOLDER, type Status, type Stop } from './exit.mjs';
import { checkRootEntry } from './folder.mjs';
import { formatsReport } from './formats.mjs';
import type { InterruptSignal } from './interrupt.mjs';
import { canonicalJson, escapeName, headerLine, type Note } from './output.mjs';
import { blockWithHints, protectedJson, type ProtectedResult } from './protected.mjs';
import { ciMode, environmentRecord, runnerBlock, type RunnerInfo } from './runner.mjs';
import type { RunFolder } from './runs.mjs';
import { redactSecrets } from './secrets.mjs';
import { BLOCK_END, BLOCK_START, cutLine, orderNotes, type Section, type SectionId } from './summary.mjs';
import { writeAtomic } from './write.mjs';

// What a subcommand reports while it runs, so an outcome reached later, a
// stop or an interrupt included, still reports it.
export interface RunReport {
  // A run folder this invocation made: an interrupt writes its files there (51.13).
  madeRun(run: RunFolder): void;
  // The invocation's protected-file comparison (53.2).
  protectedFiles(result: ProtectedResult): void;
  // The contract status this invocation detected or carried from its plan (resolution 103).
  contract(status: ContractStatus | null): void;
}

// How an invocation finished.
export interface Outcome {
  status: Status;
  exitCode: number;
  lines: string[];
  // Fields this outcome adds to the JSON document.
  document?: Record<string, unknown>;
  // The run folder that gets this outcome's summary.txt and summary.json.
  run?: RunFolder | null;
  // record.json's fields beyond summary.json's; without them no record.json is written.
  record?: Record<string, unknown>;
}

export interface RunOutput extends RunReport {
  // The invocation's notes; subcommands add theirs.
  readonly notes: Note[];
  // Set by the first signal: from then on nothing else is written or printed.
  readonly interrupted: boolean;
  located(root: string): void;
  diffed(diff: Diff): void;
  // The run a --run call works in. `ownsFiles` (attack) also writes its run files there.
  namedRun(run: RunFolder, ownsFiles: boolean): void;
  finish(outcome: Outcome): void;
  // A stop names the run it carries, so its block lands in that run (46.5), and
  // writes its summary files there when this invocation made that run; `tail` is
  // reset or --start output, printed in place of the tail placeholder only.
  stop(stop: Stop, options?: { run?: RunFolder | null; tail?: string[] | null }): void;
  // Writes the run's files and the stdout document, before the exit that ends
  // the browser and the --start children (51.13).
  interrupt(signal: InterruptSignal): Promise<void>;
}

export interface OutputStreams {
  stdout(text: string): void;
  stderr(text: string): void;
  exitCode(code: number): void;
  // Resolves once both streams wrote what they were given.
  drain(): Promise<void>;
}

export interface RunOutputOptions {
  args: ParsedArgs;
  info: RunnerInfo;
  cwd: string;
  env: NodeJS.ProcessEnv;
  elapsed: () => number;
  // The process's streams unless given (tests).
  streams?: OutputStreams;
}

const processStreams: OutputStreams = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  exitCode: (code) => {
    process.exitCode = code;
  },
  // Pipes can be asynchronous: the document must be out before the exit.
  drain: async () => {
    await Promise.all([process.stdout, process.stderr].map((stream) => new Promise<void>((resolve) => stream.write('', () => resolve()))));
  },
};

interface Finish {
  status: Status;
  exitCode: number;
  stop: Stop | null;
  lines: string[];
  // Fields a finished run adds to the JSON document.
  extra?: Record<string, unknown>;
  // Printed in place of the tail placeholder in text output only.
  tail?: string[] | null;
}

const RUN_ID_STOPS = new Set(['run-not-found', 'run-attacked', 'run-other-version', 'refused-run-output']);

export function createRunOutput(options: RunOutputOptions): RunOutput {
  const { args, info, cwd, env, elapsed } = options;
  const streams = options.streams ?? processStreams;
  const label = args.subcommand ?? (args.word === null ? null : escapeName(args.word));
  const formats = formatsReport();
  const notes: Note[] = [];
  let root: string | null = null;
  let diff: Diff | null = null;
  // The run the document names.
  let current: RunFolder | null = null;
  let made: RunFolder | null = null;
  let named: { run: RunFolder; ownsFiles: boolean } | null = null;
  let compared: ProtectedResult | null = null;
  let contract: ContractStatus | null = null;
  let interrupted = false;

  const document = (finish: Finish) => {
    const tier = args.subcommand === 'quick' || args.subcommand === 'standard' ? args.subcommand : null;
    const { cliPath: _cliPath, versionSkew: skew, ...runner } = info;
    return {
      command: args.subcommand,
      // Null unless this invocation detected the contract or carried its plan's (resolution 103).
      contract: contractJson(contract),
      cwd,
      diff: diff === null ? null : {
        base: {
          ref: diff.base.ref,
          sha: diff.base.sha,
          given: diff.base.given,
          default: diff.base.default ?? null,
          leftOut: diff.base.leftOut ?? [],
        },
        files: diff.files.length,
      },
      exitCode: finish.exitCode,
      formats,
      notes,
      phase: null,
      preRelease: info.version.startsWith('0.'),
      root,
      runDir: current?.dir ?? null,
      runId: current?.id ?? null,
      runner,
      scope: { serverSideRequests: 'not-faulted' },
      status: finish.status,
      stop: finish.stop,
      summaryLines: finish.lines,
      tier,
      versionSkew: skew ? { pin: skew.pin, file: skew.file, ciWillStop: skew.ciWillStop } : null,
      spec: { parts: 0 },
      protected: compared ? protectedJson(compared) : [],
      protectedLines: compared === null ? null : compared.entries.length === 0 ? [] : blockWithHints(compared),
      ...(finish.extra ?? {}),
      sections: withMarkers((finish.extra?.sections as Section[] | undefined) ?? deriveSections(finish, info), finish.lines),
    };
  };

  // The run's files in one order: summary.txt holds stdout as printed except
  // the reset tail, and summary.json is written last (38).
  const writeRunFiles = (run: RunFolder, finish: Finish, more: { report?: string[]; record?: Record<string, unknown> }) => {
    const folder = checkRootEntry(root!);
    const doc = document(finish);
    writeAtomic(folder, ['runs', run.id, 'summary.txt'], text(finish.lines));
    if (more.report) writeAtomic(folder, ['runs', run.id, 'report.txt'], text(more.report));
    if (more.record) writeAtomic(folder, ['runs', run.id, 'record.json'], canonicalJson({ ...doc, ...more.record }));
    writeAtomic(folder, ['runs', run.id, 'summary.json'], canonicalJson(doc));
  };

  // With a plugin data folder, every call ends its stdout with one summary block (37).
  const asPrinted = (finish: Finish): Finish =>
    args.pluginData !== null && finish.lines[0] !== BLOCK_START ? { ...finish, lines: [BLOCK_START, ...finish.lines, BLOCK_END] } : finish;

  const emit = (finish: Finish) => {
    if (interrupted) return;
    finish = asPrinted(finish);
    const printed = finish.tail
      ? finish.lines.flatMap((line) => (line.startsWith(TAIL_PLACEHOLDER) ? capTail(finish.tail!, finish.lines) : [line]))
      : finish.lines;
    const block = text(printed);
    // The block's bytes also go to the run's adversary/summary.txt, except on a
    // run-id stop, which must not touch the run it refused (46.5).
    const runId = current?.id ?? null;
    if (args.pluginData !== null && runId !== null && root !== null && !RUN_ID_STOPS.has(finish.stop?.code ?? '')) {
      try {
        writeAtomic(checkRootEntry(root), ['runs', runId, 'adversary', 'summary.txt'], block);
      } catch {
        // The run folder is gone; stdout still carries the block.
      }
    }
    // The SubagentStop check reads what this session's last call printed (46.4).
    if (args.pluginData !== null) writeSessionFile(args, env, info, current, root, finish, redactSecrets(block));
    if (args.json) {
      streams.stderr(redactSecrets(block));
      streams.stdout(redactSecrets(canonicalJson(document(finish))));
    } else {
      streams.stdout(redactSecrets(block));
    }
    streams.exitCode(finish.exitCode);
  };

  return {
    notes,
    get interrupted() {
      return interrupted;
    },
    located(at) {
      root = at;
    },
    diffed(d) {
      diff = d;
    },
    namedRun(run, ownsFiles) {
      named = { run, ownsFiles };
      current = run;
    },
    madeRun(run) {
      made = run;
    },
    protectedFiles(result) {
      compared = result;
    },
    contract(status) {
      contract = status;
    },
    finish(outcome) {
      if (interrupted) return;
      if (outcome.run) current = outcome.run;
      const finish: Finish = { status: outcome.status, exitCode: outcome.exitCode, stop: null, lines: outcome.lines, ...(outcome.document ? { extra: outcome.document } : {}) };
      if (outcome.run && root !== null) writeRunFiles(outcome.run, finish, outcome.record ? { record: outcome.record } : {});
      emit(finish);
    },
    stop(stop, { run = null, tail = null } = {}) {
      if (interrupted) return;
      current = run;
      // In CI mode the tail placeholder points at the job log (52.4).
      if (ciMode(env, info)) {
        stop = { ...stop, lines: stop.lines.map((l) => (l.startsWith(TAIL_PLACEHOLDER) ? l.replace(/: printed only\)$/, ': in the job log)') : l)) };
      }
      const { exitCode, status } = resolveExit({ stop });
      const header = headerLine(label ?? '', elapsed(), 'stopped', current?.id);
      const finish = asPrinted({ status: status!, exitCode, stop, lines: [header, ...stop.lines, ...runnerBlock(info)], tail });
      // A run folder this invocation made gets the stop's summary files, so it
      // never reads as unfinished (38); any other run, one named by --run
      // included, keeps its own.
      if (run && root !== null && run.id === made?.id && !RUN_ID_STOPS.has(stop.code)) {
        try {
          writeRunFiles(run, finish, { record: { environment: environmentRecord(env, info) } });
        } catch {
          // The run folder is gone; stdout still carries the summary.
        }
      }
      emit(finish);
    },
    async interrupt(signal) {
      if (interrupted) return;
      const { exitCode } = resolveExit({ signal });
      const own = made ?? (named?.ownsFiles ? named.run : null);
      if (own) current = own;
      const header = headerLine(label ?? '', elapsed(), 'interrupted', own?.id);
      const finish: Finish = { status: 'interrupted', exitCode, stop: null, lines: [header, ...runnerBlock(info)] };
      if (own && root !== null) {
        const ordered = orderNotes(notes).map((n) => n.text);
        const report = [header, '', ...(ordered.length > 0 ? ['Notes', ...ordered, ''] : []), ...runnerBlock(info)];
        try {
          writeRunFiles(own, finish, { report, record: { environment: environmentRecord(env, info) } });
        } catch {
          // The run folder is gone; stdout still carries the summary.
        }
      }
      emit(finish);
      interrupted = true;
      await streams.drain();
    },
  };
}

function text(lines: string[]): string {
  return lines.map((line) => line + '\n').join('');
}

// A stop's reset or --start output: lines cut at 240 characters, the oldest
// dropped until the block fits 8,000 bytes (16.7). It reaches no file.
function capTail(tail: string[], lines: string[]): string[] {
  const kept = tail.map((l) => cutLine(l));
  const rest = lines.filter((l) => !l.startsWith(TAIL_PLACEHOLDER));
  const over = (t: string[]) => Buffer.byteLength([...rest, ...t].join('\n') + '\n') > 8000 || rest.length + t.length > 42;
  let dropped = 0;
  while (kept.length > 0 && over(dropped > 0 ? [`+${dropped} more lines of its output not shown`, ...kept] : kept)) {
    kept.shift();
    dropped++;
  }
  return dropped > 0 ? [`+${dropped} more lines of its output not shown`, ...kept] : kept;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,200}$/;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// <plugin data>/adversary-runs/<session id>.json: the run, whether attack ran,
// and the block it printed. Files older than 7 days are pruned.
function writeSessionFile(args: ParsedArgs, env: NodeJS.ProcessEnv, info: RunnerInfo, run: RunFolder | null, root: string | null, finish: Finish, block: string): void {
  const session = env.CLAUDE_CODE_SESSION_ID;
  if (!session || !SESSION_ID.test(session) || args.pluginData === null) return;
  const dir = path.join(args.pluginData, 'adversary-runs');
  try {
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (Date.now() - statSync(file).mtimeMs > WEEK_MS) rmSync(file, { force: true });
    }
    let before: { run?: unknown; attacked?: unknown } = {};
    try {
      before = JSON.parse(readFileSync(path.join(dir, `${session}.json`), 'utf8')) as typeof before;
    } catch {
      before = {};
    }
    // Once a run was attacked it stays attacked, whatever call comes after.
    const attacked = (args.subcommand === 'attack' && !args.check && finish.stop === null) || (before.attacked === true && before.run === (run?.id ?? null));
    const summaryPath = run && root ? path.join(run.dir, 'adversary', 'summary.txt') : null;
    const value = {
      run: run?.id ?? null,
      attacked,
      summary: block,
      summarySha256: createHash('sha256').update(block).digest('hex'),
      cli: info.cliPath,
      pluginData: args.pluginData,
      summaryPath,
    };
    writeFileSync(path.join(dir, `${session}.json`), JSON.stringify(value, null, 2) + '\n');
  } catch {
    // The check is best effort; stdout still carries the block.
  }
}

// Sections for outputs no renderer labelled: the header line, the stop or
// body lines, then the runner block (53.2).
function deriveSections(finish: Finish, info: RunnerInfo): Section[] {
  const lines = finish.lines.filter((l) => l !== BLOCK_START && l !== BLOCK_END);
  const tail = runnerBlock(info);
  const hasTail = lines.length > tail.length && tail.every((l, i) => lines[lines.length - tail.length + i] === l);
  const body = lines.slice(1, hasTail ? lines.length - tail.length : lines.length);
  const bodyId: SectionId = finish.stop ? 'stop' : finish.status === 'nothing-to-attack' ? 'attacks' : 'findings';
  return [
    { id: 'header' as SectionId, lines: lines.slice(0, 1) },
    { id: bodyId, lines: body },
    { id: 'runner' as SectionId, lines: hasTail ? tail : [] },
  ].filter((x) => x.lines.length > 0);
}

// The block markers belong to the first and last sections when stdout carries them.
function withMarkers(sections: Section[], lines: string[]): Section[] {
  if (lines[0] !== BLOCK_START || sections[0]?.lines[0] === BLOCK_START || sections.length === 0) return sections;
  const out = sections.map((x) => ({ ...x, lines: [...x.lines] }));
  out[0]!.lines.unshift(BLOCK_START);
  out[out.length - 1]!.lines.push(BLOCK_END);
  return out;
}
