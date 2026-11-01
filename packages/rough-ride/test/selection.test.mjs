import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { account, AccountingGap, notAttackedLines, nothingAttackedLine, serverOnly, summaryNotAttacked } from '../dist/accounting.mjs';
import { dependents, enclosing, nuxtServerRoute, subclasses, traceBackend } from '../dist/backend.mjs';
import { chooseBrowser, installedOnThisMachine, launchBrowser } from '../dist/browser.mjs';
import { computeDiff } from '../dist/diff.mjs';
import { orderFlows } from '../dist/forms.mjs';
import { runFlow } from '../dist/flowrun.mjs';
import { fetchOpenApi, matchTemplate, operations, rekey } from '../dist/openapi.mjs';
import { select } from '../dist/selection.mjs';
import { LOOPBACK_ONLY } from '../dist/hosts.mjs';
import { gitRepo, sh } from './helpers.mjs';

const SAMPLE_DIR = fileURLToPath(new URL('../../../fixtures/sample-app/', import.meta.url));
const SAMPLE = 'http://localhost:3731';
const API = 'http://127.0.0.1:8731';
const sampleUp = await fetch(`${SAMPLE}/login`).then((r) => r.ok).catch(() => false);
const needsSample = { skip: !sampleUp && 'the sample app is not running (BUGS=none npm run dev in fixtures/sample-app)' };

test('enclosing blocks by indentation; decorators belong to the block below', () => {
  const src = ['import x', '', '@app.post("/a")', 'def create(a):', '    if a:', '        return 1', '', 'class C(Base):', '    def m(self):', '        pass'];
  assert.deepEqual(enclosing(src, 6).map((b) => b.name), ['create']);
  assert.deepEqual(enclosing(src, 3).map((b) => b.name), ['create']);
  assert.deepEqual(enclosing(src, 10).map((b) => b.name), ['m', 'C']);
  assert.deepEqual(enclosing(src, 1), []);
});

test('dependencies follow Depends, Security and Annotated aliases transitively; subclasses follow base lists', () => {
  const sources = new Map([['app.py', [
    'CurrentUser = Annotated[str, Depends(current_user)]',
    'def current_user(token: str = Header()): ...',
    'def admin(user: str = Security(current_user)): ...',
    'def me(user: CurrentUser): ...',
    'def wipe(_: str = Depends(admin)): ...',
    'def health(): ...',
    'class NoteBase(BaseModel): ...',
    'class NoteIn(NoteBase): ...',
    'class NoteOut(NoteIn): ...',
  ].join('\n')]]);
  const reached = dependents(sources, new Set(['current_user']));
  assert.deepEqual(['admin', 'me', 'wipe'].map((n) => reached.has(n)), [true, true, true]);
  assert.equal(reached.has('health'), false);
  assert.deepEqual([...subclasses(sources, new Set(['NoteBase']))].sort(), ['NoteBase', 'NoteIn', 'NoteOut']);
});

test('Nuxt server routes by file name', () => {
  assert.deepEqual(nuxtServerRoute('frontend/server/api/foo.post.ts', 'frontend/'), { endpoints: ['POST /api/foo'] });
  assert.deepEqual(nuxtServerRoute('frontend/server/api/notes/[id].get.ts', 'frontend/'), { endpoints: ['GET /api/notes/{}'] });
  assert.deepEqual(nuxtServerRoute('frontend/server/routes/feed.ts', 'frontend/').endpoints.length, 5);
  assert.equal(nuxtServerRoute('frontend/server/middleware/auth.ts', 'frontend/'), 'app-wide');
  assert.equal(nuxtServerRoute('frontend/server/utils/db.ts', 'frontend/'), 'untraced');
});

test('server-only files', () => {
  assert.ok(serverOnly('src/routes/notes/+page.server.ts', null));
  assert.ok(serverOnly('src/lib/db.server.ts', null));
  assert.ok(!serverOnly('frontend/app/components/Foo.server.vue', null));
  assert.ok(serverOnly('src/lib/keys.ts', "import 'server-only'"));
});

