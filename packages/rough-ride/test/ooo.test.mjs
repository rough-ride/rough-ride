import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { nonFinding, outOfOrderPoints, ownHostFor, runAttack, symptom } from '../dist/attacks.mjs';
import { chooseBrowser, installedOnThisMachine, launchBrowser } from '../dist/browser.mjs';
import { findForms } from '../dist/forms.mjs';
import { runFlow } from '../dist/flowrun.mjs';
import { groupFindings, memberOf } from '../dist/groups.mjs';
import { startOooSite } from './fixtures/ooo-site.mjs';

let browser;
let site;
before(async () => {
  browser = (await launchBrowser(chooseBrowser(process.env.RP_TEST_BROWSER ?? null, null, installedOnThisMachine()), [])).browser;
  site = await startOooSite();
});
after(async () => {
  await browser?.close();
  site?.close();
});

const own = ownHostFor([]);
const base = () => ({ browser, baseURL: site.url, env: () => undefined, ready: { kind: 'load' }, allowedHosts: [] });
const searchFlow = (mode, extra = [{ expect: { text: 'Garden plan' } }]) => ({ name: 'search', signedIn: false, steps: [{ goto: `/search?mode=${mode}` }, { fill: { label: 'Find' }, value: 'Garden' }, ...extra] });
const latest = (o) => o.checks.find((c) => c.id === 'latest-response-wins');

async function oooOn(flow) {
  const baseline = await runFlow({ ...base(), flow });
  assert.ok(baseline.passed, JSON.stringify(baseline.failure));
  const points = outOfOrderPoints(flow, baseline, findForms(flow, baseline, own, new Set()), own, new Set(), null, false);
  assert.equal(points.length, 1, JSON.stringify(baseline.requests.map((q) => [q.step, q.key, q.offsetMs])));
  return { point: points[0], o: await runAttack(points[0], flow, baseline, base(), []), baseline };
}

test('attack point, id, record key and offsets; the sign-in flow never gets one', async () => {
  const { point, baseline } = await oooOn(searchFlow('guard'));
  assert.equal(point.id, 'search/label "Find"/out-of-order');
  assert.equal(point.outOfOrder.fieldKey, 'q');
  assert.ok(baseline.requests.some((q) => q.key.startsWith('GET /api/search') && q.offsetMs >= 100), 'offsets from the step start');
  assert.deepEqual(outOfOrderPoints(searchFlow('guard'), baseline, findForms(searchFlow('guard'), baseline, own, new Set()), own, new Set(), null, true), []);
});

test('a guarded search keeps the newer results: held, newer delivered, released in order, the older request reaching the server last', async () => {
  const { o } = await oooOn(searchFlow('guard'));
  assert.deepEqual(o.events.map((e) => e.event.replace(/\d+ ms/, 'N ms')), ['held', 'newer delivered', 'released after N ms']);
  assert.equal(latest(o).result, 'pass');
  assert.equal(o.verdict, 'passed');
  const recent = site.log.slice(-2);
  assert.ok(recent[1].q !== 'Garden' && recent[0].q === 'Garden', `the older request reached the server last: ${JSON.stringify(recent)}`);
});

test('(b): a stale search that drops the newer results fails HIGH with the disappeared line', async () => {
  const { o } = await oooOn(searchFlow('stale'));
  assert.equal(latest(o).evidence, 'latest-response-wins: "Garden plan" from the newer answer disappeared when the older one arrived');
  const group = groupFindings([memberOf(o, searchFlow('stale'), new Map())], { flowClass: () => 'read' })[0];
  assert.equal(group.severity, 'high');
  assert.equal(group.key.action, 'field /search GET /api/search q');
  assert.equal(symptom(o), 'Stale answer shown as current when an older answer arrived after a newer one on label "Find"');
});

test('(a): an older answer "Zebra stripes" shown after the release fails with the appeared line', async () => {
  const { o } = await oooOn(searchFlow('zebra', []));
  assert.equal(latest(o).evidence, 'latest-response-wins: "Zebra stripes" from the older answer appeared after the newer one');
});

test('a page that aborts the stale request passes, records the abort, and its AbortError never counts', async () => {
  const { o } = await oooOn(searchFlow('abort'));
  assert.ok(o.events.some((e) => e.event === 'older aborted by the page'), JSON.stringify(o.events));
  assert.ok(!o.events.some((e) => e.event.startsWith('released')));
  assert.equal(o.verdict, 'passed', JSON.stringify(o.checks));
});

test('equal answers read Not applied; an HTML partial skips (a) and (b) and a later failing expect fails (c)', async () => {
  const same = (await oooOn(searchFlow('same'))).o;
  assert.equal(nonFinding(same, 12_000).text, 'Not applied: search/label "Find"/out-of-order (both answers were the same)');
  const html = (await oooOn(searchFlow('html', [{ expect: { text: 'Garden plan' } }]))).o;
  // The HTML page shows whichever answer came last, so its final expect fails: (c).
  assert.match(latest(html).evidence, /^latest-response-wins: step 3 failed after the older answer arrived: expect text "Garden plan": /);
});

test('a select-driven out-of-order attack runs', async () => {
  const flow = { name: 'filter', signedIn: false, steps: [{ goto: '/search?mode=stale' }, { select: { label: 'Category' }, value: 'Garden' }, { expect: { text: 'Garden plan' } }] };
  const { o, point } = await oooOn(flow);
  assert.equal(point.outOfOrder.older, 'kitchen');
  assert.equal(o.notApplied, null);
  assert.equal(latest(o).result, 'fail', JSON.stringify(o.checks));
});
