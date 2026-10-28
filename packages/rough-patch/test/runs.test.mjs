import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { checkPath } from '../hooks/path-check.mjs';
import { StopError } from '../dist/exit.mjs';
import { checkRootEntry, ensureFolder } from '../dist/folder.mjs';
import { lockPath, takeFlowLock } from '../dist/lock.mjs';
import { createRunFolder, makeRunId, pruneRuns, RUN_ID, unfinishedRunNote } from '../dist/runs.mjs';
import { refusedName, renameWithRetry, writeAtomic } from '../dist/write.mjs';
import { gitRepo } from './helpers.mjs';

function stopOf(fn) {
  try {
    fn();
  } catch (error) {
    if (error instanceof StopError) return error.stop;
    throw error;
  }
  assert.fail('expected a stop');
}

function folderIn(root = gitRepo()) {
  return ensureFolder(checkRootEntry(root));
}

function allFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test('run ids are UTC, use the first word of the subcommand and fit 29 characters', () => {
  const now = new Date('2026-10-25T14:12:07.900Z');
  assert.equal(makeRunId('quick', now, 'k3fz'), '20261025-141207-quick-k3fz');
  assert.equal(makeRunId('flow save', now, 'a1b2'), '20261025-141207-flow-a1b2');
  for (const name of ['quick', 'standard', 'plan', 'regress', 'repro', 'flow save']) {
    const { id } = createRunFolder(folderIn(), name);
    assert.match(id, RUN_ID);
    assert.ok(id.length <= 29, id);
  }
});

test('a forced EEXIST draws a new suffix up to 5 times', () => {
  const folder = folderIn();
  const now = new Date('2026-10-25T14:12:07Z');
  mkdirSync(path.join(folder.dir, 'runs'));
  const suffixes = ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee', 'ffff'];
  for (const s of suffixes.slice(0, 5)) mkdirSync(path.join(folder.dir, 'runs', makeRunId('quick', now, s)));
  let i = 0;
  assert.equal(createRunFolder(folder, 'quick', { now, suffix: () => suffixes[i++] }).id, '20261025-141207-quick-ffff');

  i = 0;
  const stop = stopOf(() => createRunFolder(folder, 'quick', { now, suffix: () => suffixes[i++] }));
  assert.equal(stop.code, 'write-failed');
  assert.equal(i, 6);
});

test('write rules: extensions, names and no links', () => {
  for (const ok of [['runs', 'r', 'summary.json'], ['runs', 'r', 'repros', 'r03-baseline.png'], ['runs', 'r', 'diff.patch'], ['.gitignore']]) {
    assert.equal(refusedName(ok), null, ok.join('/'));
  }
  for (const bad of [
    ['runs', 'r', 'index.html'], ['runs', 'r', 'notes.md'], ['runs', 'r', 'x.ts'], ['runs', 'r', 'x.vue'],
    ['runs', 'r', 'x.css'], ['runs', 'r', 'x.py'], ['runs', 'r', 'x'], ['runs', 'r', 'x.exe'],
    ['runs', 'r', 'package.json'], ['runs', 'r', 'tsconfig.json'], ['runs', 'r', 'vite.config.json'],
    ['.env'], ['.env.local'], ['runs', 'r', 'Upper.json'], ['runs', 'r', 'con.json'], ['runs', 'LPT1', 'x.json'],
  ]) {
    assert.notEqual(refusedName(bad), null, bad.join('/'));
  }
});

test('writes are atomic, leave no temporary file, and every path written matches the hook', () => {
  const folder = folderIn();
  const run = createRunFolder(folder, 'quick');
  writeAtomic(folder, ['runs', run.id, 'summary.json'], '{}\n');
  writeAtomic(folder, ['runs', run.id, 'repros', 'r03.json'], '{}\n');
  writeAtomic(folder, ['runs', run.id, 'summary.json'], '{"again":true}\n');
  assert.equal(readFileSync(path.join(run.dir, 'summary.json'), 'utf8'), '{"again":true}\n');
  const files = allFiles(folder.dir);
  assert.ok(!files.some((f) => path.basename(f).startsWith('tmp-')), files.join('\n'));
  for (const file of files) assert.equal(checkPath(file, folder.root).blocked, true, file);
});

test('a write through a link, or into a read-only folder, stops with the path, the code and exit 69', () => {
  const folder = folderIn();
  const run = createRunFolder(folder, 'quick');
  const outside = path.join(folder.root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, path.join(run.dir, 'repros'), 'junction');
  let stop = stopOf(() => writeAtomic(folder, ['runs', run.id, 'repros', 'r01.json'], '{}'));
  assert.deepEqual([stop.kind, stop.code, stop.lines], ['environment', 'write-failed', [`Can't write .rough-patch/runs/${run.id}/repros/r01.json: ELINK.`]]);
  assert.deepEqual(readdirSync(outside), []);

  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    chmodSync(run.dir, 0o500);
    stop = stopOf(() => writeAtomic(folder, ['runs', run.id, 'report.txt'], 'x'));
    chmodSync(run.dir, 0o700);
    assert.deepEqual(stop.lines, [`Can't write .rough-patch/runs/${run.id}/report.txt: EACCES.`]);
  }
});