test('flow order: form, write, read, module, app-wide; ties by reach, then name; sign-in last', () => {
  const ordered = orderFlows([
    { name: 'sign-in', cls: 'form', reachCount: 9 },
    { name: 'b-module', cls: 'module', reachCount: 1 },
    { name: 'wide', cls: 'app-wide', reachCount: 5 },
    { name: 'reader', cls: 'read', reachCount: 1 },
    { name: 'a-module', cls: 'module', reachCount: 1 },
    { name: 'writer', cls: 'write', reachCount: 1 },
    { name: 'former', cls: 'form', reachCount: 1 },
    { name: 'c-module', cls: 'module', reachCount: 3 },
  ]);
  assert.deepEqual(ordered.map((f) => f.name), ['former', 'writer', 'reader', 'c-module', 'a-module', 'b-module', 'wide', 'sign-in']);
});

const flowInfo = (name, extra = {}) => ({ name, signedIn: false, passed: true, excluded: false, reach: new Map(), firstLoad: new Map(), sent: new Set(), pages: [], attackPointSteps: [], ...extra });
const file = (p, extra = {}) => ({ path: p, raw: p, oldPath: null, status: 'modified', class: 'app', untracked: false, reason: null, added: 1, deleted: 0, ...extra });
const base = { endpoints: [], untraced: new Map(), signIn: 'passed', modulesOn: true, attacks: [], attacksBuilt: true, tier: 'quick' };

test('counting: Pending counts as attacked; fault never fired, void, Not applied and Skipped do not', () => {
  const flows = [flowInfo('f', { reach: new Map([['src/a.vue', 'module']]), firstLoad: new Map([['src/a.vue', 1]]), attackPointSteps: [2] })];
  const attack = (verdict) => ({ flow: 'f', verdict, kind: 'fault', step: 2, page: '/a', endpoints: [], loaded: [] });
  for (const [verdict, attacked] of [['pending', true], ['passed', true], ['failed', true], ['accepted-finding', true], ['fault-never-fired', false], ['void', false], ['not-applied', false], ['skipped', false]]) {
    const { entries } = account({ ...base, files: [file('src/a.vue')], flows, attacks: [attack(verdict)] });
    assert.equal(entries[0].state === 'attacked', attacked, verdict);
  }
});

test('reasons take the first that fits; a gap is a runner error', () => {
  const failing = flowInfo('broken', { passed: false, reach: new Map([['src/b.vue', 'module']]) });
  const { entries } = account({
    ...base,
    files: [file('src/b.vue'), file('src/c.vue'), file('src/gone.vue', { status: 'deleted' }), file('lib/x.server.ts'), file('big', { reason: 'not traced (untracked folder of 1,001 files)' }), file('README.md', { class: 'not app code' })],
    flows: [failing],
  });
  const reasons = Object.fromEntries(entries.map((e) => [e.file, e.reason]));
  assert.deepEqual(reasons, {
    'src/b.vue': 'its flows failed their baseline run',
    'src/c.vue': 'no flow reaches it',
    'src/gone.vue': 'deleted',
    'lib/x.server.ts': 'not traced (server-only file)',
    big: 'not traced (untracked folder of 1,001 files)',
  });
  const modulesOff = account({ ...base, modulesOn: false, files: [file('src/d.vue')], flows: [] });
  assert.equal(modulesOff.entries[0].reason, 'not traced (module tracing unavailable)');
  const dup = { ...base, files: [file('src/e.vue'), file('src/e.vue')], flows: [] };
  assert.throws(() => account(dup), AccountingGap);
});

test('Not attacked lines group 3 or more files per folder, cap the summary at 3 and add the scope line', () => {
  const files = ['apps/admin/a.vue', 'apps/admin/b.vue', 'apps/admin/c/d.vue', 'apps/admin/e.vue', 'top.ts', 'apps/web/x.vue'].map((p) => file(p));
  const endpoints = [{ endpoint: 'GET /api/me', file: 'backend/app.py', rule: 'fastapi-dependency', symbol: 'current_user' }];
  const { entries } = account({ ...base, files: [...files, file('backend/app.py', { path: 'backend/app.py' })], endpoints, flows: [] });
  const lines = notAttackedLines(entries);
  assert.ok(lines.some((l) => l.text === 'Not attacked: 4 files under apps/admin/ (no flow reaches it)' && l.members.length === 4));
  assert.ok(lines.some((l) => l.text === 'Not attacked: backend/app.py current_user -> GET /api/me (no flow sends it from the browser)'));
  const summary = summaryNotAttacked(lines, []);
  assert.equal(summary.length, 5);
  assert.match(summary[3], /^\+\d+ more not attacked \(report\.txt\)$/);
  assert.match(summary[4], /^Requests your servers send are never attacked in v1/);
  assert.deepEqual(summaryNotAttacked([], []), []);
  assert.equal(nothingAttackedLine(account({ ...base, files: [file('a.vue'), file('b.vue')], flows: [] }).entries), 'Nothing attacked: no flow reaches the 2 changed files');
});

