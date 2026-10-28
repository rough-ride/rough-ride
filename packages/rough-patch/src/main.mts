// Dispatches a parsed command line and prints its one outcome: text on stdout,
// or with --json one JSON document on stdout and the text on stderr.

import { BLOCK_END, BLOCK_START, cutLine, type Section, type SectionId } from './summary.mjs';
import { canon } from '../hooks/path-check.mjs';
import { HELP, parseArgs, type ParsedArgs, type Subcommand } from './args.mjs';
import { makeStop, resolveExit, StopError, TAIL_PLACEHOLDER, type Status, type Stop } from './exit.mjs';
import { checkRootEntry, locationNotes } from './folder.mjs';
import { findGitRoot } from './git.mjs';
import { automationNote, computeDiff, isEmpty, largeDiffNote, nothingToAttackLine, type Diff } from './diff.mjs';
import { nuxtCandidates } from './target.mjs';
import { runTier } from './tier.mjs';
import { runRegress } from './regress.mjs';
import { runRepro } from './repro.mjs';
import { runFlowSave } from './flowsave.mjs';
import { runSnapshot } from './snapshot.mjs';
import { runLink } from './link.mjs';
import { runPlanCheck } from './plancheck.mjs';
import { checkDigest, checkRun, type PlanState } from './runcheck.mjs';
import { Manifest } from './manifest.mjs';
import { ensureFolder } from './folder.mjs';
import { loadDoc, renderComment } from './prcomment.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { blockWithHints, lastProtected, protectedJson } from './protected.mjs';
import { writeAtomic } from './write.mjs';
import { checkRootEntry as entry } from './folder.mjs';
import { onInterrupt } from './interrupt.mjs';
import { formatsReport, type FormatsReport } from './formats.mjs';
import { canonicalJson, escapeName, formatDuration, headerLine, startClock, type Note } from './output.mjs';
import { redactSecrets } from './secrets.mjs';
import { contractJson, lastContract } from './contract.mjs';
import { ciMode, claudeFloorStop, environmentRecord, followUpCommand, ownVersion, pluginDataMismatch, runnerInfo, runnerBlock, versionLine, type RunnerInfo } from './runner.mjs';
import { lastRunFolder } from './runs.mjs';
import { orderNotes } from './summary.mjs';

// Each later ticket moves its subcommand off this list.
const NOT_BUILT: ReadonlySet<Subcommand> = new Set([]);

// pr-comment reads a run's summary.json and never needs the repository.
const NEEDS_ROOT: ReadonlySet<Subcommand> = new Set([
  'quick',
  'standard',
  'plan',
  'snapshot',
  'link',
  'flow save',
  'attack',
  'regress',
  'repro',
]);

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

interface Invocation {
  args: ParsedArgs;
  info: RunnerInfo;
  cwd: string;
  root: string | null;
  run: { id: string; dir: string } | null;
  notes: Note[];
  formats: FormatsReport;
  diff: Diff | null;
}

const TIERS: ReadonlySet<Subcommand> = new Set(['quick', 'standard', 'plan']);
const PRE_RELEASE = '0.x pre-release: detection and false-alarm rates not measured yet';

