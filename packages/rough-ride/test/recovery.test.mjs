import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { attackPoints, nonFinding, runAttack } from '../dist/attacks.mjs';
import { chooseBrowser, installedOnThisMachine, launchBrowser } from '../dist/browser.mjs';
import { CHECK_SEVERITY } from '../dist/checks.mjs';
import { runFlow } from '../dist/flowrun.mjs';
import { startRecoverySite } from './fixtures/recovery-site.mjs';
import { LOOPBACK_ONLY } from '../dist/hosts.mjs';

let browser;
let site;
before(async () => {
  browser = (await launchBrowser(chooseBrowser(process.env.RP_TEST_BROWSER ?? null, null, installedOnThisMachine()), [])).browser;
  site = await startRecoverySite();
});
after(async () => {
  await browser?.close();
  site?.close();
});

const base = () => ({ browser, baseURL: site.url, env: () => undefined, ready: { kind: 'load' }, hosts: LOOPBACK_ONLY });
const formFlow = (mode, extra = []) => ({
  name: 'create-note',
  signedIn: false,
  steps: [
    { goto: `/form?mode=${mode}` },
    { fill: { label: 'Title' }, value: 'Note ${unique}' },
    { fill: { label: 'Password' }, value: 'secret-pass-123' },
    ...extra,
    { click: { role: 'button', name: 'Save' } },
    { expect: { text: 'Saved Note' } },
  ],
});
const result = (o, id) => o.checks.find((c) => c.id === id);

async function attack(flow, fault = '500', sticky = true, tier = 'standard') {
  const baseline = await runFlow({ ...base(), flow });
  assert.ok(baseline.passed, JSON.stringify(baseline.failure));
  const point = attackPoints(flow, baseline, LOOPBACK_ONLY, new Set(), null, { tier }).find((p) => p.fault === fault && p.sticky === sticky);
  assert.ok(point, `no ${fault} point`);
  const hits = site.hits.save;
  const o = await runAttack(point, flow, baseline, base(), []);
  return { o, hits: site.hits.save - hits };
}

test('a still-visible Save is clicked again after the fault clears; cleared comes before the recovery request, which reaches the server', async () => {
  const { o, hits } = await attack(formFlow('keep'));
  assert.equal(o.run.recovery.action, 'click button "Save"');
  assert.equal(result(o, 'retry-recovers').result, 'pass');
  assert.equal(result(o, 'values-survive').result, 'pass');
  assert.equal(hits, 1, 'only the recovery request reached the server');
  const events = o.events.map((e) => e.event);
  assert.deepEqual(events.slice(-1), ['cleared']);
  assert.equal(o.verdict, 'passed');
});

test('cleared-form: values-survive and retry-recovers fail, both MED', async () => {
  const { o } = await attack(formFlow('clear'));
  assert.equal(result(o, 'values-survive').result, 'fail');
  assert.match(result(o, 'values-survive').evidence, /^label "Title" held "Note [a-z0-9]+", then "" after the failed request$/);
  assert.equal(result(o, 'retry-recovers').result, 'fail');
  assert.equal(CHECK_SEVERITY['values-survive'], 'medium');
  assert.equal(CHECK_SEVERITY['retry-recovers'], 'medium');
});

test('with Save gone, a new "Try again" button is clicked; with nothing to click, no retry path without a reload', async () => {
  const swap = (await attack(formFlow('swap'))).o;
  assert.equal(swap.run.recovery.action, 'click button "Try again"');
  assert.equal(result(swap, 'retry-recovers').result, 'pass');
  const dead = (await attack(formFlow('dead'))).o;
  assert.equal(result(dead, 'retry-recovers').result, 'fail');
  assert.equal(result(dead, 'retry-recovers').evidence, 'no retry path without a reload');
});

test('values-survive: trailing spaces and an emptied password pass; a navigation that removes the form passes', async () => {
  assert.equal(result((await attack(formFlow('spaces'))).o, 'values-survive').result, 'pass');
  const away = (await attack(formFlow('away'))).o;
  assert.equal(result(away, 'values-survive').result, 'pass');
});

test('contenteditable fields compare innerText', async () => {
  const flow = formFlow('clear', [{ fill: { role: 'textbox', name: 'Notes' }, value: 'some notes' }]);
  const { o } = await attack(flow);
  const notes = o.run.values.find((v) => v.field === 'textbox "Notes"');
  assert.equal(notes.before, 'some notes');
});

test('reset, 400 and 429 recover the same way', async () => {
  for (const fault of ['reset', '400', '429']) {
    const { o } = await attack(formFlow('keep'), fault);
    assert.equal(result(o, 'retry-recovers').result, 'pass', fault);
  }
});

test('not evaluated after malformed-json, empty-200 and a completed delay-3s; a later failing step prints Faulted and no finding', async () => {
  const flow = { name: 'list', signedIn: false, steps: [{ goto: '/list' }, { click: { role: 'button', name: 'Load' } }, { expect: { text: 'First: a' } }] };
  for (const [fault, stopped] of [['malformed-json', 3], ['empty-200', 3], ['delay-3s', null]]) {
    const { o } = await attack(flow, fault, fault !== 'delay-3s');
    assert.equal(result(o, 'retry-recovers').result, 'not-evaluated', fault);
    assert.equal(result(o, 'values-survive').result, 'not-evaluated', fault);
    assert.equal(o.run.stoppedAt, stopped, fault);
    assert.equal(o.verdict, 'passed', fault);
    if (stopped) assert.equal(nonFinding(o, 12_000).text, `Faulted; flow stopped at step 3: ${o.id}`);
  }
});
