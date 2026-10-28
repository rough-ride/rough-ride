import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { checkDigest, checkRun, LIMITS, SELECTION } from '../dist/runcheck.mjs';
import { StopError } from '../dist/exit.mjs';
import { checkRootEntry, ensureFolder } from '../dist/folder.mjs';
import { Manifest } from '../dist/manifest.mjs';
import { gitRepo, run, sh } from './helpers.mjs';

const info = { version: '0.1.0', cliPath: '/x/dist/cli.mjs', source: { kind: 'plugin', detail: 'rough-patch@rough-patch', resolved: null }, pluginId: 'rough-patch@rough-patch', pluginData: { path: '/d', verified: true }, node: '22.22.1', playwright: '1.64.1', claudeCode: { version: null, floorChecked: false }, editGuard: 'on', versionSkew: null };
const ID = '20261028-101010-plan-ab12';

function planned(over = {}) {
  const root = gitRepo();
  writeFileSync(path.join(root, 'README.md'), 'x\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'base');
  const folder = ensureFolder(checkRootEntry(root));
  const dir = path.join(folder.dir, 'runs', ID);
  mkdirSync(path.join(dir, 'adversary'), { recursive: true });
  const state = { runId: ID, runner: '0.1.0', tier: 'standard', digest: 'd1', base: { given: null }, planMs: 5000, attacks: [], flows: [], limits: { tier: 'standard', ...LIMITS.standard }, ...over };
  writeFileSync(path.join(dir, ...SELECTION), JSON.stringify(state));
  writeFileSync(path.join(dir, 'diff-map.json'), '{"files":[]}');
  const manifest = new Manifest(root);
  manifest.recordRun(ID, SELECTION.join('/'), state);
  manifest.recordRun(ID, 'diff-map.json', { files: [] });
  return { root, folder, dir, manifest };
}

const stopOf = (fn) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof StopError) return e.stop;
    throw e;
  }
  return null;
};

test('run-id stops: no run, already attacked, another version, an edited selection; each exit 75 naming the run tier', () => {
  const p = planned();
  assert.equal(checkRun(p.folder, ID, info, p.manifest).planMs, 5000);
  assert.deepEqual(stopOf(() => checkRun(p.folder, '20200101-000000-plan-zzzz', info, p.manifest)), { kind: 'retry', code: 'run-not-found', lines: ['No run 20200101-000000-plan-zzzz in this repository. Run /rough-patch:quick again.'] });
  const other = planned({ runner: '0.0.9' });
  assert.deepEqual(stopOf(() => checkRun(other.folder, ID, info, other.manifest)).lines, [`Run ${ID} was planned by rough-patch 0.0.9; this is 0.1.0. Run /rough-patch:standard again.`]);
  const edited = planned();
  writeFileSync(path.join(edited.dir, ...SELECTION), JSON.stringify({ runId: ID, runner: '0.1.0', tier: 'standard', digest: 'd1', planMs: 1 }));
  assert.equal(stopOf(() => checkRun(edited.folder, ID, info, edited.manifest)).code, 'refused-run-output');
  writeFileSync(path.join(p.dir, 'record.json'), '{"phase":"attacked"}');
  assert.deepEqual(stopOf(() => checkRun(p.folder, ID, info, p.manifest)).lines, [`Run ${ID} was already attacked. Run /rough-patch:standard again.`]);
  assert.deepEqual(stopOf(() => checkDigest({ digest: 'd1' }, 'd2')), { kind: 'retry', code: 'code-changed', lines: ['The code changed since the plan was made. Plan again.'] });
});

test('limits follow 42.7 row order', () => {
  assert.deepEqual(Object.keys(LIMITS.quick), ['planCap', 'newFlows', 'repairs', 'flowSaveCalls', 'snapshots', 'links', 'checks', 'patchLines']);
  assert.deepEqual(Object.values(LIMITS.quick), [8, 3, 2, 4, 3, 2, 2, 2000]);
  assert.deepEqual(Object.values(LIMITS.standard), [20, 8, 6, 4, 3, 2, 2, 6000]);
});

test('the CLI: plan takes quick or standard; attack needs --run, takes --plan - only, and has no --check yet', () => {
  const repo = gitRepo();
  for (const args of [['plan'], ['plan', 'fast'], ['plan', 'quick', '--run', ID], ['attack'], ['attack', '--run', ID, '--plan', 'x'], ['attack', 'x', '--run', ID], ['quick', '--plan', '-']]) {
    assert.equal(run(args, { cwd: repo }).code, 64, args.join(' '));
  }
  writeFileSync(path.join(repo, 'README.md'), 'x\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'base');
  assert.equal(run(['attack', '--run', ID], { cwd: repo }).code, 75);
  assert.equal(run(['attack', '--run', ID, '--check'], { cwd: repo }).code, 75);
});

test('the Bash limits apply only with a plugin data folder: no start after 500 s, a deadline at 550 s', async () => {
  const { bashBlocksStart, bashDeadline } = await import('../dist/runcheck.mjs');
  assert.equal(bashBlocksStart(true, 0, 500_000), false);
  assert.equal(bashBlocksStart(true, 0, 500_001), true);
  assert.equal(bashBlocksStart(false, 0, 10_000_000), false);
  assert.equal(bashDeadline(true, 1000), 551_000);
  assert.equal(bashDeadline(false, 1000), Infinity);
});

test('adversary calls add up from calls.jsonl', async () => {
  const { adversaryCallTime, recordCall } = await import('../dist/runcheck.mjs');
  const p = planned();
  recordCall(p.folder, ID, 'flow save', 1200.4);
  recordCall(p.folder, ID, 'flow save', 800);
  assert.equal(adversaryCallTime(p.folder, ID), 2000);
});

test('an attack that started but never finished still counts: attacks.jsonl alone gives the already-attacked stop', () => {
  const p = planned();
  writeFileSync(path.join(p.dir, 'attacks.jsonl'), '{"id":"x"}\n');
  assert.equal(stopOf(() => checkRun(p.folder, ID, info, p.manifest)).code, 'run-attacked');
});

test('with a plugin data folder and a session id, a call writes adversary-runs/<session>.json with the block and its sha256', async () => {
  const { readFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { createHash } = await import('node:crypto');
  const data = mkdtempSync(path.join(tmpdir(), 'rp-data-'));
  const repo = gitRepo();
  const r = run(['bogus', '--plugin-data', data], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: 'sess-77' } });
  const file = JSON.parse(readFileSync(path.join(data, 'adversary-runs', 'sess-77.json'), 'utf8'));
  assert.equal(file.summary, r.stdout);
  assert.equal(file.summarySha256, createHash('sha256').update(r.stdout).digest('hex'));
  assert.deepEqual([file.run, file.attacked], [null, false]);
});
