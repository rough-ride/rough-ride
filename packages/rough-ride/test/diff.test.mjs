import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  automationNote, classify, computeDiff, diffMap, diffPatch, headerLine2, isEmpty, largeDiffNote, resolveBase,
} from '../dist/diff.mjs';
import { StopError } from '../dist/exit.mjs';
import { checkRootEntry, ensureFolder } from '../dist/folder.mjs';
import { canonicalJson } from '../dist/output.mjs';
import { createRunFolder } from '../dist/runs.mjs';
import { writeAtomic } from '../dist/write.mjs';
import { gitRepo, run, scratchDir, sh } from './helpers.mjs';

const SAMPLE = fileURLToPath(new URL('../../../.scratch/chaos-v1/prototypes/sample-app/', import.meta.url));

function write(root, file, text = 'x\n') {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}

// A repository on main with one commit of `files`.
function repo(files = { 'frontend/app.vue': '<template />\n' }) {
  const root = gitRepo();
  sh(root, 'checkout', '-q', '-b', 'main');
  for (const [file, text] of Object.entries(files)) write(root, file, text);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'base');
  return root;
}

const diffOf = (root, extra = {}) => computeDiff({ root, given: null, env: {}, nuxtRoots: [], ...extra });
const byPath = (diff) => Object.fromEntries(diff.files.map((f) => [f.path, f]));

function stopOf(fn) {
  try {
    fn();
  } catch (error) {
    if (error instanceof StopError) return error.stop;
    throw error;
  }
  assert.fail('expected a stop');
}

test('the base follows the order: --base, GITHUB_BASE_REF, origin/HEAD, origin/main, origin/master, main, master', () => {
  const root = repo();
  const first = sh(root, 'rev-parse', 'HEAD').trim();
  sh(root, 'checkout', '-q', '-b', 'feature');
  write(root, 'frontend/b.vue');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'feature');
  const second = sh(root, 'rev-parse', 'HEAD').trim();

  assert.deepEqual(resolveBase(root, null, {}), { ref: 'main', sha: first, given: false });
  sh(root, 'remote', 'add', 'upstream', 'https://example.invalid/x.git');
  sh(root, 'update-ref', 'refs/remotes/upstream/main', first);
  assert.equal(resolveBase(root, null, {}).ref, 'upstream/main', 'the only remote counts as origin');
  sh(root, 'remote', 'add', 'origin', 'https://example.invalid/y.git');
  sh(root, 'update-ref', 'refs/remotes/origin/master', first);
  assert.equal(resolveBase(root, null, {}).ref, 'origin/master');
  sh(root, 'update-ref', 'refs/remotes/origin/main', first);
  assert.equal(resolveBase(root, null, {}).ref, 'origin/main');
  sh(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  assert.equal(resolveBase(root, null, {}).ref, 'origin/HEAD');
  sh(root, 'update-ref', 'refs/remotes/origin/release', first);
  assert.equal(resolveBase(root, null, { GITHUB_BASE_REF: 'release' }).ref, 'origin/release');
  assert.deepEqual(resolveBase(root, 'HEAD', { GITHUB_BASE_REF: 'release' }), { ref: 'HEAD', sha: second, given: true });
});

for (const format of ['sha1', 'sha256']) {
  test(`with no commits (${format}) every non-ignored file is added`, () => {
    const root = scratchDir();
    sh(root, 'init', '-q', `--object-format=${format}`);
    write(root, 'frontend/app.vue');
    write(root, '.gitignore', 'secret.txt\n');
    write(root, 'secret.txt');
    const diff = diffOf(root);
    assert.equal(diff.base.ref, 'empty tree');
    assert.equal(diff.base.sha.length, format === 'sha1' ? 40 : 64);
    assert.deepEqual(diff.files.map((f) => `${f.path} ${f.status}`), ['.gitignore added', 'frontend/app.vue added']);
  });
}

