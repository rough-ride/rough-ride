import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { doubleSubmitPoints, findingLines, nonFinding, runAttack, severityOf, symptom, timingDedupeKey } from '../dist/attacks.mjs';
import { chooseBrowser, installedOnThisMachine, launchBrowser } from '../dist/browser.mjs';
import { sameShapeExceptBooleans } from '../dist/checks.mjs';
import { runFlow } from '../dist/flowrun.mjs';
import { startTimingSite } from './fixtures/timing-site.mjs';
import { LOOPBACK_ONLY } from '../dist/hosts.mjs';

let browser;
let site;
before(async () => {
  browser = (await launchBrowser(chooseBrowser(process.env.RP_TEST_BROWSER ?? null, null, installedOnThisMachine()), [])).browser;
  site = await startTimingSite();
});
after(async () => {
  await browser?.close();
  site?.close();
});

const own = LOOPBACK_ONLY.ownHost;
const base = () => ({ browser, baseURL: site.url, env: () => undefined, ready: { kind: 'load' }, hosts: LOOPBACK_ONLY });
const SAVE = { click: { role: 'button', name: 'Save' } };
const flowOf = (path, step = SAVE, rest = []) => ({ name: 'create-note', signedIn: false, steps: [{ goto: path }, step, ...rest] });
const oneWrite = (o) => o.checks.find((c) => c.id === 'one-write');

async function doubleOn(path, step = SAVE, rest = []) {
  const flow = flowOf(path, step, rest);
  const baseline = await runFlow({ ...base(), flow });
  assert.ok(baseline.passed, JSON.stringify(baseline.failure));
  const points = doubleSubmitPoints(flow, baseline, own, new Set(), null, false);
  return { points, baseline, flow, run: async () => runAttack(points[0], flow, baseline, base(), []) };
}

test('attack points: a click that sent a POST answered 2xx; the key is the first POST, after a PUT', async () => {
  const { points } = await doubleOn('/putpost');
  assert.deepEqual(points.map((p) => [p.id, p.page, p.writeKeys.join(',')]), [['create-note/POST /api/notes #1/double-submit', '/putpost', 'PUT /api/prefs,POST /api/notes']]);
  assert.equal(timingDedupeKey(points[0]), 'double-submit|/putpost|POST /api/notes');
});

test('skipped steps: toggle control, PATCH only, document form post, sign-in flow; check steps and non-writing clicks print nothing', async () => {
  assert.deepEqual((await doubleOn('/toggle-aria')).points.skipped, ['Skipped: double-submit on button "Save" (toggle control)']);
  assert.deepEqual((await doubleOn('/patch')).points.skipped, ['Skipped: double-submit on button "Save" (sends PATCH, not POST)']);
  const doc = await doubleOn('/docpost', { click: { role: 'button', name: 'Send' } }, [{ expect: { text: 'Submitted' } }]);
  assert.deepEqual(doc.points.skipped, ['Skipped: double-submit on button "Send" (document form post)']);
  const { flow, baseline } = await doubleOn('/noguard');
  assert.deepEqual(doubleSubmitPoints(flow, baseline, own, new Set(), null, true).skipped, ['Skipped: double-submit on button "Save" (sign-in flow)']);
});

test('one-write: an unguarded create fails at HIGH with the toggle hint; a guarded one passes', async () => {
  const bad = await (await doubleOn('/noguard')).run();
  assert.equal(bad.verdict, 'failed');
  assert.equal(oneWrite(bad).evidence, 'one-write: 2 successful POST /api/notes (the baseline run sent 1) (if this control is a toggle, give it aria-pressed)');
  assert.equal(severityOf(bad), 'high');
  assert.equal(symptom(bad), 'button "Save" sends 2 successful POST /api/notes on a double click (if this control is a toggle, give it aria-pressed)');
  assert.equal(findingLines(bad)[1], '      /noguard | double-submit on POST /api/notes #1 | fails: one-write');
  assert.equal(bad.events[0].event, 'double-clicked');
  assert.match(bad.events[0].detail, /^POST \/api\/notes 201 [0-9a-f]{64}; POST \/api\/notes 201 [0-9a-f]{64}$/);
  assert.equal(oneWrite(await (await doubleOn('/guard')).run()).result, 'pass');
});

test('a doubled press sends the key twice with no wait between', async () => {
  const bad = await (await doubleOn('/press', { press: { label: 'Title' }, key: 'Enter' })).run();
  assert.equal(bad.events[0].event, 'pressed twice');
  assert.equal(oneWrite(bad).result, 'fail');
  assert.match(symptom(bad), /on a double press/);
});

test('one-write passes: equal answers, a guarded create plus doubled equal analytics, a key the baseline never sent, a 500 duplicate', async () => {
  for (const path of ['/equal', '/analytics', '/fav', '/dup500']) {
    const o = await (await doubleOn(path)).run();
    assert.equal(oneWrite(o).result, 'pass', path);
  }
});

test('toggles without ARIA state: answers differing only in a boolean pass; a changing counter fails', async () => {
  assert.equal(oneWrite(await (await doubleOn('/toggle')).run()).result, 'pass');
  const counted = await (await doubleOn('/toggle-count')).run();
  assert.equal(oneWrite(counted).result, 'fail');
  assert.ok(oneWrite(counted).evidence.endsWith('(if this control is a toggle, give it aria-pressed)'));
  assert.equal(sameShapeExceptBooleans({ id: 1, starred: true }, { id: 1, starred: false }), true);
  assert.equal(sameShapeExceptBooleans({ id: 1, n: 1 }, { id: 1, n: 2 }), false);
});

test('a later step failing after the window stops the flow and is never a finding by itself', async () => {
  // The duplicate's 500 arrives last, so the page shows "Done 500" and the expect on "Done 200" fails.
  const o = await (await doubleOn('/dup500', SAVE, [{ expect: { text: 'Done 200' } }])).run();
  assert.equal(o.run.stoppedAt, 3);
  assert.equal(o.verdict, 'passed');
  assert.equal(nonFinding(o, 12_000).text, 'Faulted; flow stopped at step 3: create-note/POST /api/once #1/double-submit');
});
