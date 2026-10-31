import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { badInputAttack, nonFinding, runAttack, symptom } from '../dist/attacks.mjs';
import { browserBlock, fieldKind, leapYear, planBadInputs, preview, tierInputs, valueFor } from '../dist/badinputs.mjs';
import { chooseBrowser, installedOnThisMachine, launchBrowser } from '../dist/browser.mjs';
import { findForms } from '../dist/forms.mjs';
import { runFlow } from '../dist/flowrun.mjs';
import { fetchOpenApi } from '../dist/openapi.mjs';
import { startBadSite } from './fixtures/bad-site.mjs';
import { LOOPBACK_ONLY } from '../dist/hosts.mjs';

let browser;
let site;
before(async () => {
  browser = (await launchBrowser(chooseBrowser(process.env.RP_TEST_BROWSER ?? null, null, installedOnThisMachine()), [])).browser;
  site = await startBadSite();
});
after(async () => {
  await browser?.close();
  site?.close();
});

const own = LOOPBACK_ONLY.ownHost;
const base = () => ({ browser, baseURL: site.url, env: () => undefined, ready: { kind: 'load' }, hosts: LOOPBACK_ONLY });
const notesFlow = (mode = 'plain') => ({
  name: 'create-note',
  signedIn: false,
  steps: [
    { goto: `/notes/new?mode=${mode}` },
    { fill: { label: 'Title' }, value: 'Note ${unique}' },
    { fill: { label: 'Body' }, value: 'Some body' },
    { click: { role: 'button', name: 'Save' } },
    { expect: { text: 'Saved' } },
  ],
});
const today = new Date('2026-10-25T00:00:00Z');
const result = (o, id) => o.checks.find((c) => c.id === id)?.result;

async function plan(mode, tier = 'standard') {
  const flow = notesFlow(mode);
  const baseline = await runFlow({ ...base(), flow });
  assert.ok(baseline.passed, JSON.stringify(baseline.failure));
  const docs = await fetchOpenApi([site.url], [baseline]);
  const forms = findForms(flow, baseline, own, new Set());
  const p = planBadInputs(flow, baseline, forms, docs, { signInFlow: false, today });
  return { flow, baseline, p, chosen: tierInputs(p.inputs, tier) };
}

async function attackWith(mode, inputId, field = 'label "Title"') {
  const { flow, baseline, p } = await plan(mode);
  const input = p.inputs.find((x) => x.inputId === inputId && x.field.name === field);
  assert.ok(input, `${inputId} on ${field}: ${p.inputs.map((x) => `${x.field.name}/${x.inputId}`).join(', ')}`);
  return runAttack(badInputAttack(flow.name, input, 1, null), flow, baseline, base(), []);
}

test('kinds come from element facts, request evidence and schema, never labels', () => {
  const f = (over) => ({ tag: 'input', type: 'text', inputmode: null, autocomplete: null, role: null, required: false, ariaRequired: false, maxlength: null, minlength: null, min: null, max: null, step: null, pattern: null, multiple: false, readonly: false, disabled: false, contenteditable: false, novalidate: false, visible: true, options: null, held: '', ...over });
  const none = { jsonNumber: false };
  assert.equal(fieldKind(f({ inputmode: 'numeric' }), none, null, 'x'), 'numeric text');
  assert.equal(fieldKind(f({}), { jsonNumber: true }, null, '5'), 'numeric text');
  assert.equal(fieldKind(f({ type: 'email' }), none, { type: 'integer' }, 'a@b.c'), 'email');
  assert.equal(fieldKind(f({}), none, null, '2026-10-25'), 'date text');
  assert.equal(fieldKind(f({ type: 'search' }), none, null, 'x'), 'search');
  assert.equal(fieldKind(f({ tag: 'textarea', type: null }), none, null, 'x'), 'textarea');
  assert.equal(fieldKind(f({ tag: 'select', type: null }), none, null, 'x'), 'select');
  assert.equal(fieldKind(f({ type: 'number' }), none, { format: 'email' }, '3'), 'number');
});

test('values: long is 10,000 units starting with V, at-limit is L code points, email long is 268 characters and valid', () => {
  const c = { v: 'Note ab12cd34', unique: 'ab12cd34', limit: 200, type: null, today, min: null, max: null };
  const long = valueFor('long', c);
  assert.equal(long.length, 10_000);
  assert.ok(long.startsWith(c.v));
  assert.equal([...valueFor('at-limit', c)].length, 200);
  const email = valueFor('long', { ...c, type: 'email' });
  assert.equal(email.length, 268);
  assert.equal(browserBlock({ type: 'email', required: false, ariaRequired: false, maxlength: null, minlength: null, pattern: null, min: null, max: null }, email), null);
  assert.equal(leapYear(today, null, null), 2028);
  assert.equal(valueFor('impossible-date', { ...c, v: '2026-01-02' }), '2027-02-29');
  const all = ['specials', 'unicode', 'long', 'at-limit', 'empty', 'spaces', 'quote-plus', 'no-tld', 'huge', 'zero', 'negative', 'not-a-number', 'far-future', 'leap-day', 'impossible-date']
    .flatMap((id) => [valueFor(id, c), valueFor(id, { ...c, type: 'email' })]).filter((v) => v !== null);
  for (const v of all) {
    assert.doesNotMatch(v, /<script|on\w+=|https?:|<!--|\b(select|drop|insert|union)\b|undefined|NaN|\[object Object\]|Invalid Date|\n/i, v.slice(0, 40));
    assert.doesNotMatch(v, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'no lone surrogate');
  }
  const p = preview(valueFor('unicode', c));
  assert.ok(p.text.length <= 40 && /^[\x20-\x7e]*$/.test(p.text) && p.text.endsWith('...'));
  assert.ok(p.text.startsWith('\\u{1F469}\\u{1F3FD}'));
});

