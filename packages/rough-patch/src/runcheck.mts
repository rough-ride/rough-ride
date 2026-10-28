// The split tier's run files and the checks every call that takes --run makes
// first (spec part 11 sections 42.4 and 42.7).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { PlannedAttack } from './attacks.mjs';
import { stopWith } from './exit.mjs';
import type { FolderState } from './folder.mjs';
import { writeAtomic } from './write.mjs';
import type { Manifest } from './manifest.mjs';
import { followUpCommand, type RunnerInfo } from './runner.mjs';
import type { TierName } from './tiers.mjs';
import type { ContractStatus } from './contract.mjs';

export const RUN_ID = /^\d{8}-\d{6}-[a-z]+-[a-z0-9]{4}$/;

// 42.7's table, in its row order.
export const LIMITS = {
  quick: { planCap: 8, newFlows: 3, repairs: 2, flowSaveCalls: 4, snapshots: 3, links: 2, checks: 2, patchLines: 2000 },
  standard: { planCap: 20, newFlows: 8, repairs: 6, flowSaveCalls: 4, snapshots: 3, links: 2, checks: 2, patchLines: 6000 },
} as const;

// adversary/selection.json: what `plan` selected, read back by `attack`.
export interface PlanState {
  runId: string;
  runner: string;
  tier: TierName;
  digest: string;
  base: { given: string | null };
  planMs: number;
  // Every attack in the ordered list, with its place relative to the cut.
  attacks: { attack: PlannedAttack; nominalMs: number; aboveCut: boolean }[];
  flows: { name: string; class?: string | null; aboveCut: boolean; pages?: unknown[]; requests?: unknown[]; forms?: unknown[] }[];
  limits: Record<string, string | number>;
  // 43.3's outline for the adversary.
  run?: string;
  baseRef?: { ref: string; sha: string };
  selected?: string[];
  failing?: unknown[];
  needsFlow?: unknown[];
  files?: unknown[];
  filesNotListed?: number;
  endpoints?: unknown[];
  env?: string[];
  // Each spec part's name, sha256 and size, never its text.
  specParts?: { name: string; sha256: string; bytes: number }[];
  // plan's Spec and instruction-file notes, repeated in attack's block.
  planNotes?: { id: string; text: string }[];
  // The contract status plan detected, which attack carries (resolution 37).
  contract?: ContractStatus | null;
  routes?: string[] | null;
  apiKeys?: string[];
  flowPages?: { name: string; passed: boolean; pages: { path: string; entry: string }[]; requests: string[] }[];
}

// How many calls of `command` this run already made (42.7's per-run limits).
export function callCount(folder: FolderState, runId: string, command: string): number {
  try {
    return readFileSync(path.join(folder.dir, 'runs', runId, 'adversary', 'calls.jsonl'), 'utf8')
      .split('\n').filter(Boolean).filter((line) => (JSON.parse(line) as { command?: string }).command === command).length;
  } catch {
    return 0;
  }
}

export const SELECTION = ['adversary', 'selection.json'];

// The Bash tool kills a command at 600 s. With a plugin data folder, counted
// from process start: no new flow run after 500 s, runs still going stopped at
// 550 s, the summary written by 570 s (42.7, 50.4).
export const BASH_NO_START_MS = 500_000;
export const BASH_STOP_MS = 550_000;

export function bashBlocksStart(pluginData: boolean, processStart: number, now: number): boolean {
  return pluginData && now - processStart > BASH_NO_START_MS;
}

export function bashDeadline(pluginData: boolean, processStart: number): number {
  return pluginData ? processStart + BASH_STOP_MS : Infinity;
}

export function tierCommand(info: RunnerInfo, tier: TierName): string {
  return followUpCommand(info, [tier]);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// 42.4's stops, in order: no run, already attacked, another runner version,
// altered read-back files. The digest is checked once the diff is known.
export function checkRun(folder: FolderState, runId: string, info: RunnerInfo, manifest: Manifest): PlanState {
  const quickAgain = tierCommand(info, 'quick');
  const dir = path.join(folder.dir, 'runs', runId);
  if (!RUN_ID.test(runId) || !existsSync(dir)) stopWith('run-not-found', `No run ${runId} in this repository. Run ${quickAgain} again.`);
  const plan = readJson(path.join(dir, ...SELECTION)) as PlanState | null;
  const again = tierCommand(info, plan?.tier === 'standard' ? 'standard' : 'quick');
  const record = readJson(path.join(dir, 'record.json')) as { phase?: string } | null;
  // plan never writes attacks.jsonl, so its presence means an attack started,
  // even one that stopped, crashed or was killed before record.json changed.
  if (record?.phase === 'attacked' || existsSync(path.join(dir, 'attacks.jsonl'))) stopWith('run-attacked', `Run ${runId} was already attacked. Run ${again} again.`);
  if (plan && typeof plan.runner === 'string' && plan.runner !== info.version) {
    stopWith('run-other-version', `Run ${runId} was planned by rough-patch ${plan.runner}; this is ${info.version}. Run ${again} again.`);
  }
  manifest.verifyRun(runId, SELECTION.join('/'), plan, SELECTION.join('/'), again);
  const map = readJson(path.join(dir, 'diff-map.json'));
  manifest.verifyRun(runId, 'diff-map.json', map, 'diff-map.json', again);
  return plan!;
}

export function checkDigest(plan: PlanState, digest: string): void {
  if (plan.digest !== digest) stopWith('code-changed', 'The code changed since the plan was made. Plan again.');
}

// adversary/calls.jsonl: one line per adversary call between plan and attack,
// `{command, ms}`, timed and never budgeted (42.7).
export function adversaryCallTime(folder: FolderState, runId: string): number {
  try {
    return readFileSync(path.join(folder.dir, 'runs', runId, 'adversary', 'calls.jsonl'), 'utf8')
      .split('\n').filter(Boolean).reduce((n, line) => n + (Number((JSON.parse(line) as { ms?: unknown }).ms) || 0), 0);
  } catch {
    return 0;
  }
}

export function recordCall(folder: FolderState, runId: string, command: string, ms: number): void {
  const file = path.join(folder.dir, 'runs', runId, 'adversary', 'calls.jsonl');
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  writeAtomic(folder, ['runs', runId, 'adversary', 'calls.jsonl'], text + JSON.stringify({ command, ms: Math.round(ms) }) + '\n');
}