test('committed, staged, unstaged and untracked changes appear; ignored files and CRLF-only changes do not', () => {
  const root = repo({ 'frontend/a.vue': 'a\nb\n', 'frontend/crlf.vue': 'one\ntwo\n', 'frontend/staged.vue': 's\n', 'frontend/edit.vue': 'e\n', '.gitignore': 'ignored.vue\n' });
  sh(root, 'checkout', '-q', '-b', 'feature');
  write(root, 'frontend/committed.vue');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'c');
  write(root, 'frontend/staged.vue', 's2\n');
  sh(root, 'add', 'frontend/staged.vue');
  write(root, 'frontend/edit.vue', 'e2\n');
  write(root, 'frontend/new.vue');
  write(root, 'ignored.vue');
  write(root, 'frontend/crlf.vue', 'one\r\ntwo\r\n');
  sh(root, 'mv', 'frontend/a.vue', 'frontend/b.vue');
  const files = byPath(diffOf(root));
  assert.deepEqual(Object.keys(files).sort(), ['frontend/a.vue', 'frontend/b.vue', 'frontend/committed.vue', 'frontend/edit.vue', 'frontend/new.vue', 'frontend/staged.vue']);
  assert.deepEqual([files['frontend/b.vue'].status, files['frontend/b.vue'].oldPath], ['renamed', 'frontend/a.vue']);
  assert.equal(files['frontend/a.vue'].status, 'deleted');
  assert.equal(files['frontend/new.vue'].untracked, true);
});

test('untracked folders: 1,001 files is one entry, node_modules is dropped and counted, a nested repository is one entry, a submodule too', () => {
  const root = repo();
  for (let i = 0; i < 1001; i++) write(root, `generated-pages/p${i}.vue`);
  write(root, 'frontend/node_modules/x/index.js');
  mkdirSync(path.join(root, 'vendor-repo', '.git'), { recursive: true });
  write(root, 'vendor-repo/a.js');
  const sub = repo({ 'lib.js': '1\n' });
  sh(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'libs/sub');
  const diff = diffOf(root);
  const files = byPath(diff);
  assert.equal(files['generated-pages'].reason, 'not traced (untracked folder of 1,001 files)');
  assert.equal(files['vendor-repo'].reason, 'not traced (nested repository)');
  assert.equal(files['libs/sub'].reason, 'not traced (submodule)');
  assert.deepEqual(diff.dropped, [{ path: 'frontend/node_modules/' }]);
});

test('class fixtures', () => {
  const ctx = { nuxtRoots: ['frontend/'], ignoreCase: false, generated: new Set(), binary: new Set(['backend/data.db']) };
  const cases = {
    'frontend/.rough-ride/.env': 'tool',
    '.Rough-Ride/flows/a.yaml': 'flow',
    '.rough-ride/config.yaml': 'tool',
    '.rough-ride/runs/x/summary.json': 'tool',
    '.claude/settings.json': 'not app code',
    'frontend/app/pages/tests/index.vue': 'app',
    'tests/foo.ts': 'not app code',
    'frontend/CLAUDE.md': 'not app code',
    'frontend/content/about.md': 'app',
    'docs/guide.md': 'not app code',
    'backend/data.db': 'binary',
    'package-lock.json': 'dependency',
    'frontend/package.json': 'dependency',
    'frontend/nuxt.config.ts': 'config',
    '.env.local': 'config',
    'dist/app.js': 'generated',
    'frontend/app.min.js': 'generated',
    'frontend/components/Note.spec.ts': 'not app code',
    'Dockerfile': 'not app code',
    'backend/app.py': 'app',
  };
  for (const [file, cls] of Object.entries(cases)) assert.equal(classify(file, ctx), cls, file);
});

test('a tracked binary file and a deleted case-variant flow are classified from git\'s own output', () => {
  const root = repo({ 'backend/data.db': Buffer.from([0, 1, 2, 0]), '.Rough-Ride/flows/a.yaml': 'schema: 0.1.0\n' });
  write(root, 'backend/data.db', Buffer.from([0, 3, 4, 0, 5]));
  rmSync(path.join(root, '.Rough-Ride'), { recursive: true });
  const files = byPath(diffOf(root));
  assert.equal(files['backend/data.db'].class, 'binary');
  assert.deepEqual([files['.Rough-Ride/flows/a.yaml'].class, files['.Rough-Ride/flows/a.yaml'].status], ['flow', 'deleted']);
});

