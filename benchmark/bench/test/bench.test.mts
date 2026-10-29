import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { APPS, BENCHMARK, filesUnder, loadApp, type App } from '../apps.mts';
import { hintProblems, hintWords, portabilityProblems } from '../lint.mts';
import { FIXED_DATE, materialize } from '../materialize.mts';

const work = () => realpathSync.native(mkdtempSync(path.join(tmpdir(), 'bench-')));
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout;

// A copy of the fixture app to break on purpose.
function fixtureCopy(): App {
  const dir = path.join(work(), 'fixture');
  cpSync(path.join(APPS, 'fixture'), dir, { recursive: true });
  const app = loadApp('fixture');
  return {
    ...app,
    dir,
    features: app.features.map((f) => ({
      ...f,
      dir: path.join(dir, 'features', f.id),
      bugs: f.bugs.map((b) => ({ ...b, dir: path.join(dir, 'features', f.id, 'bugs', b.id) })),
    })),
  };
}

test('a buggy variant and its clean twin differ only by the bug.patch lines', () => {
  const root = work();
  const clean = materialize('fixture', 'add-tags', null, { workDir: root, install: false });
  const buggy = materialize('fixture', 'add-tags', 'tags-keep-spaces', { workDir: root, install: false });
  assert.notEqual(path.dirname(clean), path.dirname(buggy));
  assert.equal(path.basename(clean), 'fixture-notes');
  assert.match(path.basename(path.dirname(clean)), /^[a-z0-9]{8}$/);
  const files = filesUnder(clean);
  assert.deepEqual(filesUnder(buggy), files);
  const differ = files.filter((f) => !readFileSync(path.join(clean, f)).equals(readFileSync(path.join(buggy, f))));
  assert.deepEqual(differ, ['tags.mjs']);
  assert.equal(readFileSync(path.join(buggy, 'tags.mjs'), 'utf8').includes('tag.toLowerCase()'), true);
});

test('one Initial commit on main by Dev at the fixed date; the feature is uncommitted, untracked files included', () => {
  const dir = materialize('fixture', 'add-tags', 'tags-keep-spaces', { workDir: work(), install: false });
  // Epoch seconds: git versions print the ISO date with Z or +00:00.
  const epoch = Date.parse(FIXED_DATE) / 1000;
  assert.equal(git(dir, 'log', '--format=%s|%an <%ae>|%at|%ct', 'main').trim(), `Initial commit|Dev <dev@example.com>|${epoch}|${epoch}`);
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
  const status = git(dir, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).sort();
  assert.deepEqual(status, ['?? .rough-ride/specs/request.txt', '?? tags.mjs', ' M backend/app.py', ' M server.mjs'].sort());
  assert.deepEqual(readFileSync(path.join(dir, '.rough-ride', 'specs', 'request.txt')), readFileSync(path.join(APPS, 'fixture', 'features', 'add-tags', 'request.md')));
});

test('no materialised folder holds a manifest, reference test or instruction file', () => {
  const dir = materialize('fixture', 'add-tags', 'tags-keep-spaces', { workDir: work(), install: false });
  const forbidden = /(^|\/)(manifest\.yaml|reference\.spec\.ts|decoys\.yaml|hardening\.md|harvest\.md|provenance\.md|CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md)$|^\.claude\/(CLAUDE\.md|AGENTS\.md|rules\/)|^features\//;
  assert.deepEqual(filesUnder(dir).filter((f) => forbidden.test(f)), []);
});

test('materialize installs with npm ci and uv sync, with nothing shared or linked', { skip: spawnSync('uv', ['--version']).status !== 0 && 'uv is not installed' }, () => {
  const dir = materialize('fixture', 'add-tags', null, { workDir: work() });
  assert.ok(existsSync(path.join(dir, 'backend', '.venv')), 'uv sync made backend/.venv');
  // The fixture has no npm dependencies, so npm ci leaves no node_modules; it must never be a link.
  assert.ok(!existsSync(path.join(dir, 'node_modules')) || !lstatSync(path.join(dir, 'node_modules')).isSymbolicLink());
});

test('on Windows a work root longer than 40 characters is refused', () => {
  const long = path.join(work(), 'a-rather-long-folder-name-for-the-work-root');
  cpSync(path.join(APPS, 'fixture', 'app.yaml'), path.join(long, 'x'), { recursive: true });
  assert.throws(() => materialize('fixture', 'add-tags', null, { workDir: long, install: false, platform: 'win32' }), /longer than 40 characters/);
});