export async function main(argv: string[]): Promise<void> {
  const elapsed = startClock();
  const args = parseArgs(argv);
  const cwd = canon(process.cwd());
  const run: Invocation = {
    args,
    info: runnerInfo(args.pluginData, cwd, process.env),
    cwd,
    root: null,
    run: null,
    notes: [],
    formats: formatsReport(),
    diff: null,
  };
  const label = args.subcommand ?? (args.word === null ? null : escapeName(args.word));

  // Set by the first signal: from then on nothing else is written or printed.
  let interrupted = false;
  const emit = (finish: Finish) => {
    if (interrupted) return;
    // With a plugin data folder, every call ends its stdout with one summary block (37).
    if (args.pluginData !== null && finish.lines[0] !== BLOCK_START) finish = { ...finish, lines: [BLOCK_START, ...finish.lines, BLOCK_END] };
    const printed = finish.tail
      ? finish.lines.flatMap((line) => (line.startsWith(TAIL_PLACEHOLDER) ? capTail(finish.tail!, finish.lines) : [line]))
      : finish.lines;
    const text = printed.map((line) => line + '\n').join('');
    // The block's bytes also go to the run's adversary/summary.txt, except on a
    // run-id stop, which must not touch the run it refused (46.5).
    const runId = run.run?.id ?? null;
    if (args.pluginData !== null && runId !== null && run.root !== null && !RUN_ID_STOPS.has(finish.stop?.code ?? '')) {
      try {
        writeAtomic(entry(run.root), ['runs', runId, 'adversary', 'summary.txt'], text);
      } catch {
        // The run folder is gone; stdout still carries the block.
      }
    }
    // The SubagentStop check reads what this session's last call printed (46.4).
    if (args.pluginData !== null) writeSessionFile(args, run, finish, redactSecrets(text));
    if (args.json) {
      process.stderr.write(redactSecrets(text));
      process.stdout.write(redactSecrets(canonicalJson(document(run, finish))));
    } else {
      process.stdout.write(redactSecrets(text));
    }
    process.exitCode = finish.exitCode;
  };

  const stopped = (stop: Stop, tail: string[] | null = null) => {
    // In CI mode the tail placeholder points at the job log (52.4).
    if (ciMode(process.env, run.info)) {
      stop = { ...stop, lines: stop.lines.map((l) => (l.startsWith(TAIL_PLACEHOLDER) ? l.replace(/: printed only\)$/, ': in the job log)') : l)) };
    }
    const { exitCode, status } = resolveExit({ stop });
    const header = headerLine(label ?? '', elapsed(), 'stopped', run.run?.id);
    emit({ status: status!, exitCode, stop, lines: [header, ...stop.lines, ...runnerBlock(run.info)], tail });
  };

  // Write first (51.13): the run's files and the stdout document, before the
  // exit that ends the browser and the --start children.
  onInterrupt(async (signal) => {
    const { exitCode } = resolveExit({ signal });
    const own = lastRunFolder() ?? (args.subcommand === 'attack' && !args.check ? run.run : null);
    if (own) run.run = own;
    const header = headerLine(label ?? '', elapsed(), 'interrupted', own?.id);
    const finish: Finish = { status: 'interrupted', exitCode, stop: null, lines: [header, ...runnerBlock(run.info)] };
    if (own && run.root !== null) {
      const folder = entry(run.root);
      const doc = document(run, finish);
      const notes = orderNotes(run.notes).map((n) => n.text);
      const report = [header, '', ...(notes.length > 0 ? ['Notes', ...notes, ''] : []), ...runnerBlock(run.info)];
      try {
        writeAtomic(folder, ['runs', own.id, 'summary.txt'], finish.lines.map((l) => l + '\n').join(''));
        writeAtomic(folder, ['runs', own.id, 'report.txt'], report.map((l) => l + '\n').join(''));
        writeAtomic(folder, ['runs', own.id, 'record.json'], canonicalJson({ ...doc, environment: environmentRecord(process.env, run.info) }));
        writeAtomic(folder, ['runs', own.id, 'summary.json'], canonicalJson(doc));
      } catch {
        // The run folder is gone; stdout still carries the summary.
      }
    }
    emit(finish);
    interrupted = true;
    // Pipes can be asynchronous: the document must be out before the exit.
    await Promise.all([process.stdout, process.stderr].map((stream) => new Promise<void>((resolve) => stream.write('', () => resolve()))));
  });

  if (args.help) return emit({ status: 'passed', exitCode: 0, stop: null, lines: HELP });
  if (args.version) return emit({ status: 'passed', exitCode: 0, stop: null, lines: [versionLine(run.info)] });
  if (args.error !== null) return stopped(makeStop('usage', [args.error]));
  if (run.info.playwright === null) return stopped(makeStop('packages-missing', [packagesMissing(run.info)]));
  // With a plugin data folder the runner repeats the preflight's checks, which
  // disableSkillShellExecution can skip (spec part 1 section 4).
  const floor = claudeFloorStop(run.info, args.subcommand === 'standard' ? 'standard' : 'quick');
  if (floor !== null) return stopped(makeStop('claude-code-too-old', [floor]));
  const mismatch = pluginDataMismatch(run.info);
  if (mismatch !== null) return stopped(makeStop('plugin-data-mismatch', [mismatch]));

  if (args.subcommand === 'pr-comment') {
    // Only the two files and the GitHub variables: no git, no folder, no writes (53.1).
    const own = run.info.version;
    const body = renderComment({
      tier: args.rest[0] as 'quick' | 'standard',
      tierDoc: loadDoc(args.rest[1]!, own),
      regressDoc: loadDoc(args.rest[2]!, own),
      own,
      env: process.env,
      artifactUrl: args.artifactUrl || null,
    });
    if (args.json) process.stdout.write(canonicalJson({ command: 'pr-comment', status: 'passed', exitCode: 0, body }));
    else process.stdout.write(body);
    process.exitCode = 0;
    return;
  }

  try {
    if (args.subcommand !== null && NEEDS_ROOT.has(args.subcommand)) {
      const found = findGitRoot(cwd);
      if ('stop' in found) return stopped(found.stop);
      run.root = found.root;
      run.notes.push(...locationNotes(found.root, cwd));
      checkRootEntry(found.root);
    }
    // attack: the run-id stops before anything else, then the plan's own base and the digest (42.4).
    let planState: PlanState | undefined;
    let planText: string | null = null;
    if (args.subcommand === 'attack' && run.root !== null) {
      planText = args.planInput ? readStdin() : null;
      const root = run.root;
      if (args.check) {
        // --check validates against plan's data and runs no flow (45.3).
        run.run = { id: args.runId!, dir: path.join(entry(root).dir, 'runs', args.runId!) };
        const result = runPlanCheck({ folder: ensureFolder(entry(root)), root, info: run.info, runId: args.runId!, stdin: planText ?? '', elapsed });
        return emit({ status: result.status === 'stopped' ? 'incomplete' : result.status, exitCode: result.exitCode, stop: null, lines: result.lines, extra: result.document });
      }
      planState = checkRun(ensureFolder(entry(root)), args.runId!, run.info, new Manifest(root));
      run.run = { id: planState.runId, dir: path.join(entry(root).dir, 'runs', planState.runId) };
      run.diff = computeDiff({ root, given: planState.base.given, env: process.env, nuxtRoots: nuxtCandidates(root).map((c) => c.rel) });
      checkDigest(planState, run.diff.digest);
    }
    if (args.subcommand !== null && TIERS.has(args.subcommand) && run.root !== null) {
      const root = run.root;
      run.diff = computeDiff({ root, given: args.base, env: process.env, nuxtRoots: nuxtCandidates(root).map((c) => c.rel) });
      if (isEmpty(run.diff)) {
        const header = [`rough-patch ${args.subcommand === 'plan' ? `plan ${args.rest[0]}` : args.subcommand}`, formatDuration(elapsed())];
        if (run.info.version.startsWith('0.')) header.push(PRE_RELEASE);
        const regress = followUpCommand(run.info, ['regress']);
        return emit({
          status: 'nothing-to-attack',
          exitCode: 0,
          stop: null,
          lines: [header.join(' | '), nothingToAttackLine(run.diff, regress), ...runnerBlock(run.info)],
        });
      }
      for (const note of [largeDiffNote(run.diff), automationNote(root, run.diff)]) if (note) run.notes.push(note);
    }
    const tierWord = args.subcommand === 'plan' ? args.rest[0] : args.subcommand === 'attack' ? planState?.tier : args.subcommand;
    if ((tierWord === 'quick' || tierWord === 'standard') && run.root !== null && run.diff !== null) {
      const progress = (line: string) => {
        if (process.stderr.isTTY && !args.json && args.pluginData === null) process.stderr.write(line + '\n');
      };
      const tier = await runTier({
        subcommand: tierWord,
        ...(args.subcommand === 'plan' ? { mode: 'plan' as const } : args.subcommand === 'attack' ? { mode: 'attack' as const, plan: planState, planText } : {}),
        root: run.root,
        folder: entry(run.root),
        diff: run.diff,
        info: run.info,
        browserFlag: args.browser,
        start: args.start,
        argv,
        env: process.env,
        notes: run.notes,
        elapsed,
        progress,
      });
      if (interrupted) return;
      run.run = { id: tier.run.id, dir: tier.run.dir };
      const finish: Finish = { status: tier.status, exitCode: tier.exitCode, stop: null, lines: tier.lines, extra: tier.document };
      const folder = entry(run.root);
      // summary.txt holds stdout as printed; summary.json is written last.
      writeAtomic(folder, ['runs', tier.run.id, 'summary.txt'], tier.lines.map((l) => l + '\n').join(''));
      writeAtomic(folder, ['runs', tier.run.id, 'record.json'], canonicalJson({ ...document(run, finish), ...tier.record }));
      writeAtomic(folder, ['runs', tier.run.id, 'summary.json'], canonicalJson(document(run, finish)));
      return emit(finish);
    }
    if (args.subcommand === 'regress' && run.root !== null) {
      const progress = (line: string) => {
        if (process.stderr.isTTY && !args.json && args.pluginData === null) process.stderr.write(line + '\n');
      };
      const result = await runRegress({
        root: run.root,
        folder: entry(run.root),
        info: run.info,
        only: args.only,
        browserFlag: args.browser,
        start: args.start,
        argv,
        env: process.env,
        notes: run.notes,
        elapsed,
        progress,
      });
      if (interrupted) return;
      if (result.run) run.run = { id: result.run.id, dir: result.run.dir };
      const finish: Finish = { status: result.status, exitCode: result.exitCode, stop: null, lines: result.lines, extra: result.document };
      if (result.run) {
        const folder = entry(run.root);
        writeAtomic(folder, ['runs', result.run.id, 'summary.txt'], result.lines.map((l) => l + '\n').join(''));
        writeAtomic(folder, ['runs', result.run.id, 'summary.json'], canonicalJson(document(run, finish)));
      }
      return emit(finish);
    }
    if (args.subcommand === 'repro' && run.root !== null) {
      const result = await runRepro({
        root: run.root,
        folder: entry(run.root),
        info: run.info,
        id: args.rest[0] ?? null,
        keepOpen: args.keepOpen,
        browserFlag: args.browser,
        start: args.start,
        argv,
        env: process.env,
        notes: run.notes,
        elapsed,
        progress: () => {},
      });
      if (interrupted) return;
      if (result.run) run.run = { id: result.run.id, dir: result.run.dir };
      const finish: Finish = { status: result.status, exitCode: result.exitCode, stop: null, lines: result.lines, extra: result.document };
      if (result.run) {
        const folder = entry(run.root);
        writeAtomic(folder, ['runs', result.run.id, 'summary.txt'], result.lines.map((l) => l + '\n').join(''));
        writeAtomic(folder, ['runs', result.run.id, 'summary.json'], canonicalJson(document(run, finish)));
      }
      return emit(finish);
    }
    if ((args.subcommand === 'snapshot' || args.subcommand === 'link') && run.root !== null) {
      const stdin = readStdin();
      // The block also lands in that run's adversary/summary.txt (46.5).
      run.run = { id: args.runId!, dir: path.join(entry(run.root).dir, 'runs', args.runId!) };
      const common = { root: run.root, folder: entry(run.root), info: run.info, runId: args.runId!, stdin, argv, env: process.env, notes: run.notes, elapsed };
      const result = args.subcommand === 'snapshot' ? await runSnapshot({ ...common, browserFlag: args.browser }) : runLink(common);
      return emit({ status: result.status, exitCode: result.exitCode, stop: null, lines: result.lines, extra: result.document });
    }
    if (args.subcommand === 'flow save' && run.root !== null) {
      let stdin = '';
      try {
        stdin = process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
      } catch {
        stdin = '';
      }
      // Under --run the block also lands in that run's adversary/summary.txt (46.5).
      if (args.runId !== null) run.run = { id: args.runId, dir: path.join(entry(run.root).dir, 'runs', args.runId) };
      const result = await runFlowSave({
        root: run.root,
        folder: entry(run.root),
        info: run.info,
        names: args.rest,
        runId: args.runId,
        stdin,
        browserFlag: args.browser,
        start: args.start,
        argv,
        env: process.env,
        notes: run.notes,
        elapsed,
        progress: (line) => {
          if (process.stderr.isTTY && !args.json && args.pluginData === null) process.stderr.write(line + '\n');
        },
      });
      if (interrupted) return;
      if (result.run) run.run = { id: result.run.id, dir: result.run.dir };
      const finish: Finish = { status: result.status, exitCode: result.exitCode, stop: null, lines: result.lines, extra: result.document };
      if (result.run) {
        const folder = entry(run.root);
        writeAtomic(folder, ['runs', result.run.id, 'summary.txt'], result.lines.map((l) => l + '\n').join(''));
        writeAtomic(folder, ['runs', result.run.id, 'summary.json'], canonicalJson(document(run, finish)));
      }
      return emit(finish);
    }
    if (args.subcommand !== null && NOT_BUILT.has(args.subcommand)) {
      return stopped(makeStop('usage', [`rough-patch ${ownVersion()} can't run ${args.subcommand} yet.`]));
    }
  } catch (error) {
    if (error instanceof StopError) {
      run.run = error.run;
      return stopped(error.stop, error.tail);
    }
    throw error;
  }
}

