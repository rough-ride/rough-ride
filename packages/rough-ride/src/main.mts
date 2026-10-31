// Dispatches a parsed command line and prints its one outcome: text on stdout,
// or with --json one JSON document on stdout and the text on stderr.

import { canon } from '../hooks/path-check.mjs';
import { HELP, parseArgs, type Subcommand } from './args.mjs';
import { makeStop, StopError } from './exit.mjs';
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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkRootEntry as entry } from './folder.mjs';
import { onInterrupt } from './interrupt.mjs';
import { canonicalJson, formatDuration, startClock } from './output.mjs';
import { claudeFloorStop, followUpCommand, ownVersion, pluginDataMismatch, runnerInfo, runnerBlock, versionLine, type RunnerInfo } from './runner.mjs';
import { createRunOutput } from './runoutput.mjs';

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

const TIERS: ReadonlySet<Subcommand> = new Set(['quick', 'standard', 'plan']);
const PRE_RELEASE = '0.x pre-release: detection and false-alarm rates not measured yet';

export async function main(argv: string[]): Promise<void> {
  const elapsed = startClock();
  const args = parseArgs(argv);
  const cwd = canon(process.cwd());
  const info = runnerInfo(args.pluginData, cwd, process.env);
  const output = createRunOutput({ args, info, cwd, env: process.env, elapsed });
  let root: string | null = null;
  let diff: Diff | null = null;

  onInterrupt((signal) => output.interrupt(signal));

  if (args.help) return output.finish({ status: 'passed', exitCode: 0, lines: HELP });
  if (args.version) return output.finish({ status: 'passed', exitCode: 0, lines: [versionLine(info)] });
  if (args.error !== null) return output.stop(makeStop('usage', [args.error]));
  if (info.playwright === null) return output.stop(makeStop('packages-missing', [packagesMissing(info)]));
  // With a plugin data folder the runner repeats the preflight's checks, which
  // disableSkillShellExecution can skip (spec part 1 section 4).
  const floor = claudeFloorStop(info, args.subcommand === 'standard' ? 'standard' : 'quick');
  if (floor !== null) return output.stop(makeStop('claude-code-too-old', [floor]));
  const mismatch = pluginDataMismatch(info);
  if (mismatch !== null) return output.stop(makeStop('plugin-data-mismatch', [mismatch]));

  if (args.subcommand === 'pr-comment') {
    // Only the two files and the GitHub variables: no git, no folder, no writes (53.1).
    const own = info.version;
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

  const progress = (line: string) => {
    if (process.stderr.isTTY && !args.json && args.pluginData === null) process.stderr.write(line + '\n');
  };
  const runIn = (root: string, id: string) => ({ id, dir: path.join(entry(root).dir, 'runs', id) });

  try {
    if (args.subcommand !== null && NEEDS_ROOT.has(args.subcommand)) {
      const found = findGitRoot(cwd);
      if ('stop' in found) return output.stop(found.stop);
      root = found.root;
      output.located(root);
      output.notes.push(...locationNotes(found.root, cwd));
      checkRootEntry(found.root);
    }
    // attack: the run-id stops before anything else, then the plan's own base and the digest (42.4).
    let planState: PlanState | undefined;
    let planText: string | null = null;
    if (args.subcommand === 'attack' && root !== null) {
      planText = args.planInput ? readStdin() : null;
      if (args.check) {
        // --check validates against plan's data and runs no flow (45.3).
        output.namedRun(runIn(root, args.runId!), false);
        const result = runPlanCheck({ folder: ensureFolder(entry(root)), root, info, runId: args.runId!, stdin: planText ?? '', elapsed });
        return output.finish({ status: result.status === 'stopped' ? 'incomplete' : result.status, exitCode: result.exitCode, lines: result.lines, document: result.document });
      }
      planState = checkRun(ensureFolder(entry(root)), args.runId!, info, new Manifest(root));
      output.namedRun(runIn(root, planState.runId), true);
      diff = computeDiff({ root, given: planState.base.given, env: process.env, nuxtRoots: nuxtCandidates(root).map((c) => c.rel) });
      output.diffed(diff);
      checkDigest(planState, diff.digest);
    }
    if (args.subcommand !== null && TIERS.has(args.subcommand) && root !== null) {
      diff = computeDiff({ root, given: args.base, env: process.env, nuxtRoots: nuxtCandidates(root).map((c) => c.rel) });
      output.diffed(diff);
      if (isEmpty(diff)) {
        const header = [`rough-ride ${args.subcommand === 'plan' ? `plan ${args.rest[0]}` : args.subcommand}`, formatDuration(elapsed())];
        if (info.version.startsWith('0.')) header.push(PRE_RELEASE);
        const regress = followUpCommand(info, ['regress']);
        return output.finish({
          status: 'nothing-to-attack',
          exitCode: 0,
          lines: [header.join(' | '), nothingToAttackLine(diff, regress), ...runnerBlock(info)],
        });
      }
      for (const note of [largeDiffNote(diff), automationNote(root, diff)]) if (note) output.notes.push(note);
    }
    const common = { info, argv, env: process.env, notes: output.notes, report: output, elapsed };
    const tierWord = args.subcommand === 'plan' ? args.rest[0] : args.subcommand === 'attack' ? planState?.tier : args.subcommand;
    if ((tierWord === 'quick' || tierWord === 'standard') && root !== null && diff !== null) {
      const tier = await runTier({
        ...common,
        subcommand: tierWord,
        ...(args.subcommand === 'plan' ? { mode: 'plan' as const } : args.subcommand === 'attack' ? { mode: 'attack' as const, plan: planState, planText } : {}),
        root,
        folder: entry(root),
        diff,
        browserFlag: args.browser,
        start: args.start,
        progress,
      });
      return output.finish({ status: tier.status, exitCode: tier.exitCode, lines: tier.lines, document: tier.document, run: tier.run, record: tier.record });
    }
    if (args.subcommand === 'regress' && root !== null) {
      const result = await runRegress({ ...common, root, folder: entry(root), only: args.only, browserFlag: args.browser, start: args.start, progress });
      return output.finish({ status: result.status, exitCode: result.exitCode, lines: result.lines, document: result.document, run: result.run, ...(result.record ? { record: result.record } : {}) });
    }
    if (args.subcommand === 'repro' && root !== null) {
      const result = await runRepro({
        ...common,
        root,
        folder: entry(root),
        id: args.rest[0] ?? null,
        keepOpen: args.keepOpen,
        browserFlag: args.browser,
        start: args.start,
        progress: () => {},
      });
      return output.finish({ status: result.status, exitCode: result.exitCode, lines: result.lines, document: result.document, run: result.run });
    }
    if ((args.subcommand === 'snapshot' || args.subcommand === 'link') && root !== null) {
      const stdin = readStdin();
      // The block also lands in that run's adversary/summary.txt (46.5).
      output.namedRun(runIn(root, args.runId!), false);
      const call = { ...common, root, folder: entry(root), runId: args.runId!, stdin };
      const result = args.subcommand === 'snapshot' ? await runSnapshot({ ...call, browserFlag: args.browser }) : runLink(call);
      return output.finish({ status: result.status, exitCode: result.exitCode, lines: result.lines, document: result.document });
    }
    if (args.subcommand === 'flow save' && root !== null) {
      const stdin = readStdin();
      // Under --run the block also lands in that run's adversary/summary.txt (46.5).
      if (args.runId !== null) output.namedRun(runIn(root, args.runId), false);
      const result = await runFlowSave({
        ...common,
        root,
        folder: entry(root),
        names: args.rest,
        runId: args.runId,
        stdin,
        browserFlag: args.browser,
        start: args.start,
        progress,
      });
      return output.finish({ status: result.status, exitCode: result.exitCode, lines: result.lines, document: result.document, run: result.run });
    }
    if (args.subcommand !== null && NOT_BUILT.has(args.subcommand)) {
      return output.stop(makeStop('usage', [`rough-ride ${ownVersion()} can't run ${args.subcommand} yet.`]));
    }
  } catch (error) {
    if (error instanceof StopError) return output.stop(error.stop, { run: error.run, tail: error.tail });
    throw error;
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
    return "rough-ride's plugin copy is missing playwright-core: Claude Code's install of its packages did not finish." +
      ` Run in your shell: claude plugin update ${info.pluginId}`;
  }
  return 'rough-ride is missing its package playwright-core. Reinstall rough-ride and run again.';
}