test('benchmark/.gitattributes keeps a binary file byte for byte through a checkout', () => {
  const dir = work();
  git(dir, 'init', '-q');
  cpSync(path.join(BENCHMARK, '.gitattributes'), path.join(dir, '.gitattributes'));
  const icon = readFileSync(path.join(APPS, 'fixture', 'base', 'favicon.ico'));
  writeFileSync(path.join(dir, 'favicon.ico'), icon);
  git(dir, 'add', '-A');
  spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=n', 'commit', '-qm', 'x'], { cwd: dir });
  rmSync(path.join(dir, 'favicon.ico'));
  spawnSync('git', ['-c', 'core.autocrlf=true', 'checkout', '--', 'favicon.ico'], { cwd: dir });
  assert.deepEqual(readFileSync(path.join(dir, 'favicon.ico')), icon);
  assert.equal(readFileSync(path.join(BENCHMARK, '.gitattributes'), 'utf8'), '* text=auto eol=lf\n*.patch -text\n');
});

test('the fixture passes both lints', () => {
  const app = loadApp('fixture');
  assert.deepEqual(portabilityProblems(app), []);
  assert.deepEqual(hintProblems(app, hintWords([app])), []);
});

test('the portability lint fails each rule', () => {
  const cases: [string, (base: string, app: App) => void, RegExp][] = [
    ['no package-lock.json', (b) => rmSync(path.join(b, 'package-lock.json')), /no committed package-lock\.json/],
    ['no uv.lock', (b) => rmSync(path.join(b, 'backend', 'uv.lock')), /has no committed uv\.lock/],
    ['another package manager', (b) => writeFileSync(path.join(b, 'yarn.lock'), ''), /only npm and uv/],
    ['Docker', (b) => writeFileSync(path.join(b, 'Dockerfile'), 'FROM node'), /no Docker/],
    ['inline VAR=x', (b) => patchScripts(b, { dev: 'PORT=3700 node server.mjs' }), /inline VAR=x/],
    ['&', (b) => patchScripts(b, { dev: 'node server.mjs & node api.mjs' }), /& is POSIX-only/],
    ['rm -rf', (b) => patchScripts(b, { clean: 'rm -rf dist' }), /rm -rf/],
    ['another port', (b) => writeFileSync(path.join(b, 'server.mjs'), "fetch('http://localhost:3000/api')\n"), /port 3000 is not this app's/],
    ['Nuxt + FastAPI config', (b, app) => {
      app.yaml.stack = 'nuxt-fastapi';
      writeFileSync(path.join(b, '.rough-ride', 'config.yaml'), 'schema: 0.1.0\nreset: npm run reset\ntarget:\n  url: http://localhost:3700\n');
    }, /holds target; a Nuxt \+ FastAPI base holds only schema and reset/],
  ];
  for (const [name, breakIt, expected] of cases) {
    const app = fixtureCopy();
    breakIt(path.join(app.dir, 'base'), app);
    const problems = portabilityProblems(app);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: ${problems.join('; ')}`);
  }
});

function patchScripts(base: string, scripts: Record<string, string>): void {
  const file = path.join(base, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  pkg.scripts = { ...pkg.scripts, ...scripts };
  writeFileSync(file, JSON.stringify(pkg));
}

test('the hint lint finds whole words in added lines, and allowWords lets one through', () => {
  const app = fixtureCopy();
  const bug = app.features[0]!.bugs[0]!;
  const patch = path.join(bug.dir, 'bug.patch');
  writeFileSync(patch, readFileSync(patch, 'utf8').replace('+  const clean = tag.toLowerCase();', '+  const clean = tag.toLowerCase(); // TODO trim'));
  const words = hintWords([app]);
  assert.ok(words.includes('silent-failure') && words.includes('tags-keep-spaces'));
  const problems = hintProblems(app, words);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /bug\.patch line \d+: hint word "todo"$/);
  bug.manifest.allowWords = ['todo'];
  assert.deepEqual(hintProblems(app, words), []);
  // Whole words only: "todos" and "debugger" are not hits.
  writeFileSync(patch, readFileSync(patch, 'utf8').replace('// TODO trim', '// todos and debugger'));
  bug.manifest.allowWords = [];
  assert.deepEqual(hintProblems(app, words), []);
});

test('the bench script never imports the runner', () => {
  for (const file of filesUnder(path.join(BENCHMARK, 'bench'))) {
    const text = readFileSync(path.join(BENCHMARK, 'bench', file), 'utf8');
    assert.ok(!/packages\/rough-ride|from 'rough-ride'/.test(text) || file.startsWith('test/'), file);
  }
});
