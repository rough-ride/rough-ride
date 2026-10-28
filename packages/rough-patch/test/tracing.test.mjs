import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chooseBrowser, installedOnThisMachine, launchBrowser } from '../dist/browser.mjs';
import { pagePath, requestTemplate, runFlow } from '../dist/flowrun.mjs';
import { moduleFiles, routeMatches, traceReach } from '../dist/tracing.mjs';

const SAMPLE_DIR = fileURLToPath(new URL('../../../.scratch/chaos-v1/prototypes/sample-app/', import.meta.url));
const SAMPLE = 'http://localhost:3731';
const sampleUp = await fetch(`${SAMPLE}/login`).then((r) => r.ok).catch(() => false);
const needsSample = { skip: !sampleUp && 'the sample app is not running (BUGS=none npm run dev in .scratch/chaos-v1/prototypes/sample-app)' };

// The sample app's own files, as git would list them.
function sampleFiles() {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(path.join(SAMPLE_DIR, rel), { withFileTypes: true })) {
      if (['node_modules', '.nuxt', '.output', '.venv', '__pycache__', 'test-results', '.rough-patch'].includes(e.name)) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else out.push(child);
    }
  };
  walk('');
  return out;
}

test('page keys use the {} rules and the hash route', () => {
  assert.equal(pagePath('http://x/notes/42?tab=1'), '/notes/{}');
  assert.equal(pagePath('http://x/#/notes/42'), '/#/notes/{}');
  assert.equal(pagePath('http://x/notes#section'), '/notes');
  assert.equal(pagePath('http://x/files/0b5e9d2a-6f1c-4a77-9b1e-2f3c4d5e6f70.png'), '/files/{}.png');
});

test('request keys template ids, uuids, long hex, the run\'s token and returned values', () => {
  const returned = new Set(['note-abc123']);
  assert.equal(requestTemplate('GET', 'http://x/api/notes/42?q=1', 'zz12ab34', returned), 'GET /api/notes/{}');
  assert.equal(requestTemplate('PUT', 'http://x/api/notes/note-abc123', 'zz12ab34', returned), 'PUT /api/notes/{}');
  assert.equal(requestTemplate('GET', 'http://x/api/notes/by-title/hello-zz12ab34', 'zz12ab34', returned), 'GET /api/notes/by-title/{}');
  assert.equal(requestTemplate('GET', 'http://x/api/blobs/0123456789abcdef0123', '', returned), 'GET /api/blobs/{}');
  assert.equal(requestTemplate('GET', 'http://x/api/tasks/open', '', new Set()), 'GET /api/tasks/open');
});

test('module rule: /_nuxt/ URLs map to repository files; Vite internals and node_modules map to nothing; ties are ambiguous', () => {
  const files = ['frontend/app/pages/login.vue', 'frontend/app/pages/notes/index.vue', 'frontend/app/components/Note.vue', 'admin/app/components/Note.vue'];
  const root = '/repo';
  assert.deepEqual(moduleFiles('http://localhost:3731/_nuxt/pages/login.vue?v=1a2b', files, root, 'frontend/').files, ['frontend/app/pages/login.vue']);
  assert.deepEqual(moduleFiles('http://localhost:3731/_nuxt/@vite/client', files, root, 'frontend/').files, []);
  assert.deepEqual(moduleFiles('http://localhost:3731/_nuxt/@id/virtual:nuxt:routes', files, root, 'frontend/').files, []);
  assert.deepEqual(moduleFiles('http://localhost:3731/_nuxt/node_modules/vue/index.js', files, root, 'frontend/').files, []);
  assert.deepEqual(moduleFiles('http://localhost:3731/_nuxt/@fs/repo/frontend/app/pages/login.vue', files, root, 'frontend/').files, ['frontend/app/pages/login.vue']);
  const tie = moduleFiles('http://localhost:5173/components/Note.vue', files, root, null);
  assert.deepEqual([tie.files.length, tie.ambiguous], [2, true]);
});

test('Nuxt route paths match page keys', () => {
  assert.ok(routeMatches('/notes', '/notes'));
  assert.ok(routeMatches('/plants/:id()', '/plants/{}'));
  assert.ok(!routeMatches('/notes', '/notes/new'));
  assert.ok(routeMatches('/:slug(.*)*', '/anything/here'));
});

let browser;
let session;
before(async () => {
  if (!sampleUp) return;
  browser = (await launchBrowser(chooseBrowser(process.env.RP_TEST_BROWSER ?? null, null, installedOnThisMachine()), [])).browser;
  const signIn = await runFlow({
    browser, baseURL: SAMPLE, ready: { kind: 'nuxt' }, keepStorageState: true,
    env: (n) => ({ E: 'demo@example.com', P: 'demo-password' })[n],
    flow: { name: 'sign-in', signedIn: false, steps: [{ goto: '/login' }, { fill: { label: 'Email' }, value: '${env.E}' }, { fill: { label: 'Password' }, value: '${env.P}' }, { click: { role: 'button', name: 'Sign in' } }, { expect: { role: 'heading', name: 'Notes' } }] },
  });
  session = signIn.storageState;
});
after(async () => browser?.close());