// A repository holding the sample app's sources, so its backend can change.
function sampleRepo() {
  const root = gitRepo();
  sh(root, 'checkout', '-q', '-b', 'main');
  cpSync(path.join(SAMPLE_DIR, 'backend', 'app.py'), path.join(root, 'backend', 'app.py'));
  mkdirSync(path.join(root, 'frontend'), { recursive: true });
  cpSync(path.join(SAMPLE_DIR, 'frontend', 'app'), path.join(root, 'frontend', 'app'), { recursive: true });
  cpSync(path.join(SAMPLE_DIR, 'frontend', 'nuxt.config.ts'), path.join(root, 'frontend', 'nuxt.config.ts'));
  cpSync(path.join(SAMPLE_DIR, 'frontend', 'package.json'), path.join(root, 'frontend', 'package.json'));
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'sample');
  return root;
}

function edit(root, from, to) {
  const f = path.join(root, 'backend', 'app.py');
  const text = readFileSync(f, 'utf8');
  assert.ok(text.includes(from), from);
  writeFileSync(f, text.replace(from, to));
}

let docs;
let browser;
let session;
before(async () => {
  if (!sampleUp) return;
  docs = await fetchOpenApi([API, SAMPLE], []);
  browser = (await launchBrowser(chooseBrowser(process.env.RP_TEST_BROWSER ?? null, null, installedOnThisMachine()), [])).browser;
  const signIn = await runFlow({
    browser, baseURL: SAMPLE, ready: { kind: 'nuxt' }, hosts: LOOPBACK_ONLY, keepStorageState: true, env: (n) => ({ E: 'demo@example.com', P: 'demo-password' })[n],
    flow: { name: 'sign-in', signedIn: false, steps: [{ goto: '/login' }, { fill: { label: 'Email' }, value: '${env.E}' }, { fill: { label: 'Password' }, value: '${env.P}' }, { click: { role: 'button', name: 'Sign in' } }, { expect: { role: 'heading', name: 'Notes' } }] },
  });
  session = signIn.storageState;
});
after(async () => browser?.close());

test('sample app: the API\'s openapi.json is kept and the web server\'s is not; keys use its templates', needsSample, () => {
  assert.deepEqual(docs.map((d) => d.url), [`${API}/openapi.json`]);
  assert.deepEqual(matchTemplate(docs, `${API}/api/notes?q=gar`, 'GET'), { template: '/api/notes', prefixMatch: false });
  assert.deepEqual(matchTemplate(docs, `${API}/v1/api/notes`, 'POST'), { template: '/api/notes', prefixMatch: true });
  const fns = Object.fromEntries(operations(docs[0]).map((o) => [`${o.method} ${o.template}`, o.functionName]));
  assert.equal(fns['POST /api/notes'], 'create_note');
  const run = { requests: [
    { resourceType: 'fetch', method: 'GET', url: `${API}/api/notes?q=a`, key: 'GET /api/notes #1' },
    { resourceType: 'document', method: 'GET', url: `${SAMPLE}/notes`, key: 'GET /notes' },
    { resourceType: 'fetch', method: 'GET', url: `${SAMPLE}/notes/42.data`, key: 'GET /notes/{}.data #1' },
    { resourceType: 'fetch', method: 'GET', url: `${API}/api/notes?q=ab`, key: 'GET /api/notes #2' },
  ] };
  rekey(run, docs);
  assert.deepEqual(run.requests.map((q) => q.key), ['GET /api/notes #1', 'GET /notes', 'GET /notes/{}.data #1', 'GET /api/notes #2']);
});