test('ref stops print their exact lines and codes', () => {
  const root = repo();
  let r = run(['quick', '--base', 'nope', '--json'], { cwd: root });
  assert.equal(r.code, 64);
  assert.deepEqual(JSON.parse(r.stdout).stop.lines, ['Unknown ref for --base: nope.']);
  assert.match(r.stderr, /^rough-ride quick \| [\d.]+s \| stopped\n/);

  const lonely = gitRepo();
  sh(lonely, 'checkout', '-q', '-b', 'feature');
  write(lonely, 'a.vue');
  sh(lonely, 'add', '-A');
  sh(lonely, 'commit', '-q', '-m', 'x');
  r = run(['quick', '--json'], { cwd: lonely });
  assert.equal(r.code, 78);
  assert.deepEqual(JSON.parse(r.stdout).stop, { code: 'no-base', kind: 'setup', lines: ['No base branch found (origin/HEAD, origin/main, origin/master, main, master). Pass --base <ref>.'] });

  const orphan = repo();
  sh(orphan, 'checkout', '-q', '--orphan', 'other');
  write(orphan, 'b.vue');
  sh(orphan, 'add', '-A');
  sh(orphan, 'commit', '-q', '-m', 'orphan');
  sh(orphan, 'remote', 'add', 'origin', 'https://example.invalid/z.git');
  sh(orphan, 'update-ref', 'refs/remotes/origin/main', sh(orphan, 'rev-parse', 'main').trim());
  r = run(['quick', '--json'], { cwd: orphan });
  assert.equal(r.code, 78);
  assert.deepEqual(JSON.parse(r.stdout).stop.lines, ["Can't find the merge base with origin/main: fetch full history (actions/checkout fetch-depth: 0) or pass --base <ref>."]);
  assert.deepEqual(stopOf(() => resolveBase(orphan, null, {}, 'regress')).lines, ["Can't find the merge base with origin/main: fetch full history (actions/checkout fetch-depth: 0)."]);

  const conflict = repo({ 'a.vue': 'base\n' });
  sh(conflict, 'checkout', '-q', '-b', 'one');
  write(conflict, 'a.vue', 'one\n');
  sh(conflict, 'commit', '-q', '-am', 'one');
  sh(conflict, 'checkout', '-q', 'main');
  write(conflict, 'a.vue', 'two\n');
  sh(conflict, 'commit', '-q', '-am', 'two');
  spawnMerge(conflict);
  r = run(['quick', '--json'], { cwd: conflict });
  assert.equal(r.code, 78);
  assert.deepEqual(JSON.parse(r.stdout).stop.lines, ['Unmerged paths: a.vue. Finish the merge or rebase first.']);
});

function spawnMerge(root) {
  try {
    sh(root, 'merge', '-q', 'one');
  } catch {
    // The conflict is the point.
  }
}

test('only quick, standard and plan take --base', () => {
  const root = repo();
  for (const sub of ['regress', 'snapshot', 'attack']) {
    const r = run([sub, '--base', 'main', '--json'], { cwd: root });
    assert.equal(r.code, 64, sub);
    assert.deepEqual(JSON.parse(r.stdout).stop.lines, ['Unknown flag --base. Run rough-ride --help for the flags.']);
  }
});

test('header line 2 names the base, and --base HEAD names the files it leaves out', () => {
  const root = repo();
  sh(root, 'remote', 'add', 'origin', 'https://example.invalid/y.git');
  sh(root, 'update-ref', 'refs/remotes/origin/main', sh(root, 'rev-parse', 'HEAD').trim());
  sh(root, 'checkout', '-q', '-b', 'feature');
  write(root, 'frontend/pushed-not.vue');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'local');
  write(root, 'frontend/app.vue', '<template>changed</template>\n');
  const plain = diffOf(root);
  assert.match(headerLine2(plain), /^diff: origin\/main [0-9a-f]{7}\.\.working tree \| 2 files$/);
  const given = diffOf(root, { given: 'HEAD' });
  assert.match(headerLine2(given), /^diff: HEAD [0-9a-f]{7}\.\.working tree \| 1 file \(--base given: leaves out 1 file that differ from origin\/main\)$/);
  assert.deepEqual(given.base.leftOut, ['frontend/pushed-not.vue']);
  assert.equal(given.base.default.ref, 'origin/main');
  write(root, 'frontend/app.vue', '<template />\n');
  sh(root, 'checkout', '-q', '--', '.');
  const same = diffOf(root, { given: 'main' });
  assert.match(headerLine2(same), / \(--base given\)$|leaves out/);
});

test('only README.md changed: Nothing to attack, exit 0, nothing created under .rough-ride', () => {
  const root = repo();
  write(root, 'README.md', '# hi\n');
  const r = run(['quick', '--json'], { cwd: root });
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.status, 'nothing-to-attack');
  assert.equal(doc.summaryLines[1], 'Nothing to attack: the 1 changed files are tests, docs, tooling, generated or binary files.');
  assert.match(doc.summaryLines[0], /^rough-ride quick \| [\d.]+s \| 0\.x pre-release: detection and false-alarm rates not measured yet$/);
  assert.equal(existsSync(path.join(root, '.rough-ride')), false);
  const text = run(['quick'], { cwd: root });
  assert.equal(text.stdout.split('\n')[1], 'Nothing to attack: the 1 changed files are tests, docs, tooling, generated or binary files.');
});