const flow = (name, steps, signedIn = true) => ({ name, signedIn, steps });
const go = (f, storageState = session) => runFlow({ browser, baseURL: SAMPLE, flow: f, env: () => undefined, ready: { kind: 'nuxt' }, storageState: f.signedIn ? storageState : undefined });

test('sample app: page entries, full load against in-app, with entry requests', needsSample, async () => {
  const create = await go(flow('create-note', [{ goto: '/notes/new' }, { fill: { label: 'Title' }, value: 'Note ${unique}' }, { click: { role: 'button', name: 'Save' } }, { expect: { text: 'Note ${unique}' } }]));
  assert.deepEqual(create.pages.map((p) => [p.path, p.step, p.entry, p.requests, p.method]), [
    ['/notes/new', 1, 'full-load', [], 'GET'],
    ['/notes', 3, 'in-app', ['GET /api/notes'], null],
  ]);
  const browse = await go(flow('browse', [{ goto: '/notes' }, { click: { role: 'link', name: 'New note' } }, { click: { role: 'link', name: 'Back to notes' } }, { expect: { role: 'heading', name: 'Notes' } }]));
  assert.deepEqual(browse.pages.map((p) => [p.path, p.entry, p.requests, p.previous]), [
    ['/notes', 'full-load', [], null],
    ['/notes/new', 'in-app', [], '/notes'],
    ['/notes', 'in-app', ['GET /api/notes'], '/notes/new'],
  ]);
  const signedOut = await go(flow('signed-out', [{ goto: '/notes' }, { expect: { role: 'heading', name: 'Sign in' } }], false));
  assert.deepEqual(signedOut.pages.map((p) => [p.path, p.entry]), [['/login', 'full-load']]);
  const button = browse.steps.find((s) => s.index === 2).control;
  assert.equal(button.tag, 'a');
});

test('sample app: module rule, Nuxt exclusion and page rule', needsSample, async () => {
  const onlyNotes = await go(flow('list-notes', [{ goto: '/notes' }, { expect: { role: 'heading', name: 'Notes' } }]));
  const clicksNew = await go(flow('open-new', [{ goto: '/notes' }, { click: { role: 'link', name: 'New note' } }, { expect: { role: 'heading', name: 'New note' } }]));
  const login = await go(flow('login-page', [{ goto: '/login' }, { expect: { role: 'heading', name: 'Sign in' } }], false));
  const diff = ['frontend/app/pages/notes/new.vue', 'frontend/app/components/LoadErrorPanel.vue', 'frontend/app/pages/login.vue'].map((p) => ({ path: p, status: 'modified', class: 'app' }));
  const tracing = await traceReach({
    baseURL: SAMPLE, root: SAMPLE_DIR, nuxtRoot: 'frontend/', noProvenRoot: false, diff, files: sampleFiles(),
    flows: [{ name: 'list-notes', passed: true, runs: [onlyNotes] }, { name: 'open-new', passed: true, runs: [clicksNew] }, { name: 'login-page', passed: true, runs: [login] }],
  });
  assert.equal(tracing.modules, true);
  assert.equal(tracing.pages, true);
  const reach = Object.fromEntries(tracing.reach.map((r) => [r.flow, r.via]));
  assert.equal(reach['login-page'].get('frontend/app/pages/login.vue'), 'module');
  // goto /notes alone fetches new.vue for the visible link, but never visits it.
  assert.equal(reach['list-notes'].has('frontend/app/pages/notes/new.vue'), false);
  assert.ok(reach['open-new'].has('frontend/app/pages/notes/new.vue'));
  // LoadErrorPanel loads only on the error path; the page rule still selects /notes flows.
  assert.equal(reach['list-notes'].get('frontend/app/components/LoadErrorPanel.vue'), 'page');
  assert.equal(reach['login-page'].has('frontend/app/components/LoadErrorPanel.vue'), false);
});

test('app-wide changes put every flow in scope and print the note; no Vite means module tracing is unavailable', async () => {
  const run = (urls) => ({ requests: urls.map((url) => ({ url, resourceType: 'script' })), steps: [], pages: [] });
  const diff = [{ path: 'package-lock.json', status: 'modified', class: 'dependency' }, { path: 'src/main.js', status: 'modified', class: 'app' }];
  const tracing = await traceReach({
    baseURL: 'http://127.0.0.1:1', root: '/repo', nuxtRoot: null, noProvenRoot: true, diff, files: ['src/main.js'],
    flows: [{ name: 'a', passed: true, runs: [run(['http://127.0.0.1:1/static/chunk.js'])] }, { name: 'b', passed: true, runs: [run([])] }],
  });
  assert.equal(tracing.modules, false);
  assert.deepEqual(tracing.appWide, ['package-lock.json']);
  assert.deepEqual(tracing.notes.map((n) => n.text), [
    'Module tracing: unavailable (no Vite dev server seen)',
    'Page tracing: unavailable (no proven Nuxt root for target.url)',
    'App-wide change (package-lock.json): 2 saved flows in scope at the lowest priority',
  ]);
});
