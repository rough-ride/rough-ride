import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { nonFinding, pageTimingPoints, runAttack, symptom } from '../dist/attacks.mjs';
import { chooseBrowser, installedOnThisMachine, launchBrowser } from '../dist/browser.mjs';
import { runFlow } from '../dist/flowrun.mjs';
import { attackKey } from '../dist/record.mjs';
import { startPageSite } from './fixtures/page-site.mjs';

let browser;
let site;
before(async () => {
  browser = (await launchBrowser(chooseBrowser(process.env.RP_TEST_BROWSER ?? null, null, installedOnThisMachine()), [])).browser;
  site = await startPageSite();
});
after(async () => {
  await browser?.close();
  site?.close();
});

const base = (extra = {}) => ({ browser, baseURL: site.url, env: () => undefined, ready: { kind: 'load' }, allowedHosts: [], ...extra });
const newFlow = (mode, signedIn = false) => ({ name: 'create-note', signedIn, steps: [{ goto: `/?mode=${mode}` }, { click: { role: 'link', name: 'New' } }, { expect: { role: 'heading', name: 'New' } }] });
const check = (o, id) => o.checks.find((c) => c.id === id);

async function kindOn(flow, kind, extra = {}) {
  const baseline = await runFlow({ ...base(extra), flow });
  assert.ok(baseline.passed, JSON.stringify(baseline.failure));
  const points = pageTimingPoints(flow, [baseline], new Set(), null, false);
  const point = points.find((p) => p.timing === kind && p.page === '/new');
  assert.ok(point, `${kind}: ${points.map((p) => p.id).join(', ')}`);
  return { o: await runAttack(point, flow, baseline, base(extra), []), points, baseline };
}

test('attack points: full loads get no refresh; signed-in flows get signed-out-reload at every entry; the sign-in flow none', async () => {
  const flow = newFlow('plain', true);
  const baseline = await runFlow({ ...base(), flow });
  assert.deepEqual(baseline.pages.map((p) => [p.path, p.entry, p.previous, p.method]), [['/', 'full-load', null, 'GET'], ['/new', 'in-app', '/', null]]);
  assert.deepEqual(pageTimingPoints(flow, [baseline], new Set(), null, false).map((p) => p.id), [
    'create-note/page / #1/signed-out-reload',
    'create-note/page /new #1/refresh',
    'create-note/page /new #1/signed-out-reload',
    'create-note/page /new #1/back',
  ]);
  assert.equal(pageTimingPoints(flow, [baseline], new Set(), null, true).length, 0);
});

test('refresh and back on a well-behaved page pass; ids, keys and repro keys', async () => {
  const refresh = await kindOn(newFlow('plain'), 'refresh');
  assert.equal(refresh.o.verdict, 'passed', JSON.stringify(refresh.o.checks));
  assert.deepEqual(refresh.o.events.map((e) => e.event), ['reloaded 200']);
  assert.deepEqual(attackKey(refresh.o), { timing: 'refresh', page: '/new', entry: 1 });
  const back = await kindOn(newFlow('plain'), 'back');
  assert.equal(back.o.verdict, 'passed', JSON.stringify(back.o.checks));
  assert.deepEqual(back.o.events.map((e) => e.event), ['went back /', 'went forward /new']);
});

test('a reload that loses in-memory state shows undefined and fails no-broken-text', async () => {
  const { o } = await kindOn(newFlow('stateful'), 'refresh');
  assert.equal(check(o, 'no-broken-text').result, 'fail');
  assert.equal(symptom(o), '"undefined" shown on /new after a reload of /new');
});

test('a document 500 and a redirect loop after the reload fail no-uncaught-error', async () => {
  assert.match(check((await kindOn(newFlow('crash500'), 'refresh')).o, 'no-uncaught-error').evidence, /document answered 500/);
  assert.match(check((await kindOn(newFlow('loop'), 'refresh')).o, 'no-uncaught-error').evidence, /ERR_TOO_MANY_REDIRECTS/);
});

test('beforeunload is accepted; a replaceState entry reads Not applied for back', async () => {
  const { o } = await kindOn(newFlow('beforeunload'), 'refresh');
  assert.ok(o.events.some((e) => e.event === 'beforeunload accepted'), JSON.stringify(o.events));
  const flow = newFlow('replace');
  const baseline = await runFlow({ ...base(), flow });
  const point = { ...pageTimingPoints(newFlow('plain'), [await runFlow({ ...base(), flow: newFlow('plain') })], new Set(), null, false).find((p) => p.timing === 'back') };
  const r = await runAttack({ ...point, flow: flow.name }, flow, baseline, base(), []);
  assert.match(nonFinding(r, 12_000).text, /^Not applied: create-note\/page \/new #1\/back \(the back step went to .*, not \/\)$/);
});

test('a page that is not ready 30 s after the reload fails settles', async () => {
  const flow = newFlow('plain');
  const { o } = await kindOn(flow, 'refresh', { ready: { kind: 'expression', expression: 'window.readyFlag && !performance.getEntriesByType("navigation")[0]?.type?.startsWith("reload")' }, timeouts: { C: 2000 } });
  assert.match(check(o, 'settles').evidence, /not ready 2 s after the reload/);
});

test('a page from a form post: planning skips it, and a reload there never resends the POST', async () => {
  const flow = { name: 'post', signedIn: true, steps: [{ goto: '/form' }, { click: { role: 'button', name: 'Send' } }, { expect: { role: 'heading', name: 'Posted' } }] };
  const baseline = await runFlow({ ...base(), flow });
  const p = pageTimingPoints(flow, [baseline], new Set(), null, false);
  assert.ok(p.skipped.includes('Skipped: signed-out-reload on page /posted #1 (the page came from a form post)'), JSON.stringify(p.skipped));
  const before = site.posts.count;
  const run = await runFlow({ ...base(), flow, pageTiming: { kind: 'refresh', step: 2, previous: '/form' } });
  assert.equal(run.pageTiming.notApplied, 'the reload would resend a form post');
  assert.deepEqual(run.pageTiming.events.map((e) => e.event), ['form post blocked']);
  assert.equal(site.posts.count - before, 1, 'only the flow\'s own POST');
});

test('signed-out-reload deletes own-origin cookies and answers a credentialed fetch with the fixed 401', async () => {
  const storageState = { cookies: [{ name: 'sid', value: 'sid-0123456789abcdef', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [{ origin: site.url, localStorage: [{ name: 'tok', value: 'tok-0123456789abcdef' }] }] };
  const credentials = ['sid-0123456789abcdef', 'tok-0123456789abcdef'];

  const meFlow = { name: 'me', signedIn: true, steps: [{ goto: '/me' }, { expect: { text: 'Signed in as Ada' } }] };
  const baseline = await runFlow({ ...base({ storageState, credentials }), flow: meFlow });
  assert.ok(baseline.passed, JSON.stringify(baseline.failure));
  const point = pageTimingPoints(meFlow, [baseline], new Set(), null, false).find((x) => x.timing === 'signed-out-reload');
  const o = await runAttack(point, meFlow, baseline, base({ storageState, credentials }), []);
  assert.deepEqual(o.events.map((e) => e.event), ['cookies deleted 1', 'reloaded 200', 'served 401']);
  assert.equal(o.run.pageTiming.removed, 1);
  assert.equal(o.verdict, 'passed', JSON.stringify(o.checks));
});