test('only CLAUDE.md changed: the docs line and no automation note; a deleted test names itself and points to regress', () => {
  const root = repo({ 'frontend/app.vue': 'x\n', '.rough-ride/tests/create-note-500-a41f0c.yaml': 'schema: 0.1.0\n' });
  write(root, 'CLAUDE.md', 'Never use navigator.webdriver.\n');
  let doc = JSON.parse(run(['quick', '--json'], { cwd: root }).stdout);
  assert.equal(doc.status, 'nothing-to-attack');
  assert.deepEqual(doc.notes, []);
  rmSync(path.join(root, 'CLAUDE.md'));
  rmSync(path.join(root, '.rough-ride', 'tests', 'create-note-500-a41f0c.yaml'));
  doc = JSON.parse(run(['quick', '--json'], { cwd: root }).stdout);
  assert.match(doc.summaryLines[1], /^Nothing to attack: the 1 changed files are tests, docs, tooling, generated or binary files \(\.rough-ride\/tests\/create-note-500-a41f0c\.yaml deleted\)\. Run node ".*cli\.mjs" regress to run regression tests\.$/);
});

test('an empty diff under --base carries the leaves-out clause and writes nothing', () => {
  const root = repo();
  sh(root, 'checkout', '-q', '-b', 'feature');
  write(root, 'frontend/x.vue');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'x');
  const doc = JSON.parse(run(['quick', '--base', 'HEAD', '--json'], { cwd: root }).stdout);
  assert.match(doc.summaryLines[1], /^Nothing to attack: no changes between HEAD \([0-9a-f]{7}\) and the working tree \(--base given: leaves out 1 file that differ from main\)\.$/);
  assert.deepEqual(doc.diff.base.leftOut, ['frontend/x.vue']);
  assert.equal(existsSync(path.join(root, '.rough-ride')), false);
});