test('sample app: function, schema and dependency rules, and the CORS allowlist is app-wide', needsSample, () => {
  const cases = [
    ['created_at = conn.execute', null],
    ['title: str = Field(min_length=1, max_length=200)', 'title: str = Field(min_length=1, max_length=120)'],
    ['token = (authorization or "").removeprefix("Bearer ").strip()', 'token = (authorization or "").removeprefix("Bearer ").strip() or ""'],
    ['allow_origins=["http://localhost:3731", "http://127.0.0.1:3731"],', 'allow_origins=["http://localhost:3731"],'],
  ];
  const results = [];
  for (const [from, to] of cases) {
    const root = sampleRepo();
    const text = readFileSync(path.join(root, 'backend', 'app.py'), 'utf8');
    if (to === null) {
      // A change inside create_note.
      const marker = /def create_note\([^\n]*\n/.exec(text)[0];
      edit(root, marker, `${marker}    # changed\n`);
    } else edit(root, from, to);
    const diff = computeDiff({ root, given: null, env: {}, nuxtRoots: ['frontend/'] });
    results.push(traceBackend({ root, diff, docs, nuxtRoot: 'frontend/', pythonFiles: ['backend/app.py'] }));
  }
  const show = (r) => r.endpoints.map((e) => `${e.endpoint} ${e.rule} ${e.symbol}`);
  assert.deepEqual(show(results[0]), ['POST /api/notes fastapi-function create_note']);
  assert.deepEqual(show(results[1]), ['POST /api/notes fastapi-schema NoteIn']);
  assert.deepEqual(show(results[2]), ['GET /api/me fastapi-dependency current_user', 'GET /api/notes fastapi-dependency current_user', 'POST /api/notes fastapi-dependency current_user']);
  assert.deepEqual([results[3].endpoints, results[3].appWide], [[], ['backend/app.py']]);
});

test('sample app: list_notes selects the search flow and create-note, not a flow that only opens /notes; qualifier and form class', needsSample, async () => {
  const go = (name, steps) => runFlow({ browser, baseURL: SAMPLE, flow: { name, signedIn: true, steps }, env: () => undefined, ready: { kind: 'nuxt' }, hosts: LOOPBACK_ONLY, storageState: session });
  const flows = [
    { name: 'list-notes', steps: [{ goto: '/notes' }, { expect: { role: 'heading', name: 'Notes' } }] },
    { name: 'search-notes', steps: [{ goto: '/notes' }, { fill: { label: 'Search' }, value: 'gro' }, { expect: { role: 'heading', name: 'Notes' } }] },
    { name: 'create-note', steps: [{ goto: '/notes/new' }, { fill: { label: 'Title' }, value: 'Note ${unique}' }, { click: { role: 'button', name: 'Save' } }, { expect: { text: 'Note ${unique}' } }] },
  ];
  const runs = [];
  for (const f of flows) runs.push({ flow: { name: f.name, signedIn: true, steps: f.steps }, passed: true, excluded: false, runs: [await go(f.name, f.steps)] });
  const root = sampleRepo();
  const text = readFileSync(path.join(root, 'backend', 'app.py'), 'utf8');
  const marker = /def list_notes\([^\n]*\n/.exec(text)[0];
  edit(root, marker, `${marker}    # changed\n`);
  const diff = computeDiff({ root, given: null, env: {}, nuxtRoots: ['frontend/'] });
  const sel = await select({ baseURL: SAMPLE, root, nuxtRoot: 'frontend/', noProvenRoot: false, hosts: LOOPBACK_ONLY, diff, flows: runs, signIn: 'passed', attacks: [], attacksBuilt: true, tier: 'quick' });
  assert.deepEqual([...sel.changedEndpoints], ['GET /api/notes']);
  // The search field's GET carries the typed value, so search-notes has a diffLinked form.
  assert.deepEqual(sel.ordered.map((o) => `${o.name}:${o.cls}`), ['search-notes:form', 'create-note:read']);
  const q = sel.accounting.fullLoad.find((x) => x.kind === 'hidden-on-full-load' && x.page === '/notes');
  assert.equal(q.line, 'GET /api/notes: not sent from the browser on the full page load of /notes (list-notes, search-notes); in-app entry sends it (create-note).');

  // A backend-only change to NoteIn's max_length makes create-note's form diffLinked and its class form.
  const root2 = sampleRepo();
  edit(root2, 'title: str = Field(min_length=1, max_length=200)', 'title: str = Field(min_length=1, max_length=100)');
  const diff2 = computeDiff({ root: root2, given: null, env: {}, nuxtRoots: ['frontend/'] });
  const sel2 = await select({ baseURL: SAMPLE, root: root2, nuxtRoot: 'frontend/', noProvenRoot: false, hosts: LOOPBACK_ONLY, diff: diff2, flows: runs, signIn: 'passed', attacks: [], attacksBuilt: true, tier: 'quick' });
  const create = sel2.ordered.find((o) => o.name === 'create-note');
  assert.equal(create.cls, 'form');
  assert.ok(create.forms.some((f) => f.diffLinked && f.carrying === 'POST /api/notes'));
});