test('the notes form: title empty is skipped as valueMissing; quick runs title spaces and body long; standard runs 10', async () => {
  const { p, chosen } = await plan('plain', 'quick');
  assert.ok(p.skipped.includes('Skipped: label "Title" on /notes/new: empty (blocked by the browser\'s validation: valueMissing)'));
  assert.deepEqual(chosen.map(({ plan: x }) => `${x.field.name}/${x.inputId}`), ['label "Title"/spaces', 'label "Body"/long']);
  const standard = tierInputs(p.inputs, 'standard').map(({ plan: x }) => `${x.field.name}/${x.inputId}`);
  assert.deepEqual([...standard].sort(), [
    'label "Body"/at-limit', 'label "Body"/empty', 'label "Body"/long', 'label "Body"/specials', 'label "Body"/unicode',
    'label "Title"/at-limit', 'label "Title"/long', 'label "Title"/spaces', 'label "Title"/specials', 'label "Title"/unicode',
  ]);
});

test('outcomes: 422 rejected passes with a message and a recovery; a 500 crashes; a cross-origin 500 without CORS crashes; a network failure crashes without voiding', async () => {
  const rejected = await attackWith('plain', 'spaces');
  assert.equal(rejected.run.badInput.outcome, 'rejected');
  assert.equal(rejected.verdict, 'passed', JSON.stringify(rejected.checks));
  assert.equal(result(rejected, 'retry-recovers'), 'pass');
  const crash = await attackWith('crash', 'spaces');
  assert.equal(crash.run.badInput.outcome, 'crashed');
  assert.equal(result(crash, 'no-5xx-on-bad-input'), 'fail');
  assert.equal(symptom(crash), 'POST /api/notes answers 500 to bad input spaces in label "Title"');
  const cors = await attackWith('cors500', 'spaces');
  assert.equal(cors.run.badInput.outcome, 'crashed', JSON.stringify(cors.run.badInput.carrying));
  const net = await attackWith('netfail', 'spaces');
  assert.equal(net.run.badInput.outcome, 'crashed');
  assert.equal(net.voided, null);
});

test('outcomes: 401, 403, 407, 408 and 429 are Inconclusive', async () => {
  for (const status of ['401', '403', '429']) {
    const o = await attackWith(status, 'spaces');
    assert.equal(o.verdict, 'inconclusive', status);
    assert.equal(nonFinding(o, 12_000).text, `Inconclusive: create-note/label "Title"/spaces (${status} on POST /api/notes)`);
  }
});

test('outcomes: a silent early return is a HIGH silent refusal; an app message is blocked by the app; checkValidity() only is a silent refusal', async () => {
  const silent = await attackWith('silent', 'spaces');
  assert.equal(silent.run.badInput.outcome, 'silent-refusal');
  assert.equal(result(silent, 'visible-error-message'), 'fail');
  assert.equal(symptom(silent), 'button "Save" does nothing and shows no message for bad input spaces in label "Title"');
  const app = await attackWith('appblock', 'spaces');
  assert.equal(app.run.badInput.outcome, 'blocked-by-app');
  assert.equal(app.verdict, 'passed');
  const check = await attackWith('checkonly', 'empty');
  assert.equal(check.run.badInput.outcome, 'silent-refusal', JSON.stringify(check.run.formEvents));
});

test('cleared-form: a bad input on Save fails values-survive', async () => {
  const o = await attackWith('clear', 'spaces');
  assert.equal(result(o, 'values-survive'), 'fail');
});

test('a native required block is blocked by the browser, also inside a shadow root', async () => {
  const flow = { name: 'f', signedIn: false, steps: [{ goto: '/notes/new?mode=plain' }, { fill: { label: 'Title' }, value: '' }, { click: { role: 'button', name: 'Save' } }] };
  const run = await runFlow({ ...base(), flow });
  assert.ok(run.formEvents.invalids.some((e) => e.step === 3 && e.browser && e.visible && e.flags.includes('valueMissing')), JSON.stringify(run.formEvents));
  const shadow = await runFlow({ ...base(), flow: { name: 'g', signedIn: false, steps: [{ goto: '/shadow' }, { click: { role: 'button', name: 'Go' } }] } });
  assert.ok(shadow.formEvents.invalids.some((e) => e.browser), JSON.stringify(shadow.formEvents));
});

test('a fill that throws and a field that keeps the flow\'s value read Not applied', async () => {
  const { flow, baseline, p } = await plan('plain');
  // A value equal to the flow's own value stands for a masked field that keeps V.
  const input = { ...p.inputs.find((x) => x.inputId === 'long' && x.field.name === 'label "Body"'), value: 'Some body' };
  const o = await runAttack(badInputAttack(flow.name, input, 1, null), flow, baseline, base(), []);
  assert.equal(o.verdict, 'not-applied');
  assert.equal(nonFinding(o, 12_000).text, 'Not applied: create-note/label "Body"/long (the field kept the flow\'s own value)');
  // A select value that doesn't exist makes selectOption throw.
  const thrown = await runAttack(badInputAttack(flow.name, { ...input, select: true, value: 'nope' }, 1, null), flow, baseline, base(), []);
  assert.match(nonFinding(thrown, 12_000).text, /^Not applied: create-note\/label "Body"\/long \(fill failed: /);
});
