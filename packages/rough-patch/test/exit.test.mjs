import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeStop, resolveExit, STOP_CODES, STOP_EXIT } from '../dist/exit.mjs';

test('each stop kind maps to its sysexits code', () => {
  assert.deepEqual(STOP_EXIT, { usage: 64, environment: 69, retry: 75, setup: 78 });
  for (const [kind, codes] of Object.entries(STOP_CODES)) {
    for (const code of codes) {
      const stop = makeStop(code, ['x']);
      assert.equal(stop.kind, kind);
      assert.deepEqual(resolveExit({ stop }), { exitCode: STOP_EXIT[kind], status: 'stopped', stopKind: kind });
    }
  }
});

test('no stop code belongs to two kinds', () => {
  const all = Object.values(STOP_CODES).flat();
  assert.equal(new Set(all).size, all.length);
});

test('70, 130 and 143 override everything', () => {
  const stop = makeStop('busy', []);
  const everything = { stop, verdicts: [1, 2, 0] };
  assert.equal(resolveExit({ ...everything, internalError: true, signal: 'SIGINT' }).exitCode, 70);
  assert.deepEqual(resolveExit({ ...everything, signal: 'SIGINT' }), { exitCode: 130, status: 'interrupted', stopKind: null });
  assert.deepEqual(resolveExit({ ...everything, signal: 'SIGTERM' }), { exitCode: 143, status: 'interrupted', stopKind: null });
});

test('a stop ends the invocation whatever the verdicts so far', () => {
  assert.equal(resolveExit({ stop: makeStop('ask', []), verdicts: [1] }).exitCode, 78);
});

test('among verdicts 1 beats 2, which beats 0', () => {
  assert.deepEqual(resolveExit({ verdicts: [0, 2, 1] }), { exitCode: 1, status: 'findings', stopKind: null });
  assert.deepEqual(resolveExit({ verdicts: [0, 2] }), { exitCode: 2, status: 'incomplete', stopKind: null });
  assert.deepEqual(resolveExit({ verdicts: [0] }), { exitCode: 0, status: null, stopKind: null });
  assert.deepEqual(resolveExit({}), { exitCode: 0, status: null, stopKind: null });
});
