import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { StopError } from '../dist/exit.mjs';
import { fileHash, Manifest } from '../dist/manifest.mjs';
import { compareProtected } from '../dist/protected.mjs';
import { gitRepo, scratchDir, sh } from './helpers.mjs';

const TEST = `schema: 0.1.0
flow: create-note
attack: {fault: "500", sticky: true, request: "POST /api/notes #1", page: /notes/new}
checks: [visible-error-message, settles]
context: {timezone: UTC, locale: en-US}
found: {run: 20261025-141207-quick-k3fz}
`;

function repo() {
  const root = gitRepo();
  writeFileSync(path.join(root, 'README.md'), 'x\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'base');
  sh(root, 'branch', '-M', 'main');
  sh(root, 'checkout', '-q', '-b', 'feature');
  mkdirSync(path.join(root, '.rough-patch', 'tests'), { recursive: true });
  return root;
}

async function compare(root, manifest, { env = {}, pluginData = false } = {}) {
  const { parse } = await import('yaml');
  const dir = path.join(root, '.rough-patch', 'tests');
  const tests = readdirSync(dir).map((n) => {
    const text = readFileSync(path.join(dir, n), 'utf8');
    return { shown: `.rough-patch/tests/${n}`, text, value: parse(text), kind: 'tests', schema: null, problems: [], step5: [] };
  });
  return compareProtected({ root, folderDir: path.join(root, '.rough-patch'), files: { config: null, accepted: null, flows: [], tests, invalid: [], notes: [] }, env, pluginData, manifest });
}

test('location: .git/.rough-patch in a main checkout, the worktree\'s own folder in a linked worktree', () => {
  const root = repo();
  assert.equal(new Manifest(root).file, path.join(realpathSync(root), '.git', '.rough-patch', 'manifest.json'));
  const wt = path.join(scratchDir(), 'wt');
  sh(root, 'worktree', 'add', '-q', '-b', 'other', wt);
  assert.equal(new Manifest(wt).file, path.join(realpathSync(root), '.git', 'worktrees', 'wt', '.rough-patch', 'manifest.json'));
});

test('hashes ignore a BOM and CRLF; a copy whose content doesn\'t match its name is missing', () => {
  assert.equal(fileHash('﻿a: 1\r\nb: 2\r\n'), fileHash('a: 1\nb: 2\n'));
  const root = repo();
  const m = new Manifest(root);
  m.saveCopy('tests/t.yaml', TEST, 'runner', 'run-1', '0.1.0');
  assert.equal(new Manifest(root).savedCopy('tests/t.yaml').text, TEST);
  writeFileSync(path.join(root, '.git', '.rough-patch', 'copies', `${fileHash(TEST)}.yaml`), TEST + '# edited\n');
  assert.equal(new Manifest(root).savedCopy('tests/t.yaml'), null);
});

test('a deleted test with no reviewed version runs its saved copy on its branch only; detached HEAD uses none', async () => {
  const root = repo();
  new Manifest(root).saveCopy('tests/t.yaml', TEST, 'runner', '20261025-141207-quick-k3fz', '0.1.0');
  const out = await compare(root, new Manifest(root));
  assert.deepEqual(out.tests.map((t) => [t.name, t.used]), [['t', 'saved-copy']]);
  assert.equal(out.entries[0].change, 'deleted after rough-patch wrote it (run 20261025-141207-quick-k3fz)');
  assert.equal(out.entries[0].outcome, 'ran the saved copy');
  assert.match(out.entries[0].hint, /^To remove it for good/);
  sh(root, 'checkout', '-q', '-b', 'elsewhere');
  assert.deepEqual((await compare(root, new Manifest(root))).tests, []);
  sh(root, 'checkout', '-q', '--detach');
  assert.ok((await compare(root, new Manifest(root))).notes.some((n) => n.text === 'Saved copies: not used (detached HEAD).'));
});

test('a weakened working copy runs the saved copy; an unchanged one is labelled written by rough-patch', async () => {
  const root = repo();
  const m = new Manifest(root);
  m.saveCopy('tests/t.yaml', TEST, 'runner', 'run-1', '0.1.0');
  writeFileSync(path.join(root, '.rough-patch', 'tests', 't.yaml'), TEST.replace('[visible-error-message, settles]', '[settles]'));
  const out = await compare(root, new Manifest(root));
  assert.equal(out.tests[0].used, 'saved-copy');
  assert.equal(out.entries[0].change, 'removes or changes a check after rough-patch wrote it (run run-1)');
  assert.equal(new Manifest(root).label('tests/t.yaml', TEST), 'written by rough-patch');
  assert.equal(new Manifest(root).label('tests/t.yaml', TEST + '#x\n'), 'changed outside rough-patch');
});

test('detached HEAD with an empty manifest prints no saved-copies note, in or out of CI mode', async () => {
  const root = repo();
  writeFileSync(path.join(root, '.rough-patch', 'tests', 't.yaml'), TEST);
  sh(root, 'checkout', '-q', '--detach');
  for (const env of [{}, { CI: 'true' }, { GITHUB_ACTIONS: 'true' }]) {
    const out = await compare(root, new Manifest(root), { env });
    assert.ok(!out.notes.some((n) => n.text.startsWith('Saved copies')), JSON.stringify(out.notes));
  }
});

test('CI mode leaves attribution labels out and by is null; a plugin data folder keeps them', async () => {
  const { protectedJson, summaryLines, reportLines } = await import('../dist/protected.mjs');
  const root = repo();
  new Manifest(root).saveCopy('tests/t.yaml', TEST, 'runner', 'run-1', '0.1.0');
  writeFileSync(path.join(root, '.rough-patch', 'tests', 't.yaml'), TEST.replace('[visible-error-message, settles]', '[settles]'));
  for (const env of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true', CI: 'false' }]) {
    const out = await compare(root, new Manifest(root), { env });
    assert.ok(out.entries.length > 0);
    assert.ok(protectedJson(out).every((e) => e.by === null), JSON.stringify(protectedJson(out)));
    for (const line of [...summaryLines(out), ...reportLines(out)]) assert.doesNotMatch(line, /\((saved by flow save|written by rough-patch|changed outside rough-patch)\)/);
  }
  const session = await compare(root, new Manifest(root), { env: { CI: 'true' }, pluginData: true });
  assert.equal(protectedJson(session)[0].by, 'changed outside rough-patch');
  const local = await compare(root, new Manifest(root), { env: { CI: '0' } });
  assert.equal(protectedJson(local)[0].by, 'changed outside rough-patch');
});

test('read-back run output: re-indented passes; a changed value, or a deleted manifest, is refused with exit 75', () => {
  const root = repo();
  const m = new Manifest(root);
  const value = { a: 1, b: [1, 2] };
  m.recordRun('run-1', 'diff-map.json', value);
  new Manifest(root).verifyRun('run-1', 'diff-map.json', JSON.parse(JSON.stringify(value, null, 8)), 'diff-map.json', '/rough-patch:quick');
  const refused = (fn) => assert.throws(fn, (e) => e instanceof StopError && e.stop.code === 'refused-run-output' && /^Refused: run run-1's diff-map.json changed after rough-patch wrote it, or this worktree has no record of it\. Run \/rough-patch:quick again\.$/.test(e.stop.lines[0]));
  refused(() => new Manifest(root).verifyRun('run-1', 'diff-map.json', { a: 2, b: [1, 2] }, 'diff-map.json', '/rough-patch:quick'));
  rmSync(path.join(root, '.git', '.rough-patch'), { recursive: true });
  refused(() => new Manifest(root).verifyRun('run-1', 'diff-map.json', value, 'diff-map.json', '/rough-patch:quick'));
});

test('unreadable, unwritable and linked manifests: notes, never a stop, never followed', () => {
  const root = repo();
  const dir = path.join(root, '.git', '.rough-patch');
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'manifest.json'), '{nope');
  assert.match(new Manifest(root).notes[0].text, /^Checksum manifest unreadable \(.*\): changes to files not yet merged are only listed, and earlier run output can't be re-run\.$/);
  writeFileSync(path.join(dir, 'manifest.json'), '{"version": 2}');
  assert.match(new Manifest(root).notes[0].text, /^Checksum manifest unreadable \(version 2\)/);
  rmSync(path.join(dir, 'manifest.json'));
  if (process.platform !== 'win32') {
    chmodSync(dir, 0o500);
    const m = new Manifest(root);
    m.recordRun('run-1', 'diff-map.json', {});
    chmodSync(dir, 0o700);
    assert.match(m.notes[0].text, /^Checksum manifest: can't write .*manifest\.json \(EACCES\)\. Saved copies and run-output checks are off for this run\.$/);
    rmSync(dir, { recursive: true });
    const elsewhere = scratchDir();
    symlinkSync(elsewhere, dir);
    const linked = new Manifest(root);
    linked.recordRun('run-1', 'diff-map.json', {});
    assert.equal(readdirSync(elsewhere).length, 0, 'nothing written through the link');
  }
});

test('pruning drops entries of deleted branches and runs whose folders are gone; git maintenance leaves the folder alone', () => {
  const root = repo();
  const m = new Manifest(root);
  m.saveCopy('tests/t.yaml', TEST, 'runner', 'run-1', '0.1.0');
  m.recordRun('run-gone', 'diff-map.json', {});
  m.recordRun('run-kept', 'diff-map.json', {});
  sh(root, 'checkout', '-q', 'main');
  sh(root, 'branch', '-D', 'feature');
  const again = new Manifest(root);
  again.prune(root, () => false, new Set(['run-kept']));
  const data = JSON.parse(readFileSync(again.file, 'utf8'));
  assert.deepEqual(data.saved, []);
  assert.deepEqual(Object.keys(data.runs), ['run-kept']);
  const before = readFileSync(again.file, 'utf8');
  sh(root, 'gc', '-q', '--prune=now', '--aggressive');
  sh(root, 'repack', '-q', '-ad');
  sh(root, 'maintenance', 'run');
  assert.equal(readFileSync(again.file, 'utf8'), before);
  assert.ok(existsSync(path.join(root, '.git', '.rough-patch', 'copies')) && statSync(path.join(root, '.git', '.rough-patch')).isDirectory());
});
