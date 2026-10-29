import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { attackPoints, orderAttacks, ownHostFor, runAttack, symptom } from '../dist/attacks.mjs';
import { chooseBrowser, installedOnThisMachine, launchBrowser } from '../dist/browser.mjs';
import { baselineFailures, brokenTextIn } from '../dist/checks.mjs';
import { runFlow } from '../dist/flowrun.mjs';
import { startAttackSite } from './fixtures/attack-site.mjs';

let browser;
let site;
before(async () => {
  browser = (await launchBrowser(chooseBrowser(process.env.RP_TEST_BROWSER ?? null, null, installedOnThisMachine()), [])).browser;
  site = await startAttackSite();
});
after(async () => {
  await browser?.close();
  site?.close();
});

const flowFor = (path, steps) => ({ name: 'f', signedIn: false, steps: [{ goto: path }, ...steps] });
const SAVE = [{ click: { role: 'button', name: 'Save' } }];
const base = () => ({ browser, baseURL: site.url, env: () => undefined, ready: { kind: 'load' }, allowedHosts: [] });
const own = ownHostFor([]);

async function attackOn(path, fault = '500', steps = SAVE, key = 'POST /api/save') {
  const flow = flowFor(path, steps);
  const baseline = await runFlow({ ...base(), flow });
  const points = attackPoints(flow, baseline, own, new Set(), null).filter((a) => a.fault === fault && a.template === key);
  assert.ok(points.length > 0, `no attack point ${key} on ${path}: ${baseline.requests.map((r) => r.key).join(', ')}`);
  return { outcome: await runAttack(points[0], flow, baseline, base(), []), baseline };
}

const result = (o, id) => o.checks.find((c) => c.id === id)?.result;

test('attack points: own-origin fetch and XHR only; reset only on writes; ids carry the key and !', async () => {
  const flow = flowFor('/twice', [{ click: { role: 'button', name: 'Load' } }, { expect: { text: 'loaded' } }]);
  const baseline = await runFlow({ ...base(), flow });
  const points = attackPoints(flow, baseline, own, new Set(['GET /api/item']), null);
  // The poll at page load belongs to the goto step and is an attack point too.
  assert.deepEqual(points.map((p) => `${p.id} step=${p.step} k=${p.k} closeness=${p.closeness}`), [
    'f/GET /api/item #1/500! step=1 k=1 closeness=1',
    'f/GET /api/item #2/500! step=2 k=1 closeness=1',
    'f/GET /api/item #3/500! step=2 k=2 closeness=1',
  ]);
  assert.ok(!points.some((p) => /document|\/_nuxt\/|@vite/.test(p.key)));
  const save = attackPoints(flowFor('/save', SAVE), await runFlow({ ...base(), flow: flowFor('/save', SAVE) }), own, new Set(), null);
  assert.deepEqual(orderAttacks(save).map((p) => p.id), ['f/POST /api/save #1/500!', 'f/POST /api/save #1/reset!']);
});

test('500 and reset send exactly their bytes, same-origin and cross-origin, and the server sees nothing', async () => {
  const flow = flowFor('/bytes', [{ click: { role: 'button', name: 'Send' } }]);
  const baseline = await runFlow({ ...base(), flow });
  for (const [fault, template] of [['500', 'POST /api/save'], ['500', 'POST /api/cross']]) {
    const point = attackPoints(flow, baseline, own, new Set(), null).find((a) => a.fault === fault && a.template === template);
    const before = { ...site.hits };
    const o = await runAttack(point, flow, baseline, base(), []);
    const text = o.run.steps.find((s) => s.index === o.step).observation.after.lines.join(' ');
    if (template === 'POST /api/save') {
      assert.match(text, /500\|text\/plain; charset=utf-8\|Internal Server Error \|\| 200/);
      assert.equal(site.hits.save, before.save + 1, 'only the recovery click reached the server');
    } else {
      assert.match(text, /\|\| 500\|text\/plain; charset=utf-8\|Internal Server Error$/);
      assert.equal(site.hits.cross, before.cross + 1, 'only the recovery click reached the server');
    }
  }
  const reset = attackPoints(flow, baseline, own, new Set(), null).find((a) => a.fault === 'reset' && a.template === 'POST /api/save');
  const before = site.hits.save;
  const o = await runAttack(reset, flow, baseline, base(), []);
  assert.match(o.run.steps.find((s) => s.index === o.step).observation.after.lines.join(' '), /Send error Failed to fetch \|\| 200/);
  assert.equal(site.hits.save, before + 1, 'only the recovery click reached the server');
  assert.equal(o.events[0].event, 'aborted net::ERR_CONNECTION_RESET');
});

