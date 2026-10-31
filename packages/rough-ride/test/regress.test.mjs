import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combine, judgeRun } from '../dist/regress.mjs';

test('only listed checks decide; a listed check failing in the baseline fails with no attack; others print as also failed', () => {
  const o = (checks, verdict = 'failed') => ({ verdict, checks: checks.map(([id, result]) => ({ id, result, evidence: 'e' })), run: { stoppedAt: null, fault: null }, kind: 'fault', id: 'x' });
  assert.deepEqual(judgeRun(['settles'], o([['settles', 'fail'], ['no-uncaught-error', 'fail']])), { state: 'fail', reason: null, failed: ['settles'], alsoFailed: ['no-uncaught-error'] });
  assert.equal(judgeRun(['settles'], o([['settles', 'pass'], ['no-uncaught-error', 'fail']])).state, 'pass');
  assert.deepEqual(judgeRun(['settles'], o([['settles', 'skipped-baseline']], 'passed')), { state: 'fail', reason: 'fails with no attack', failed: ['settles'], alsoFailed: [] });
  assert.equal(judgeRun(['settles'], o([], 'fault-never-fired')).state, 'stale');
  assert.equal(judgeRun([{ id: 'app-x' }, 'settles'], o([['settles', 'not-evaluated']], 'passed')).state, 'stale');
});

test('outcomes from two runs: pass, fail, flaky or stale; a stale run plus a failing one is fail', () => {
  const j = (state) => ({ state, reason: null, failed: [], alsoFailed: [] });
  assert.equal(combine(j('pass'), null), 'pass');
  assert.equal(combine(j('fail'), j('fail')), 'fail');
  assert.equal(combine(j('fail'), j('pass')), 'flaky');
  assert.equal(combine(j('stale'), j('stale')), 'stale');
  assert.equal(combine(j('stale'), j('fail')), 'fail');
});