test('retention keeps the newest 10 tier runs and 10 other runs, and never the current, young, linked or odd folders', () => {
  const folder = folderIn();
  const runs = path.join(folder.dir, 'runs');
  mkdirSync(runs);
  const old = (i, word) => `202501${String(i + 1).padStart(2, '0')}-120000-${word}-aaaa`;
  for (let i = 0; i < 13; i++) mkdirSync(path.join(runs, old(i, i % 2 ? 'quick' : 'plan')));
  for (let i = 0; i < 12; i++) mkdirSync(path.join(runs, old(i, 'regress')));
  const current = old(0, 'repro');
  mkdirSync(path.join(runs, current));
  const young = makeRunId('quick', new Date(Date.now() - 60_000), 'yyyy');
  mkdirSync(path.join(runs, young));
  mkdirSync(path.join(runs, 'keep-me'));
  mkdirSync(path.join(folder.root, 'target'));
  symlinkSync(path.join(folder.root, 'target'), path.join(runs, old(0, 'standard')), 'junction');

  const lock = takeFlowLock(folder.root, []);
  const removed = pruneRuns(folder, lock, current);
  lock.release();

  // Tier: 13 old + 1 young = 14, keep 10 newest by name (the young one among them), so the 4 oldest go.
  assert.deepEqual(removed.filter((id) => !id.includes('regress')).sort(), [0, 1, 2, 3].map((i) => old(i, i % 2 ? 'quick' : 'plan')));
  // Other: 12 regress + the current repro; the current is never removed.
  assert.deepEqual(removed.filter((id) => id.includes('regress')).sort(), [0, 1].map((i) => old(i, 'regress')));
  for (const kept of [current, young, 'keep-me', old(0, 'standard')]) assert.ok(existsSync(path.join(runs, kept)), kept);
});

test('the newest tier or regress run without summary.json gets the unfinished-run note', () => {
  const folder = folderIn();
  const runs = path.join(folder.dir, 'runs');
  mkdirSync(runs);
  mkdirSync(path.join(runs, '20260101-120000-quick-aaaa'));
  writeFileSync(path.join(runs, '20260101-120000-quick-aaaa', 'summary.json'), '{}');
  mkdirSync(path.join(runs, '20260102-120000-quick-bbbb'));
  const lock = takeFlowLock(folder.root, []);
  assert.deepEqual(unfinishedRunNote(folder, lock, null), {
    id: 'unfinished-run',
    text: 'Unfinished run 20260102-120000-quick-bbbb: it stopped before its report (killed or crashed); attacks so far are in its attacks.jsonl.',
  });

  const plan = path.join(runs, '20260103-120000-plan-cccc');
  mkdirSync(plan);
  writeFileSync(path.join(plan, 'summary.json'), '{"phase":"planned"}');
  assert.equal(unfinishedRunNote(folder, lock, null), null);
  writeFileSync(path.join(plan, 'attacks.jsonl'), '{"attack":1}\n');
  assert.match(unfinishedRunNote(folder, lock, null).text, /^Unfinished run 20260103-120000-plan-cccc:/);
  lock.release();
});

test('a second flow-running invocation stops on the lock; a dead holder\'s lock is taken over', () => {
  const root = gitRepo();
  const lock = takeFlowLock(root, []);
  const stop = stopOf(() => takeFlowLock(root, []));
  assert.equal(stop.code, 'busy');
  assert.match(
    stop.lines[0],
    new RegExp(`^Another rough-patch invocation \\(pid ${process.pid}, started \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d UTC\\) is running flows for this repository\\. Wait for it, or stop it \\(Ctrl-C in its terminal\\)\\.$`),
  );
  lock.release();
  assert.equal(existsSync(lockPath(root)), false);

  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  const pid = Number(dead.stdout.trim());
  writeFileSync(lockPath(root), JSON.stringify({ pid, startedAt: '2026-10-27T14:12:07.000Z' }));
  const notes = [];
  const taken = takeFlowLock(root, notes);
  assert.deepEqual(notes, [
    { id: 'lock-taken-over', text: `Took over the flow lock of rough-patch invocation pid ${pid}, started 2026-10-27 14:12:07 UTC: that process is gone.` },
  ]);
  taken.release();
});

test('on Windows a rename that meets EPERM or EBUSY is retried 3 times', () => {
  const failing = (codes) => {
    const calls = [];
    const rename = () => {
      const code = codes[calls.length];
      calls.push(code ?? 'ok');
      if (code) throw Object.assign(new Error(code), { code });
    };
    return { rename, calls };
  };
  let fake = failing(['EPERM', 'EBUSY']);
  renameWithRetry('a', 'b', fake.rename, 'win32');
  assert.deepEqual(fake.calls, ['EPERM', 'EBUSY', 'ok']);

  fake = failing(['EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY']);
  assert.throws(() => renameWithRetry('a', 'b', fake.rename, 'win32'), { code: 'EBUSY' });
  assert.equal(fake.calls.length, 4);

  fake = failing(['EPERM']);
  assert.throws(() => renameWithRetry('a', 'b', fake.rename, 'linux'), { code: 'EPERM' });
  assert.equal(fake.calls.length, 1);
});
