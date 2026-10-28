import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapshotText, trimTree } from '../dist/snapshot.mjs';
import { linkProblem, shapeProblem } from '../dist/link.mjs';
import { keepProblem } from '../dist/flowsave.mjs';

test('snapshots: at most 2,000 nodes, strings cut at 500 with the remainder counted, ${unique} as the literal, ASCII only', () => {
  const big = { role: 'main', children: Array.from({ length: 3000 }, (_, i) => ({ role: 'listitem', name: `item ${i}` })) };
  const { nodes } = trimTree(big, 'tok12345');
  assert.equal(nodes, 2000);
  const long = trimTree({ name: 'x'.repeat(600) }, '').tree;
  assert.equal(long.name, `${'x'.repeat(500)}...(+100 chars)`);
  assert.equal(trimTree({ name: 'Note tok12345 saved' }, 'tok12345').tree.name, 'Note ${unique} saved');
  const snap = snapshotText('/notes', 'Notes — app', { role: 'heading', name: 'café ‮' }, '');
  assert.ok(!/[^\x00-\x7e]/.test(snap.text), snap.text);
  assert.deepEqual(JSON.parse(snap.text).tree, { role: 'heading', name: 'café ‮' });
});

const plan = {
  routes: ['/notes', '/notes/new', '/notes/:id()'],
  apiKeys: ['GET /api/notes', 'POST /api/notes'],
  flowPages: [
    { name: 'create-note', passed: true, pages: [{ path: '/notes', entry: 'full-load' }, { path: '/notes/new', entry: 'in-app' }], requests: ['POST /api/notes'] },
    { name: 'broken', passed: false, pages: [], requests: [] },
  ],
};
const data = { changed: [{ path: 'frontend/app/pages/notes/new.vue', class: 'app' }, { path: 'README.md', class: 'docs' }], plan, exclude: ['/admin/**'] };
const link = (over) => ({ file: 'frontend/app/pages/notes/new.vue', because: 'b', ...over });

test('link shape: one target, a short ASCII because, entry only with a page', () => {
  assert.equal(shapeProblem(link({ page: '/x' })), null);
  assert.equal(shapeProblem(link({ page: '/x', flow: 'f' })), 'a link names exactly one of endpoint, flow or page');
  assert.equal(shapeProblem(link({ flow: 'f', entry: 'in-app' })), 'entry: in-app goes only with a page');
  assert.equal(shapeProblem(link({ page: '/x', because: 'x'.repeat(161) })), 'because is one ASCII line of 1 to 160 characters');
  assert.equal(shapeProblem(link({ page: '/x', extra: 1 })), 'unknown field extra');
});

test('link rules: changed app file, known endpoint, passing flow, a routed page not excluded, and the in-app rejection', () => {
  assert.equal(linkProblem(link({ file: 'README.md', page: '/notes' }), data), 'not a changed app, config or dependency file');
  assert.equal(linkProblem(link({ endpoint: 'POST /api/notes' }), data), null);
  assert.equal(linkProblem(link({ endpoint: 'DELETE /api/notes/{id}' }), data), 'in no OpenAPI document and no recorded request');
  assert.equal(linkProblem(link({ flow: 'broken' }), data), 'broken failed its baseline run');
  assert.equal(linkProblem(link({ flow: 'nope' }), data), 'no saved flow named nope');
  assert.equal(linkProblem(link({ page: '/admin/x' }), data), 'under exclude in config.yaml');
  assert.equal(linkProblem(link({ page: '/tags' }), data), 'no Nuxt route matches it');
  assert.equal(linkProblem(link({ page: 'https://e.com/x' }), data), 'a page is a path on the target, such as /notes');
  assert.equal(linkProblem(link({ page: '/notes/new', entry: 'in-app' }), data), 'create-note already enters it in-app');
  assert.equal(linkProblem(link({ page: '/notes', entry: 'in-app' }), data), null);
});

test('keep rule: visiting the page reaches it; an in-app item needs every run to enter in-app', () => {
  const run = (entry) => ({ pages: [{ path: '/notes/new', entry }], requests: [] });
  const item = { page: '/notes/new', file: 'frontend/app/pages/notes/new.vue', entry: null };
  assert.equal(keepProblem(item, [run('full-load')], '/nonexistent', null), null);
  assert.equal(keepProblem({ ...item, page: '/tags' }, [run('full-load')], '/nonexistent', null), 'new flow does not reach frontend/app/pages/notes/new.vue');
  assert.equal(keepProblem({ ...item, entry: 'in-app' }, [run('in-app'), run('full-load')], '/nonexistent', null), 'enters /notes/new by full page load only');
  assert.equal(keepProblem({ ...item, entry: 'in-app' }, [run('in-app'), run('in-app')], '/nonexistent', null), null);
});

test('routes: a path resolves to the route Nuxt would pick, so two paths of one dynamic route are the same page', async () => {
  const { resolveRoute, samePage } = await import('../dist/tracing.mjs');
  const routes = ['/notes', '/notes/new', '/notes/:id()', '/:slug(.*)*'];
  assert.equal(resolveRoute(routes, '/notes/new'), '/notes/new');
  assert.equal(resolveRoute(routes, '/notes/57'), '/notes/:id()');
  assert.equal(resolveRoute(routes, '/x/y'), '/:slug(.*)*');
  assert.equal(samePage(routes, '/notes/57', '/notes/12'), true);
  assert.equal(samePage(routes, '/notes/new', '/notes/57'), false);
  assert.equal(samePage(null, '/a', '/a'), true);
});

test('links.json read back: an edited, corrupt or deleted copy is refused with exit 75; a run with no links reads empty', async () => {
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const path = (await import('node:path')).default;
  const { readLinks } = await import('../dist/link.mjs');
  const { Manifest } = await import('../dist/manifest.mjs');
  const { StopError } = await import('../dist/exit.mjs');
  const { checkRootEntry, ensureFolder } = await import('../dist/folder.mjs');
  const { gitRepo, sh } = await import('./helpers.mjs');
  const root = gitRepo();
  writeFileSync(path.join(root, 'README.md'), 'x\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'base');
  const folder = ensureFolder(checkRootEntry(root));
  const id = '20261028-101010-plan-ab12';
  const dir = path.join(folder.dir, 'runs', id, 'adversary');
  mkdirSync(dir, { recursive: true });
  const manifest = new Manifest(root);
  assert.deepEqual(readLinks(folder, id, manifest, 'x'), { links: [] });
  const value = { links: [{ input: { file: 'a.vue', page: '/a', because: 'b' }, accepted: true, id: 'l1', why: null }] };
  writeFileSync(path.join(dir, 'links.json'), JSON.stringify(value));
  manifest.recordRun(id, 'adversary/links.json', value);
  assert.deepEqual(readLinks(folder, id, manifest, 'x'), value);
  const refused = (text) => {
    if (text === null) rmSync(path.join(dir, 'links.json'));
    else writeFileSync(path.join(dir, 'links.json'), text);
    try {
      readLinks(folder, id, manifest, '/rough-patch:quick');
      return null;
    } catch (e) {
      return e instanceof StopError ? e.stop.code : e;
    }
  };
  assert.equal(refused(JSON.stringify({ links: [...value.links, { input: { file: 'x', page: '/admin' }, accepted: true, id: 'l9', why: null }] })), 'refused-run-output');
  assert.equal(refused('{not json'), 'refused-run-output');
  assert.equal(refused(null), 'refused-run-output');
});