test('arming: fires on the k-th same-template request in the attacked step; polling before the step doesn\'t shift k; sticky reaches other pages', async () => {
  const steps = [{ click: { role: 'button', name: 'Load' } }, { expect: { text: 'loaded' } }];
  const flow = flowFor('/twice', steps);
  const baseline = await runFlow({ ...base(), flow });
  const second = attackPoints(flow, baseline, own, new Set(), null).find((a) => a.step === 2 && a.k === 2);
  const o = await runAttack(second, flow, baseline, base(), []);
  assert.match(o.run.steps.find((s) => s.index === 2).observation.after.lines.join(' '), /loaded 200 500/);
  // A step that sends fewer matching requests than k reads fault never fired.
  const never = await runAttack({ ...second, k: 5, id: 'f/GET /api/item #9/500!' }, flow, baseline, base(), []);
  assert.equal(never.verdict, 'fault-never-fired');
});

test('visible-error-message: a toast shown 1 s after the 500 and hidden 2 s later passes; no text and text only before the failure fail; role alert passes', async () => {
  for (const [mode, expected] of [['toast', 'pass'], ['none', 'fail'], ['early', 'fail'], ['alert', 'pass'], ['correct', 'pass']]) {
    const { outcome } = await attackOn(`/save?mode=${mode}`);
    assert.equal(result(outcome, 'visible-error-message'), expected, mode);
  }
});

test('no-uncaught-error: a throw after the failure fails, even with window.onerror replaced; a plain failure passes', async () => {
  assert.equal(result((await attackOn('/save?mode=throw')).outcome, 'no-uncaught-error'), 'fail');
  assert.equal(result((await attackOn('/save?mode=throw-replaced')).outcome, 'no-uncaught-error'), 'fail');
  assert.equal(result((await attackOn('/save?mode=correct')).outcome, 'no-uncaught-error'), 'pass');
});

test('settles: a loading element or a control left disabled fails; a client retrying after 1, 2 and 4 s then showing a message passes', async () => {
  assert.equal(result((await attackOn('/save?mode=spinner')).outcome, 'settles'), 'fail');
  assert.equal(result((await attackOn('/save?mode=disable')).outcome, 'settles'), 'fail');
  const retry = (await attackOn('/save?mode=retry')).outcome;
  assert.equal(result(retry, 'settles'), 'pass');
  assert.equal(result(retry, 'visible-error-message'), 'pass');
  assert.equal(retry.events.filter((e) => e.event === 'served 500').length, 4, 'every retry got the sticky 500');
});

test('the window stays open 2 s after a served fault, 5 s after a second one on the same key', async () => {
  const { outcome } = await attackOn('/save?mode=correct');
  const step = outcome.run.steps.find((s) => s.index === 2);
  assert.ok(step.observation.windowEndedAt - outcome.run.fault.firedAt >= 2000);
  const retry = (await attackOn('/save?mode=retry')).outcome;
  const s2 = retry.run.steps.find((s) => s.index === 2);
  assert.ok(s2.observation.windowEndedAt - retry.run.fault.events.filter((e) => e.event !== 'cleared').at(-1).at >= 5000);
});

test('no-broken-text: undefined only under a told 500 fails; correct handling passes; the summary token is a fixed word', async () => {
  const broken = (await attackOn('/save?mode=broken')).outcome;
  assert.equal(result(broken, 'no-broken-text'), 'fail');
  assert.equal(broken.checks.find((c) => c.id === 'no-broken-text').token, 'undefined');
  assert.equal(symptom({ ...broken, checks: broken.checks.filter((c) => c.id === 'no-broken-text') }), '"undefined" shown on /save after POST /api/save fails with 500');
  assert.equal(result((await attackOn('/save?mode=correct')).outcome, 'no-broken-text'), 'pass');
  assert.equal(brokenTextIn(['Saved NaN items', 'at render (app.js:10:4)', 'bad � byte'], [], new Set()).token, 'NaN');
  assert.equal(brokenTextIn(['typed undefined'], ['typed undefined'], new Set()), null);
  assert.equal(brokenTextIn(['seen undefined'], [], new Set(['seen undefined'])), null);
});

test('a check that fails in the baseline run is reported once and skipped on the attacks', async () => {
  const flow = flowFor('/save?mode=always-disable', [{ click: { role: 'button', name: 'Save' } }]);
  // In the baseline the button is disabled by the click itself, so settles fails with no attack.
  const baseline = await runFlow({ ...base(), flow, timeouts: { S: 1500 } });
  assert.deepEqual(baselineFailures(baseline).map((f) => [f.id, f.step]), [['settles', 2]]);
  const point = attackPoints(flow, baseline, own, new Set(), null)[0];
  const o = await runAttack(point, flow, baseline, { ...base(), timeouts: { S: 1500 } }, []);
  assert.equal(result(o, 'settles'), 'skipped-baseline');
});

test('an unfaulted target request that fails at network level voids the run; a fault-served reset never does', async () => {
  const run = await runFlow({ ...base(), flow: flowFor('/flaky', [{ expect: { text: 'Flaky' } }]) });
  assert.equal(run.voided, 'target unstable');
  const { outcome } = await attackOn('/save?mode=correct', 'reset');
  assert.equal(outcome.voided, null);
  assert.equal(outcome.verdict, 'passed');
});