test('diff.patch: app files in full, untracked as additions, lockfiles by counts, secret files by name only', () => {
  const root = repo({ 'frontend/app.vue': 'one\n', 'package-lock.json': '{}\n', '.env.local': 'TOKEN=a\n' });
  write(root, 'frontend/app.vue', 'one\ntwo\n');
  write(root, 'package-lock.json', '{\n"a": 1\n}\n');
  write(root, '.env.local', 'TOKEN=very-secret\n');
  write(root, 'frontend/new.vue', 'brand\nnew');
  const patch = diffPatch(root, diffOf(root)).toString('utf8');
  assert.match(patch, /\+two\n/);
  assert.match(patch, /diff --git a\/frontend\/new\.vue b\/frontend\/new\.vue\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/frontend\/new\.vue\n@@ -0,0 \+1,2 @@\n\+brand\n\+new\n\\ No newline at end of file\n/);
  assert.match(patch, /^# package-lock\.json: modified, \+3 -1 \(dependency, not shown\)$/m);
  assert.match(patch, /^# \.env\.local: modified \(contents not shown\)$/m);
  assert.ok(!patch.includes('very-secret'));
});

test('diff-map.json sits at the run root, has no schema, keeps timestamps under meta and escapes non-ASCII names', () => {
  const root = repo();
  write(root, 'frontend/café.vue');
  write(root, 'frontend/résumé.vue');
  const diff = diffOf(root);
  const folder = ensureFolder(checkRootEntry(root));
  const run_ = createRunFolder(folder, 'quick');
  writeAtomic(folder, ['runs', run_.id, 'diff-map.json'], canonicalJson(diffMap(diff, '2026-10-27T10:00:00.000Z')));
  writeAtomic(folder, ['runs', run_.id, 'diff.patch'], diffPatch(root, diff));
  const text = readFileSync(path.join(run_.dir, 'diff-map.json'), 'utf8');
  const map = JSON.parse(text);
  assert.equal('schema' in map, false);
  assert.deepEqual(map.meta, { startedAt: '2026-10-27T10:00:00.000Z' });
  assert.match(map.digest, /^[0-9a-f]{64}$/);
  assert.ok(text.includes('caf\\u00e9.vue'));
  assert.ok(map.files.some((f) => f.path === 'frontend/résumé.vue'), 'NFC');
  assert.ok(/^[\x00-\x7f]*$/.test(text));
});

test('from backend/ and from the root the diff is the same; run output and later changes never move it', () => {
  // A complete .rough-ride/.gitignore, so neither run adds a file the other sees.
  const root = repo({ 'frontend/app.vue': '<template />\n', '.rough-ride/.gitignore': '# Written by rough-ride. Keep these lines; add your own below them.\n/.env\n/.env.*\n/runs/\n' });
  write(root, 'frontend/app.vue', 'changed\n');
  const a = JSON.parse(run(['quick', '--json'], { cwd: root }).stdout).diff;
  const b = JSON.parse(run(['quick', '--json'], { cwd: path.join(root, 'backend') }).stdout).diff;
  assert.deepEqual(a, b);
  const diff = diffOf(root);
  write(root, '.rough-ride/runs/20261027-100000-quick-abcd/summary.json', '{}');
  write(root, 'frontend/later.vue');
  assert.equal(diff.files.length, 1, 'the computed diff is frozen');
  assert.deepEqual(diffOf(root).files.filter((f) => f.class !== 'tool').map((f) => f.path), ['frontend/app.vue', 'frontend/later.vue']);
  const onlyRuns = repo();
  write(onlyRuns, '.rough-ride/runs/20261027-100000-quick-abcd/summary.json', '{}');
  assert.equal(isEmpty(diffOf(onlyRuns)), true);
});

test('a full invocation leaves .git/index byte-identical and never takes index.lock', () => {
  const root = repo({ 'frontend/app.vue': 'a\n', 'README.md': 'r\n' });
  write(root, 'frontend/app.vue', 'b\n');
  write(root, 'README.md', 'r2\n');
  // A stale stat cache is what makes git want to refresh and rewrite the index.
  const index = path.join(root, '.git', 'index');
  const before = createHash('sha256').update(readFileSync(index)).digest('hex');
  for (const args of [['quick', '--json'], ['standard', '--base', 'main', '--json'], ['plan']]) run(args, { cwd: root });
  assert.equal(createHash('sha256').update(readFileSync(index)).digest('hex'), before);
  assert.equal(existsSync(path.join(root, '.git', 'index.lock')), false);
});

test('201 changed app files print the large-diff note and every file is listed', () => {
  const root = repo();
  for (let i = 0; i < 201; i++) write(root, `frontend/components/C${i}.vue`);
  const diff = diffOf(root);
  assert.equal(diff.files.length, 201);
  assert.match(largeDiffNote(diff).text, /^Large diff: 201 app files against main [0-9a-f]{7}\. Check the base\.$/);
  assert.equal(largeDiffNote(diffOf(repo())), null);
});

test('a diff that adds navigator.webdriver to an app file prints the automation note', () => {
  const root = repo({ 'frontend/plugins/x.ts': 'export default 1\n' });
  write(root, 'frontend/plugins/x.ts', 'export default 1\nconst bot = navigator.webdriver\n');
  const doc = JSON.parse(run(['quick', '--json'], { cwd: root }).stdout);
  assert.deepEqual(doc.notes.find((n) => n.id === 'automation-detection'), {
    id: 'automation-detection',
    text: 'The diff adds code that can tell automation apart (frontend/plugins/x.ts line 2: navigator.webdriver). Verdicts may not match what users see.',
  });
});

test('the same note on a copy of the sample app', { skip: !existsSync(SAMPLE) && 'no sample app' }, () => {
  const root = gitRepo();
  sh(root, 'checkout', '-q', '-b', 'main');
  for (const part of ['frontend/app', 'frontend/nuxt.config.ts', 'frontend/package.json', 'backend/app.py']) {
    cpSync(path.join(SAMPLE, part), path.join(root, part), { recursive: true });
  }
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'sample app');
  const page = path.join(root, 'frontend', 'app', 'pages', 'login.vue');
  const lines = readFileSync(page, 'utf8').split('\n');
  lines.splice(2, 0, 'if (navigator.webdriver) console.log("bot")');
  writeFileSync(page, lines.join('\n'));
  const diff = diffOf(root, { nuxtRoots: ['frontend/'] });
  assert.equal(automationNote(root, diff).text, 'The diff adds code that can tell automation apart (frontend/app/pages/login.vue line 3: navigator.webdriver). Verdicts may not match what users see.');
});
