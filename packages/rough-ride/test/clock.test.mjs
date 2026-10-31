import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClock } from '../dist/clock.mjs';

// A fake clock: `at` is the time now() returns, moved on by `pass(ms)`.
function fake(options) {
  let at = 1_000_000;
  const clock = createClock({ mode: 'tier', tier: 'quick', appStartMs: 0, bashStop: Infinity, ...options, now: () => at });
  return { clock, pass: (ms) => { at += ms; }, at: () => at };
}

test('app start is the --start wait plus the retried sign-in runs; reset and the browser launch before it are neither', () => {
  const { clock, pass } = fake({ appStartMs: 5_000 });
  pass(800); // the browser launch and guard, after the Target session opened
  pass(12_000);
  clock.resetFinished(12_000);
  pass(20_000); // sign-in runs refused while the API was not listening
  pass(1_000); // the sign-in run that got an answer
  clock.backendAnswered(20_000);
  pass(2_000);
  assert.equal(clock.budgetedMs(), 3_000);
  assert.deepEqual(clock.fields(), { budgetMs: 120_000, budgetedMs: 3_000, overMs: 0, planMs: null, attackSetupMs: 0, resetMs: 12_000, startMs: 25_000 });
  assert.equal(clock.timeLine({ runnerMs: 36_800, adversaryCallsMs: 0 }), 'time: runner 36s = budgeted 3.0s of 2m00s + reset 12s | app start 25s');
  assert.equal(clock.resetLine(), 'reset took 12s; it is not counted in the quick budget.');
});

test('a reset of 10 s or less prints no reset line', () => {
  const { clock } = fake({});
  clock.resetFinished(10_000);
  assert.equal(clock.resetLine(), null);
});

test('the budget note: the first of ran slower, over the budget, and baseline runs over half of B; none when under', () => {
  const run = (budgetedAtSelection, budgetedAtEnd, facts = {}) => {
    const { clock, pass } = fake({});
    clock.resetFinished(0);
    pass(budgetedAtSelection);
    clock.selectionEnded();
    pass(budgetedAtEnd - budgetedAtSelection);
    return clock.budgetNote({ clockCut: 0, unconfirmed: 0, flows: 34, ...facts });
  };
  assert.equal(run(20_000, 90_000), null);
  assert.equal(run(60_000, 90_000), null, 'exactly half is not over half');
  assert.equal(run(64_000, 100_000), 'Baseline runs of 34 saved flows used 1m04s of the 2m00s quick budget.');
  assert.equal(run(64_000, 134_000), 'Over the quick budget by 14s: flow runs still going at 2m00s were allowed to finish.');
  assert.equal(run(20_000, 120_000), null, 'ending exactly at B is not over');
  assert.equal(run(64_000, 134_000, { clockCut: 6, unconfirmed: 2 }), 'Ran slower than planned: 6 attacks and 2 confirmation runs did not start before the quick budget ran out.');
  assert.equal(run(20_000, 90_000, { clockCut: 1, unconfirmed: 0 }), 'Ran slower than planned: 1 attack and 0 confirmation runs did not start before the quick budget ran out.');
  assert.equal(run(20_000, 90_000, { unconfirmed: 1 }), 'Ran slower than planned: 0 attacks and 1 confirmation run did not start before the quick budget ran out.');
});

test('plan: P is the budgeted time up to the end of selection; the report after it is budgeted but not P', () => {
  const { clock, pass } = fake({ mode: 'plan', tier: 'standard' });
  pass(3_000);
  clock.resetFinished(3_000);
  pass(41_000);
  clock.selectionEnded();
  pass(1_500);
  assert.equal(clock.planMs(), 41_000);
  assert.deepEqual(clock.fields(), { budgetMs: 450_000, budgetedMs: 42_500, overMs: 0, planMs: 41_000, attackSetupMs: 0, resetMs: 3_000, startMs: 0 });
  assert.equal(clock.timeLine({ runnerMs: 45_500, adversaryCallsMs: 0 }), 'time: runner 45s = budgeted 42s of 7m30s + reset 3.0s | app start 0.0s');
});

test('attack: setup up to the end of selection is timed, not budgeted; attack time A = B - P starts after it', () => {
  const { clock, pass, at } = fake({ mode: 'attack', planMs: 30_000, bashStop: Infinity });
  pass(2_000);
  clock.resetFinished(2_000);
  pass(7_000); // sign-in, fresh baseline runs, OpenAPI
  clock.selectionEnded();
  const attackStart = at();
  pass(5_000);
  assert.equal(clock.limitMs(), 90_000);
  assert.equal(clock.budgetedMs(), 5_000);
  assert.equal(clock.hardStopAt(), attackStart + 90_000 + 30_000 + 10_000);
  assert.equal(clock.planMs(), 30_000);
  assert.deepEqual(clock.fields(), { budgetMs: 120_000, budgetedMs: 5_000, overMs: 0, planMs: 30_000, attackSetupMs: 9_000, resetMs: 2_000, startMs: 0 });
  assert.equal(clock.timeLine({ runnerMs: 15_000, adversaryCallsMs: 25_000 }), 'time: runner 15s = attack setup 9.0s (timed, not budgeted) + budgeted 5.0s of 1m30s (the quick budget less plan 30s); adversary calls 25s (timed, not budgeted) | app start 0.0s');
  assert.equal(clock.budgetNote({ clockCut: 0, unconfirmed: 0, flows: 3 }), null);
});

test('start rules: a start fits within the limit less the reserve, a closing run within the limit plus G', () => {
  const { clock, pass } = fake({});
  clock.resetFinished(0);
  pass(100_000);
  clock.selectionEnded();
  assert.equal(clock.startFits(17_000, 3_000), true);
  assert.equal(clock.startFits(17_001, 3_000), false);
  assert.equal(clock.closingFits(50_000), true);
  assert.equal(clock.closingFits(50_001), false);
});

test('the hard stop is B + G + 10 s from the budget start, or the Bash stop when that comes first', () => {
  const late = fake({ bashStop: Infinity });
  late.clock.resetFinished(0);
  const start = late.at();
  late.clock.selectionEnded();
  assert.equal(late.clock.hardStopAt(), start + 160_000);
  const bash = fake({ bashStop: 1_050_000 });
  bash.clock.resetFinished(0);
  bash.clock.selectionEnded();
  assert.equal(bash.clock.hardStopAt(), 1_050_000);
});

// The time line budgets attack against A = B - P, so the note and overMs do too (47.3, 50.1).
test('attack: the over-budget note and overMs count from A = B - P, as the time line does', () => {
  const { clock, pass } = fake({ mode: 'attack', planMs: 30_000 });
  clock.resetFinished(0);
  pass(9_000);
  clock.selectionEnded();
  pass(100_000);
  assert.equal(clock.budgetNote({ clockCut: 0, unconfirmed: 0, flows: 3 }), 'Over the quick budget by 10s: flow runs still going at 1m30s were allowed to finish.');
  assert.equal(clock.fields().overMs, 10_000);
  assert.match(clock.timeLine({ runnerMs: 109_000, adversaryCallsMs: 0 }), / budgeted 1m40s of 1m30s /);
});

test('attack: when plan used more than half of B, the note names P, not the attack setup', () => {
  const { clock, pass } = fake({ mode: 'attack', planMs: 64_000 });
  clock.resetFinished(0);
  pass(9_000);
  clock.selectionEnded();
  pass(20_000);
  assert.equal(clock.budgetNote({ clockCut: 0, unconfirmed: 0, flows: 3 }), 'Baseline runs of 3 saved flows used 1m04s of the 2m00s quick budget.');
});
