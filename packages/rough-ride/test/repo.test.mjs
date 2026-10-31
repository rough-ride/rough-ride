import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { classifyRevParse } from '../dist/git.mjs';
import { canonical, caseSensitive, gitRepo, run, scratchDir, sh } from './helpers.mjs';

const json = (result) => ({ ...result, doc: JSON.parse(result.stdout) });

test('from the root, frontend/ and backend/ the runner uses the same git root', () => {
  const root = gitRepo();
  for (const sub of ['', 'frontend', 'backend']) {
    const { doc } = json(run(['quick', '--json'], { cwd: path.join(root, sub) }));
    assert.equal(doc.root, canonical(root));
    assert.equal(doc.cwd, canonical(path.join(root, sub)));
    const rootNote = doc.notes.find((n) => n.id === 'root');
    if (sub === '') assert.equal(rootNote, undefined);
    else assert.deepEqual(rootNote, { id: 'root', text: `root: ${canonical(root)}` });
  }
});

test('not a repository stops with exit 64', () => {
  const { code, doc } = json(run(['quick', '--json']));
  assert.equal(code, 64);
  assert.equal(doc.stop.code, 'no-repository');
  assert.deepEqual(doc.stop.lines, [
    "No git repository here: rough-ride attacks what the diff changes. Run it inside the app's repository.",
  ]);
  assert.equal(doc.root, null);
});

test('no git on PATH stops with exit 69', () => {
  const { code, doc } = json(run(['quick', '--json'], { cwd: gitRepo(), env: { PATH: scratchDir(), Path: scratchDir() } }));
  assert.equal(code, 69);
  assert.equal(doc.stop.code, 'git-missing');
  assert.deepEqual(doc.stop.lines, ['git not found on PATH: rough-ride needs git to read the diff.']);
});

test('another rev-parse failure stops with exit 69 and git\'s first line', () => {
  const root = gitRepo();
  const inside = path.join(root, '.git');
  const { code, doc } = json(run(['quick', '--json'], { cwd: inside }));
  assert.equal(code, 69);
  assert.equal(doc.stop.code, 'git-failed');
  assert.match(doc.stop.lines[0], new RegExp(`^git rev-parse failed in ${canonical(inside)}: fatal: `));
});

test('the home folder as the root stops with exit 64', () => {
  const root = gitRepo();
  const { code, doc } = json(run(['quick', '--json'], { cwd: root, env: { HOME: root, USERPROFILE: root } }));
  assert.equal(code, 64);
  assert.equal(doc.stop.code, 'home-root');
  assert.deepEqual(doc.stop.lines, [
    `The git repository here is your home folder (${canonical(root)}). Run rough-ride inside the app's own repository.`,
  ]);
});

test('on Windows a non-Windows path from git stops with exit 69', () => {
  const result = classifyRevParse({ status: 0, stdout: '/c/repo\n', stderr: '' }, 'C:/repo', 'win32', 'C:/Users/u');
  assert.equal(result.stop.code, 'git-not-windows');
  assert.deepEqual(result.stop.lines, ["git printed /c/repo, which isn't a Windows path. Use Git for Windows."]);
});

test('on Windows the home folder in another spelling is still the home folder', () => {
  const result = classifyRevParse({ status: 0, stdout: 'c:/users/u\n', stderr: '' }, 'C:/Users/u', 'win32', 'C:\\Users\\U\\');
  assert.equal(result.stop.code, 'home-root');
  // On a Windows host, canon finds C:\Users in its stored case.
  assert.match(result.stop.lines[0], /^The git repository here is your home folder \(C:\/users\/u\)\. Run rough-ride inside the app's own repository\.$/i);
  assert.deepEqual(classifyRevParse({ status: 0, stdout: 'C:/Users/u/app\n', stderr: '' }, 'C:/Users/u/app', 'win32', 'C:\\Users\\u'), { root: 'C:/Users/u/app' });
});

test('a case variant of the folder at the root stops with exit 78', () => {
  const root = gitRepo();
  mkdirSync(path.join(root, '.Rough-Ride'));
  const expected = 'Found .Rough-Ride/ at the repository root. rough-ride reads only .rough-ride/ in lowercase: rename it with git mv.';
  let { code, doc } = json(run(['quick', '--json'], { cwd: root }));
  assert.equal(code, 78);
  assert.deepEqual([doc.stop.code, doc.stop.lines], ['folder-shape', [expected]]);
  if (caseSensitive(root)) {
    mkdirSync(path.join(root, '.rough-ride'));
    ({ code, doc } = json(run(['quick', '--json'], { cwd: root })));
    assert.equal(code, 78);
    assert.deepEqual(doc.stop.lines, [expected]);
  }
});

test('a link or a file at the root stops with exit 78', () => {
  const linked = gitRepo();
  mkdirSync(path.join(linked, 'real'));
  symlinkSync(path.join(linked, 'real'), path.join(linked, '.rough-ride'), 'junction');
  let { code, doc } = json(run(['quick', '--json'], { cwd: linked }));
  assert.equal(code, 78);
  assert.deepEqual(doc.stop.lines, ['.rough-ride at the repository root is a link. rough-ride needs a real folder there.']);

  const file = gitRepo();
  writeFileSync(path.join(file, '.rough-ride'), '');
  ({ code, doc } = json(run(['quick', '--json'], { cwd: file })));
  assert.equal(code, 78);
  assert.deepEqual(doc.stop.lines, ['.rough-ride at the repository root is a file. rough-ride needs a real folder there.']);
});

test('a sparse checkout that leaves the folder out stops with exit 78', () => {
  const root = gitRepo();
  mkdirSync(path.join(root, '.rough-ride'));
  writeFileSync(path.join(root, '.rough-ride', 'config.yaml'), 'schema: 0.1.0\n');
  writeFileSync(path.join(root, 'frontend', 'app.ts'), '');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'x');
  sh(root, 'sparse-checkout', 'set', '--no-cone', '/frontend/');
  const { code, doc } = json(run(['quick', '--json'], { cwd: root }));
  assert.equal(code, 78);
  assert.equal(doc.stop.code, 'sparse-checkout');
  assert.deepEqual(doc.stop.lines, ['.rough-ride/ is outside your sparse checkout. Run: git sparse-checkout add .rough-ride']);
});
