// The invocation clock: what a tier invocation's measured time counts as
// (spec part 12 sections 47.1, 47.3 and 50.1 to 50.6, resolution 133).
// Nominal time and the cut stay in budget.mts; this module owns measured time.
//   app start: --start's wait for the app, plus the sign-in runs retried while
//     the API refused; never the runner's own reset or browser launch;
//   reset: config.yaml's reset command;
//   plan: budgeted time up to the end of selection, P, which plan records and
//     attack takes off its limit;
//   attack setup: an attack invocation's time before attack time starts;
//   budgeted: from the end of reset and the API's first answer, or in attack
//     from the end of setup, to now;
//   hard stop: the limit plus G plus 10 s, or the Bash stop when it is sooner.

import { formatDuration } from './output.mjs';
import { TIER_TABLE, type TierName } from './tiers.mjs';

// One invocation (`quick`, `standard`), or one half of the planning split.
export type ClockMode = 'tier' | 'plan' | 'attack';

export interface ClockOptions {
  mode: ClockMode;
  tier: TierName;
  // attack: plan's budgeted time P, read back from its run.
  planMs?: number;
  // --start's wait for the app (Target.startMs).
  appStartMs: number;
  // The Bash stop with a plugin data folder, else Infinity (50.4).
  bashStop: number;
  now?: () => number;
}

export interface BudgetFields {
  budgetMs: number;
  budgetedMs: number;
  overMs: number;
  planMs: number | null;
  attackSetupMs: number;
  resetMs: number;
  startMs: number;
}

export interface InvocationClock {
  // The marks, in the order an invocation reaches them.
  resetFinished(resetMs: number): void;
  backendAnswered(waitedMs: number): void;
  selectionEnded(): void;
  budgetedMs(): number;
  // B, or A = B - P in the attack invocation (47.3).
  limitMs(): number;
  // 50.2: a test or attack needing `needMs` more starts only within the limit less the reserve.
  startFits(needMs: number, reserveMs: number): boolean;
  // 50.3: a closing run starts only within the limit plus G.
  closingFits(estMs: number): boolean;
  hardStopAt(): number;
  // P in the planning split, null in one invocation.
  planMs(): number | null;
  budgetNote(facts: { clockCut: number; unconfirmed: number; flows: number }): string | null;
  timeLine(facts: { runnerMs: number; adversaryCallsMs: number }): string;
  resetLine(): string | null;
  fields(): BudgetFields;
}

export function createClock(options: ClockOptions): InvocationClock {
  const now = options.now ?? Date.now;
  const { mode, tier } = options;
  const { budgetMs, serialGraceMs } = TIER_TABLE.tiers[tier];
  const created = now();
  let budgetStart = created;
  let resetMs = 0;
  let appStartMs = options.appStartMs;
  let selectionEndedAt = created;
  let planMs = mode === 'attack' ? options.planMs ?? 0 : 0;
  let setupMs = 0;

  const budgeted = () => now() - budgetStart;
  const limit = () => budgetMs - planMs;

  return {
    resetFinished(ms) {
      resetMs = ms;
      budgetStart = now();
    },
    // Waiting for the API is app start; the budget starts with the run that got an answer.
    backendAnswered(waitedMs) {
      appStartMs += waitedMs;
      budgetStart += waitedMs;
    },
    selectionEnded() {
      selectionEndedAt = now();
      if (mode === 'plan') planMs = selectionEndedAt - budgetStart;
      if (mode === 'attack') {
        // Steps 1 to 4 are setup, timed and never budgeted; attack time starts now (42.6).
        setupMs = now() - created;
        budgetStart = now();
      }
    },
    budgetedMs: budgeted,
    limitMs: limit,
    startFits: (needMs, reserveMs) => budgeted() + needMs <= limit() - reserveMs,
    closingFits: (estMs) => budgeted() + estMs <= limit() + serialGraceMs,
    hardStopAt: () => Math.min(budgetStart + limit() + serialGraceMs + 10_000, options.bashStop),
    planMs: () => (mode === 'tier' ? null : planMs),
    // 50.6: the first that applies.
    budgetNote({ clockCut, unconfirmed, flows }) {
      const spent = budgeted();
      if (clockCut > 0 || unconfirmed > 0) {
        return `Ran slower than planned: ${clockCut} ${clockCut === 1 ? 'attack' : 'attacks'} and ${unconfirmed} confirmation ${unconfirmed === 1 ? 'run' : 'runs'} did not start before the ${tier} budget ran out.`;
      }
      if (spent > budgetMs) return `Over the ${tier} budget by ${formatDuration(spent - budgetMs)}: flow runs still going at ${formatDuration(budgetMs)} were allowed to finish.`;
      // attack's baseline runs are setup: its budget started after them.
      const planning = mode === 'attack' ? 0 : selectionEndedAt - budgetStart;
      if (planning > budgetMs / 2) return `Baseline runs of ${flows} saved flows used ${formatDuration(planning)} of the ${formatDuration(budgetMs)} ${tier} budget.`;
      return null;
    },
    timeLine({ runnerMs, adversaryCallsMs }) {
      const start = `app start ${formatDuration(appStartMs)}`;
      return mode === 'attack'
        ? `time: runner ${formatDuration(runnerMs)} = attack setup ${formatDuration(setupMs)} (timed, not budgeted) + budgeted ${formatDuration(budgeted())} of ${formatDuration(limit())} (the ${tier} budget less plan ${formatDuration(planMs)}); adversary calls ${formatDuration(adversaryCallsMs)} (timed, not budgeted) | ${start}`
        : `time: runner ${formatDuration(runnerMs)} = budgeted ${formatDuration(budgeted())} of ${formatDuration(budgetMs)} + reset ${formatDuration(resetMs)} | ${start}`;
    },
    resetLine: () => (resetMs > 10_000 ? `reset took ${Math.round(resetMs / 1000)}s; it is not counted in the ${tier} budget.` : null),
    fields() {
      const spent = budgeted();
      return {
        budgetMs,
        budgetedMs: spent,
        overMs: Math.max(0, spent - budgetMs),
        planMs: mode === 'tier' ? null : planMs,
        attackSetupMs: setupMs,
        resetMs,
        startMs: appStartMs,
      };
    },
  };
}