const RUN_ID_STOPS = new Set(['run-not-found', 'run-attacked', 'run-other-version', 'refused-run-output']);

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
function writeSessionFile(args: ParsedArgs, run: Invocation, finish: Finish, block: string): void {
  const session = process.env.CLAUDE_CODE_SESSION_ID;
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
    const attacked = (args.subcommand === 'attack' && !args.check && finish.stop === null) || (before.attacked === true && before.run === (run.run?.id ?? null));
    const summaryPath = run.run && run.root ? path.join(run.run.dir, 'adversary', 'summary.txt') : null;
    const value = {
      run: run.run?.id ?? null,
      attacked,
      summary: block,
      summarySha256: createHash('sha256').update(block).digest('hex'),
      cli: run.info.cliPath,
      pluginData: args.pluginData,
      summaryPath,
    };
    writeFileSync(path.join(dir, `${session}.json`), JSON.stringify(value, null, 2) + '\n');
  } catch {
    // The check is best effort; stdout still carries the block.
  }
}

function readStdin(): string {
  try {
    return process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function packagesMissing(info: RunnerInfo): string {
  if (info.source.kind === 'plugin') {
    return "rough-patch's plugin copy is missing playwright-core: Claude Code's install of its packages did not finish." +
      ` Run in your shell: claude plugin update ${info.pluginId}`;
  }
  return 'rough-patch is missing its package playwright-core. Reinstall rough-patch and run again.';
}

function document(run: Invocation, finish: Finish) {
  const { args, info } = run;
  const tier = args.subcommand === 'quick' || args.subcommand === 'standard' ? args.subcommand : null;
  const { cliPath: _cliPath, versionSkew: skew, ...runner } = info;
  const prot = lastProtected();
  return {
    command: args.subcommand,
    // Null unless this invocation detected the contract or carried its plan's (resolution 103).
    contract: contractJson(lastContract()),
    cwd: run.cwd,
    diff: run.diff === null ? null : {
      base: {
        ref: run.diff.base.ref,
        sha: run.diff.base.sha,
        given: run.diff.base.given,
        default: run.diff.base.default ?? null,
        leftOut: run.diff.base.leftOut ?? [],
      },
      files: run.diff.files.length,
    },
    exitCode: finish.exitCode,
    formats: run.formats,
    notes: run.notes,
    phase: null,
    preRelease: info.version.startsWith('0.'),
    root: run.root,
    runDir: run.run?.dir ?? null,
    runId: run.run?.id ?? null,
    runner,
    scope: { serverSideRequests: 'not-faulted' },
    status: finish.status,
    stop: finish.stop,
    summaryLines: finish.lines,
    tier,
    versionSkew: skew ? { pin: skew.pin, file: skew.file, ciWillStop: skew.ciWillStop } : null,
    spec: { parts: 0 },
    protected: prot ? protectedJson(prot) : [],
    protectedLines: prot === null ? null : prot.entries.length === 0 ? [] : blockWithHints(prot),
    ...(finish.extra ?? {}),
    sections: withMarkers((finish.extra?.sections as Section[] | undefined) ?? deriveSections(finish, info), finish.lines),
  };
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
