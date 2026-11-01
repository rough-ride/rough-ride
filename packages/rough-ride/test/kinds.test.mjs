// Every attack kind's observable facts on the fixture sites: the flow run's
// kind facts, the verdict and checks, the run record's kind fields, the
// regression key, the non-finding line, the symptom, and the group key, attack
// link and app check id the run and plan read from the kind.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { matchesWhen } from '../dist/appchecks.mjs';
import { attackLink, attackPoints, badInputAttack, doubleSubmitPoints, nonFinding, outOfOrderPoints, pageTimingPoints, runAttack, symptom, viewportAttack } from '../dist/attacks.mjs';
import { planBadInputs } from '../dist/badinputs.mjs';
import { chooseBrowser, installedOnThisMachine, launchBrowser } from '../dist/browser.mjs';
import { findForms } from '../dist/forms.mjs';
import { runFlow } from '../dist/flowrun.mjs';
import { LOOPBACK_ONLY } from '../dist/hosts.mjs';
import { keyOf } from '../dist/groups.mjs';
import { fetchOpenApi } from '../dist/openapi.mjs';
import { attackKey, attackRecord } from '../dist/record.mjs';
import { startBadSite } from './fixtures/bad-site.mjs';
import { startOooSite } from './fixtures/ooo-site.mjs';
import { startPageSite } from './fixtures/page-site.mjs';
import { startRecoverySite } from './fixtures/recovery-site.mjs';
import { startTimingSite } from './fixtures/timing-site.mjs';

const own = LOOPBACK_ONLY.ownHost;
let browser;
const sites = {};
let wide;
before(async () => {
  browser = (await launchBrowser(chooseBrowser(process.env.RP_TEST_BROWSER ?? null, null, installedOnThisMachine()), [])).browser;
  [sites.recovery, sites.timing, sites.ooo, sites.page, sites.bad] = await Promise.all([startRecoverySite(), startTimingSite(), startOooSite(), startPageSite(), startBadSite()]);
  wide = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><html><head><style>body { margin: 0 } #box { width: 377px; height: 20px }</style></head><body><h1>Page</h1><div id="box"></div><button>Show</button></body></html>');
  });
  await new Promise((r) => wide.listen(0, '127.0.0.1', r));
  sites.wide = { url: `http://127.0.0.1:${wide.address().port}` };
});
after(async () => {
  await browser?.close();
  for (const s of Object.values(sites)) s.close?.();
  wide?.close();
});

const base = (site, extra = {}) => ({ browser, baseURL: sites[site].url, env: () => undefined, ready: { kind: 'load' }, hosts: LOOPBACK_ONLY, ...extra });
const ms = (text) => text.replace(/\d+ ms/g, 'N ms');

// The facts a kind owns, with times and this run's unique left out.
function facts(o, flow) {
  const r = o.run;
  const record = attackRecord(o, { ordinal: 1, durationMs: 0 }, flow);
  const kindFields = Object.fromEntries(['request', 'badInput', 'viewport', 'timing', 'fault', 'events'].filter((k) => k in record).map((k) => [k, record[k]]));
  if (kindFields.events) kindFields.events = kindFields.events.map((e) => ms(e.event));
  if (kindFields.fault) kindFields.fault = { ...kindFields.fault, events: kindFields.fault.events.map((e) => ms(e.event)) };
  // A forwarded response's Date header changes from run to run.
  // The date and the test server's keep-alive timeout (Node's default, which Node 27 changed) vary by run and Node version.
  const headers = kindFields.fault?.served?.headers;
  if (headers?.date) kindFields.fault.served = { ...kindFields.fault.served, headers: { ...headers, date: '<date>', ...(headers['keep-alive'] ? { 'keep-alive': '<keep-alive>' } : {}) } };
  return {
    verdict: o.verdict,
    checks: o.checks.map((c) => `${c.id} ${c.result}`),
    step: o.step,
    page: o.page,
    control: o.control,
    notApplied: o.notApplied,
    givenUp: o.givenUp,
    events: o.events.map((e) => ms(e.event)),
    run: {
      passed: r.passed,
      failure: r.failure?.step ?? null,
      stoppedAt: r.stoppedAt,
      endedAfterWindow: r.endedAfterWindow,
      recovery: r.recovery,
      timing: r.timing?.action ?? null,
      fault: r.fault && { fired: r.fault.fired, notApplied: r.fault.notApplied, pending: r.fault.pending, givenUp: r.fault.givenUp, absorbed: r.fault.absorbed, served: r.fault.served && Object.keys(r.fault.served).join(',') },
      badInput: r.badInput && { notApplied: r.badInput.notApplied, outcome: r.badInput.outcome, submitDisabled: r.badInput.submitDisabled, submitted: r.badInput.submittedAt !== null, reference: r.badInput.reference.length, after: r.badInput.after.length, carrying: r.badInput.carrying && `${r.badInput.carrying.method} ${r.badInput.carrying.path} ${r.badInput.carrying.status}` },
      outOfOrder: r.outOfOrder && { notApplied: r.outOfOrder.notApplied, aborted: r.outOfOrder.aborted, released: r.outOfOrder.releasedAt !== null, olderOnly: r.outOfOrder.olderOnly, newerOnly: r.outOfOrder.newerOnly },
      pageTiming: r.pageTiming && { notApplied: r.pageTiming.notApplied, events: r.pageTiming.events.map((e) => e.event), documentStatus: r.pageTiming.documentStatus, navigationError: r.pageTiming.navigationError, removed: r.pageTiming.removed, served401: r.pageTiming.served401 },
      values: r.values && r.values.map((v) => `${v.field} ${v.password} ${v.before === v.after}`),
      steps: r.steps.map((s) => `${s.index} ${s.label} ${s.settled}${s.overflowPx !== undefined ? ` overflow ${s.overflowPx}` : ''}${s.value !== undefined ? ' value' : ''}`),
      shots: [...r.shots.keys()],
    },
    record: { kind: record.kind, step: record.step, page: record.page, verdict: record.verdict, stoppedAt: record.stoppedAt, failedChecks: record.failedChecks, ...kindFields },
    key: attackKey(o),
    nonFinding: nonFinding(o, 12_000)?.text ?? null,
    symptom: o.verdict === 'failed' ? symptom(o) : null,
    groupKey: keyOf(o, flow),
    link: (({ kind, endpoints }) => ({ kind, endpoints }))(attackLink(o, [])),
    // The ids an app check's when.ids matches the attack by.
    ids: [o.badInput?.inputId, o.timing, o.fault, 'none'].filter((id) => id && matchesWhen({ id: 'app-x', when: { ids: [id] } }, o, flow)),
  };
}

async function baselineOf(site, flow, extra) {
  const baseline = await runFlow({ ...base(site, extra), flow });
  assert.ok(baseline.passed, JSON.stringify(baseline.failure));
  return baseline;
}

const formFlow = (extra = []) => ({
  name: 'create-note',
  signedIn: false,
  steps: [{ goto: '/form?mode=keep' }, { fill: { label: 'Title' }, value: 'Note ${unique}' }, { fill: { label: 'Password' }, value: 'secret-pass-123' }, { click: { role: 'button', name: 'Save' } }, { expect: { text: 'Saved Note' } }, ...extra],
});

test('fault: a sticky 500 on Save clears, then the still-visible Save recovers', async () => {
  const flow = formFlow();
  const baseline = await baselineOf('recovery', flow);
  const point = attackPoints(flow, baseline, LOOPBACK_ONLY, new Set(), null, { tier: 'standard' }).find((p) => p.fault === '500' && p.sticky);
  const o = await runAttack(point, flow, baseline, base('recovery'), []);
  assert.deepEqual(facts(o, flow), PINNED.fault500);
});

test('fault: repro --keep-open keeps the fault applied after its window: nothing clears and nothing recovers', async () => {
  const flow = formFlow();
  const baseline = await baselineOf('recovery', flow);
  const point = attackPoints(flow, baseline, LOOPBACK_ONLY, new Set(), null, { tier: 'standard' }).find((p) => p.fault === '500' && p.sticky);
  const o = await runAttack(point, flow, baseline, base('recovery', { keepArmed: true }), []);
  assert.deepEqual(facts(o, flow), PINNED.keepArmed);
});

test('fault: malformed-json delivers a 2xx, and a later failing step stops the flow', async () => {
  const flow = { name: 'list', signedIn: false, steps: [{ goto: '/list' }, { click: { role: 'button', name: 'Load' } }, { expect: { text: 'First: a' } }] };
  const baseline = await baselineOf('recovery', flow);
  const point = attackPoints(flow, baseline, LOOPBACK_ONLY, new Set(), null, { tier: 'standard' }).find((p) => p.fault === 'malformed-json' && p.sticky);
  const o = await runAttack(point, flow, baseline, base('recovery'), []);
  assert.deepEqual(facts(o, flow), PINNED.malformed);
});

test('double-submit: an unguarded create fails one-write; a later failing step stops the flow', async () => {
  const save = { click: { role: 'button', name: 'Save' } };
  const flow = { name: 'create-note', signedIn: false, steps: [{ goto: '/noguard' }, save] };
  const baseline = await baselineOf('timing', flow);
  const o = await runAttack(doubleSubmitPoints(flow, baseline, own, new Set(), null, false)[0], flow, baseline, base('timing'), []);
  assert.deepEqual(facts(o, flow), PINNED.double);
  const stopFlow = { name: 'create-note', signedIn: false, steps: [{ goto: '/dup500' }, save, { expect: { text: 'Done 200' } }] };
  const stopBaseline = await baselineOf('timing', stopFlow);
  const stopped = await runAttack(doubleSubmitPoints(stopFlow, stopBaseline, own, new Set(), null, false)[0], stopFlow, stopBaseline, base('timing'), []);
  assert.deepEqual(facts(stopped, stopFlow), PINNED.doubleStopped);
});

test('out-of-order: a stale search fails latest-response-wins; equal answers read Not applied', async () => {
  const searchFlow = (mode) => ({ name: 'search', signedIn: false, steps: [{ goto: `/search?mode=${mode}` }, { fill: { label: 'Find' }, value: 'Garden' }, { expect: { text: 'Garden plan' } }] });
  const run = async (mode) => {
    const flow = searchFlow(mode);
    const baseline = await baselineOf('ooo', flow);
    const point = outOfOrderPoints(flow, baseline, findForms(flow, baseline, own, new Set()), own, new Set(), null, false)[0];
    return facts(await runAttack(point, flow, baseline, base('ooo'), []), flow);
  };
  assert.deepEqual(await run('stale'), PINNED.oooStale);
  assert.deepEqual(await run('same'), PINNED.oooSame);
});

test('page timing: refresh, back and signed-out-reload on a well-behaved page; a reload after a form post reads Not applied', async () => {
  const newFlow = { name: 'create-note', signedIn: false, steps: [{ goto: '/?mode=plain' }, { click: { role: 'link', name: 'New' } }, { expect: { role: 'heading', name: 'New' } }] };
  const baseline = await baselineOf('page', newFlow);
  const points = pageTimingPoints(newFlow, [baseline], new Set(), null, false);
  const on = async (kind) => facts(await runAttack(points.find((p) => p.timing === kind && p.page === '/new'), newFlow, baseline, base('page'), []), newFlow);
  assert.deepEqual(await on('refresh'), PINNED.refresh);
  assert.deepEqual(await on('back'), PINNED.back);

  const storageState = { cookies: [{ name: 'sid', value: 'sid-0123456789abcdef', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] };
  const credentials = ['sid-0123456789abcdef'];
  const meFlow = { name: 'me', signedIn: true, steps: [{ goto: '/me' }, { expect: { text: 'Signed in as Ada' } }] };
  const meBaseline = await baselineOf('page', meFlow, { storageState, credentials });
  const signedOut = pageTimingPoints(meFlow, [meBaseline], new Set(), null, false).find((x) => x.timing === 'signed-out-reload');
  assert.deepEqual(facts(await runAttack(signedOut, meFlow, meBaseline, base('page', { storageState, credentials }), []), meFlow), PINNED.signedOut);

  const postFlow = { name: 'post', signedIn: false, steps: [{ goto: '/form' }, { click: { role: 'button', name: 'Send' } }, { expect: { role: 'heading', name: 'Posted' } }] };
  const postBaseline = await baselineOf('page', postFlow);
  const refreshPost = { ...points.find((p) => p.timing === 'refresh'), flow: 'post', id: 'post/page /posted #1/refresh', page: '/posted', step: 2, entry: { k: 1, previous: '/form' } };
  assert.deepEqual(facts(await runAttack(refreshPost, postFlow, postBaseline, base('page'), []), postFlow), PINNED.refreshPost);
});

test('bad input: a 422 is rejected and recovers by re-filling the form; a 500 crashes and ends the attack; a kept value reads Not applied', async () => {
  const notesFlow = (mode) => ({
    name: 'create-note',
    signedIn: false,
    steps: [{ goto: `/notes/new?mode=${mode}` }, { fill: { label: 'Title' }, value: 'Note ${unique}' }, { fill: { label: 'Body' }, value: 'Some body' }, { click: { role: 'button', name: 'Save' } }, { expect: { text: 'Saved' } }],
  });
  const run = async (mode, inputId, field, over = {}) => {
    const flow = notesFlow(mode);
    const baseline = await baselineOf('bad', flow);
    const docs = await fetchOpenApi([sites.bad.url], [baseline]);
    const p = planBadInputs(flow, baseline, findForms(flow, baseline, own, new Set()), docs, { signInFlow: false, today: new Date('2026-10-25T00:00:00Z') });
    const input = { ...p.inputs.find((x) => x.inputId === inputId && x.field.name === field), ...over };
    return facts(await runAttack(badInputAttack(flow.name, input, 1, null), flow, baseline, base('bad'), []), flow);
  };
  assert.deepEqual(await run('plain', 'spaces', 'label "Title"'), PINNED.badRejected);
  assert.deepEqual(await run('crash', 'spaces', 'label "Title"'), PINNED.badCrashed);
  assert.deepEqual(await run('plain', 'long', 'label "Body"', { value: 'Some body' }), PINNED.badKept);
});

test('viewport: 2 px of overflow fails no-overflow-375 at the first step that measured it', async () => {
  const flow = { name: 'f', signedIn: false, steps: [{ goto: '/' }, { click: { role: 'button', name: 'Show' } }] };
  const baseline = await baselineOf('wide', flow);
  assert.deepEqual(facts(await runAttack(viewportAttack(flow, true), flow, baseline, base('wide'), []), flow), PINNED.viewport);
});

test('an attack without the fields its kind needs is refused by name, not read as another kind', () => {
  const bare = { id: 'f/label "Title"/spaces', flow: 'f', kind: 'bad-input', fault: null, sticky: false, rank: 1, key: '', template: '', step: 1, k: 1, diffLinked: false, closeness: 3 };
  assert.throws(() => attackKey(bare), /^Error: f\/label "Title"\/spaces: kind bad-input without the fields that kind needs$/);
  assert.throws(() => attackKey({ ...bare, id: 'f/x/out-of-order', kind: 'timing', timing: 'out-of-order' }), /: kind out-of-order without the fields that kind needs$/);
  assert.throws(() => attackKey({ ...bare, id: 'f/x/fault', kind: 'fault', fault: undefined }), /: kind fault without the fields that kind needs$/);
});

const PINNED = {
  keepArmed: {"verdict": "passed", "checks": ["no-uncaught-error pass", "settles pass", "visible-error-message pass", "values-survive pass", "no-broken-text pass", "retry-recovers not-evaluated"], "step": 4, "page": "/form", "control": "button \"Save\"", "notApplied": null, "givenUp": false, "events": ["served 500"], "run": {"passed": true, "failure": null, "stoppedAt": null, "endedAfterWindow": true, "recovery": null, "timing": null, "fault": {"fired": true, "notApplied": null, "pending": false, "givenUp": false, "absorbed": false, "served": "status,headers,body"}, "badInput": null, "outOfOrder": null, "pageTiming": null, "values": ["label \"Title\" false true", "label \"Password\" true true"], "steps": ["1 goto /form?mode=keep true", "2 fill label \"Title\" true value", "3 fill label \"Password\" true value", "4 click button \"Save\" true"], "shots": [4]}, "record": {"kind": "fault", "step": {"index": 4, "kind": "click", "locator": "button \"Save\""}, "page": "/form", "verdict": "passed", "stoppedAt": null, "failedChecks": [], "request": {"method": "POST", "path": "/api/save", "template": "POST /api/save", "n": 1, "nextAction": null}, "fault": {"id": "500", "sticky": true, "events": ["served 500"], "served": {"status": 500, "headers": {"content-type": "text/plain; charset=utf-8"}, "body": "Internal Server Error"}}}, "key": {"fault": "500", "sticky": true, "request": "POST /api/save #1", "page": "/form"}, "nonFinding": null, "symptom": null},
  fault500: {"verdict": "passed", "checks": ["no-uncaught-error pass", "settles pass", "visible-error-message pass", "values-survive pass", "no-broken-text pass", "retry-recovers pass"], "step": 4, "page": "/form", "control": "button \"Save\"", "notApplied": null, "givenUp": false, "events": ["served 500", "cleared"], "run": {"passed": true, "failure": null, "stoppedAt": null, "endedAfterWindow": false, "recovery": {"action": "click button \"Save\"", "passed": true, "detail": null}, "timing": null, "fault": {"fired": true, "notApplied": null, "pending": false, "givenUp": false, "absorbed": false, "served": "status,headers,body"}, "badInput": null, "outOfOrder": null, "pageTiming": null, "values": ["label \"Title\" false true", "label \"Password\" true true"], "steps": ["1 goto /form?mode=keep true", "2 fill label \"Title\" true value", "3 fill label \"Password\" true value", "4 click button \"Save\" true", "4 click button \"Save\" true", "5 expect text \"Saved Note\" true"], "shots": [4]}, "record": {"kind": "fault", "step": {"index": 4, "kind": "click", "locator": "button \"Save\""}, "page": "/form", "verdict": "passed", "stoppedAt": null, "failedChecks": [], "request": {"method": "POST", "path": "/api/save", "template": "POST /api/save", "n": 1, "nextAction": null}, "fault": {"id": "500", "sticky": true, "events": ["served 500", "cleared"], "served": {"status": 500, "headers": {"content-type": "text/plain; charset=utf-8"}, "body": "Internal Server Error"}}}, "key": {"fault": "500", "sticky": true, "request": "POST /api/save #1", "page": "/form"}, "nonFinding": null, "symptom": null},
  malformed: {"verdict": "passed", "checks": ["no-uncaught-error pass", "settles pass", "visible-error-message not-evaluated", "values-survive not-evaluated", "no-broken-text pass", "retry-recovers not-evaluated"], "step": 2, "page": "/list", "control": "button \"Load\"", "notApplied": null, "givenUp": false, "events": ["forwarded 200 application/json", "cleared"], "run": {"passed": false, "failure": 3, "stoppedAt": 3, "endedAfterWindow": false, "recovery": null, "timing": null, "fault": {"fired": true, "notApplied": null, "pending": false, "givenUp": false, "absorbed": false, "served": "status,headers,bodyKind,length,sha256"}, "badInput": null, "outOfOrder": null, "pageTiming": null, "values": [], "steps": ["1 goto /list true", "2 click button \"Load\" true"], "shots": [2]}, "record": {"kind": "fault", "step": {"index": 2, "kind": "click", "locator": "button \"Load\""}, "page": "/list", "verdict": "passed", "stoppedAt": 3, "failedChecks": [], "request": {"method": "GET", "path": "/api/list", "template": "GET /api/list", "n": 1, "nextAction": null}, "fault": {"id": "malformed-json", "sticky": true, "events": ["forwarded 200 application/json", "cleared"], "served": {"status": 200, "headers": {"content-type": "application/json", "date": "<date>", "connection": "keep-alive", "keep-alive": "<keep-alive>"}, "bodyKind": "malformed", "length": 29, "sha256": "6f36be366206fec53bad6336e460962a049e8d56b30c94aa85fde9865a9a1ea1"}}}, "key": {"fault": "malformed-json", "sticky": true, "request": "GET /api/list #1", "page": "/list"}, "nonFinding": "Faulted; flow stopped at step 3: list/GET /api/list #1/malformed-json!", "symptom": null},
  double: {"verdict": "failed", "checks": ["one-write fail", "no-uncaught-error pass", "settles pass", "no-broken-text pass"], "step": 2, "page": "/noguard", "control": "button \"Save\"", "notApplied": null, "givenUp": false, "events": ["double-clicked"], "run": {"passed": true, "failure": null, "stoppedAt": null, "endedAfterWindow": false, "recovery": null, "timing": "double-clicked", "fault": null, "badInput": null, "outOfOrder": null, "pageTiming": null, "values": null, "steps": ["1 goto /noguard true", "2 click button \"Save\" true"], "shots": [2]}, "record": {"kind": "timing", "step": {"index": 2, "kind": "click", "locator": "button \"Save\""}, "page": "/noguard", "verdict": "failed", "stoppedAt": null, "failedChecks": ["one-write"], "request": {"method": "POST", "path": "/api/notes", "template": "POST /api/notes", "n": 1, "nextAction": null}, "timing": {"timing": "double-submit", "key": "POST /api/notes #1", "control": "Save", "page": "/noguard"}, "events": ["double-clicked"]}, "key": {"timing": "double-submit", "request": "POST /api/notes #1", "page": "/noguard"}, "nonFinding": null, "symptom": "button \"Save\" sends 2 successful POST /api/notes on a double click (if this control is a toggle, give it aria-pressed)"},
  doubleStopped: {"verdict": "passed", "checks": ["one-write pass", "no-uncaught-error pass", "settles pass", "no-broken-text pass"], "step": 2, "page": "/dup500", "control": "button \"Save\"", "notApplied": null, "givenUp": false, "events": ["double-clicked"], "run": {"passed": false, "failure": 3, "stoppedAt": 3, "endedAfterWindow": false, "recovery": null, "timing": "double-clicked", "fault": null, "badInput": null, "outOfOrder": null, "pageTiming": null, "values": null, "steps": ["1 goto /dup500 true", "2 click button \"Save\" true"], "shots": [2]}, "record": {"kind": "timing", "step": {"index": 2, "kind": "click", "locator": "button \"Save\""}, "page": "/dup500", "verdict": "passed", "stoppedAt": 3, "failedChecks": [], "request": {"method": "POST", "path": "/api/once", "template": "POST /api/once", "n": 1, "nextAction": null}, "timing": {"timing": "double-submit", "key": "POST /api/once #1", "control": "Save", "page": "/dup500"}, "events": ["double-clicked"]}, "key": {"timing": "double-submit", "request": "POST /api/once #1", "page": "/dup500"}, "nonFinding": "Faulted; flow stopped at step 3: create-note/POST /api/once #1/double-submit", "symptom": null},
  oooStale: {"verdict": "failed", "checks": ["latest-response-wins fail", "no-uncaught-error pass", "settles pass", "no-broken-text pass"], "step": 2, "page": "/search", "control": "label \"Find\"", "notApplied": null, "givenUp": false, "events": ["held", "newer delivered", "released after N ms"], "run": {"passed": false, "failure": 3, "stoppedAt": 3, "endedAfterWindow": false, "recovery": null, "timing": null, "fault": {"fired": true, "notApplied": null, "pending": false, "givenUp": false, "absorbed": false, "served": null}, "badInput": null, "outOfOrder": {"notApplied": null, "aborted": false, "released": true, "olderOnly": [], "newerOnly": ["Garden plan"]}, "pageTiming": null, "values": null, "steps": ["1 goto /search?mode=stale true", "2 fill label \"Find\" true value"], "shots": [2]}, "record": {"kind": "timing", "step": {"index": 2, "kind": "fill", "locator": "label \"Find\""}, "page": "/search", "verdict": "failed", "stoppedAt": 3, "failedChecks": ["latest-response-wins"], "request": {"method": "GET", "path": "/api/search", "template": "GET /api/search", "n": 1, "nextAction": null}, "timing": {"timing": "out-of-order", "key": "GET /api/search #1", "control": "label \"Find\"", "page": "/search"}, "events": ["held", "newer delivered", "released after N ms"]}, "key": {"timing": "out-of-order", "page": "/search", "request": "GET /api/search", "field": "q"}, "nonFinding": null, "symptom": "Stale answer shown as current when an older answer arrived after a newer one on label \"Find\""},
  oooSame: {"verdict": "not-applied", "checks": [], "step": 2, "page": "/search", "control": "label \"Find\"", "notApplied": "both answers were the same", "givenUp": false, "events": ["held", "newer delivered", "released after N ms"], "run": {"passed": true, "failure": null, "stoppedAt": null, "endedAfterWindow": true, "recovery": null, "timing": null, "fault": {"fired": true, "notApplied": null, "pending": false, "givenUp": false, "absorbed": false, "served": null}, "badInput": null, "outOfOrder": {"notApplied": "both answers were the same", "aborted": false, "released": true, "olderOnly": null, "newerOnly": null}, "pageTiming": null, "values": null, "steps": ["1 goto /search?mode=same true"], "shots": []}, "record": {"kind": "timing", "step": {"index": 2, "kind": "fill", "locator": "label \"Find\""}, "page": "/search", "verdict": "not-applied", "stoppedAt": null, "failedChecks": [], "request": {"method": "GET", "path": "/api/search", "template": "GET /api/search", "n": 1, "nextAction": null}, "timing": {"timing": "out-of-order", "key": "GET /api/search #1", "control": "label \"Find\"", "page": "/search"}, "events": ["held", "newer delivered", "released after N ms"]}, "key": {"timing": "out-of-order", "page": "/search", "request": "GET /api/search", "field": "q"}, "nonFinding": "Not applied: search/label \"Find\"/out-of-order (both answers were the same)", "symptom": null},
  refresh: {"verdict": "passed", "checks": ["no-uncaught-error pass", "settles pass", "no-broken-text pass"], "step": 2, "page": "/new", "control": "link \"New\"", "notApplied": null, "givenUp": false, "events": ["reloaded 200"], "run": {"passed": true, "failure": null, "stoppedAt": null, "endedAfterWindow": false, "recovery": null, "timing": null, "fault": null, "badInput": null, "outOfOrder": null, "pageTiming": {"notApplied": null, "events": ["reloaded 200"], "documentStatus": 200, "navigationError": null, "removed": 0, "served401": 0}, "values": null, "steps": ["1 goto /?mode=plain true", "2 click link \"New\" true", "2 reload true", "3 expect heading \"New\" true"], "shots": [2]}, "record": {"kind": "timing", "step": {"index": 2, "kind": "click", "locator": "link \"New\""}, "page": "/new", "verdict": "passed", "stoppedAt": null, "failedChecks": [], "timing": {"timing": "refresh", "key": "page /new #1", "control": "link \"New\"", "page": "/new"}, "events": ["reloaded 200"]}, "key": {"timing": "refresh", "page": "/new", "entry": 1}, "nonFinding": null, "symptom": null},
  back: {"verdict": "passed", "checks": ["no-uncaught-error pass", "settles pass", "no-broken-text pass"], "step": 2, "page": "/new", "control": "link \"New\"", "notApplied": null, "givenUp": false, "events": ["went back /", "went forward /new"], "run": {"passed": true, "failure": null, "stoppedAt": null, "endedAfterWindow": false, "recovery": null, "timing": null, "fault": null, "badInput": null, "outOfOrder": null, "pageTiming": {"notApplied": null, "events": ["went back /", "went forward /new"], "documentStatus": null, "navigationError": null, "removed": 0, "served401": 0}, "values": null, "steps": ["1 goto /?mode=plain true", "2 click link \"New\" true", "2 go back true", "2 go forward true", "3 expect heading \"New\" true"], "shots": [2]}, "record": {"kind": "timing", "step": {"index": 2, "kind": "click", "locator": "link \"New\""}, "page": "/new", "verdict": "passed", "stoppedAt": null, "failedChecks": [], "timing": {"timing": "back", "key": "page /new #1", "control": "link \"New\"", "page": "/new"}, "events": ["went back /", "went forward /new"]}, "key": {"timing": "back", "page": "/new", "entry": 1}, "nonFinding": null, "symptom": null},
  signedOut: {"verdict": "passed", "checks": ["no-uncaught-error pass", "settles pass", "no-broken-text pass"], "step": 1, "page": "/me", "control": "goto /me", "notApplied": null, "givenUp": false, "events": ["cookies deleted 1", "reloaded 200"], "run": {"passed": true, "failure": null, "stoppedAt": null, "endedAfterWindow": true, "recovery": null, "timing": null, "fault": null, "badInput": null, "outOfOrder": null, "pageTiming": {"notApplied": null, "events": ["cookies deleted 1", "reloaded 200"], "documentStatus": 200, "navigationError": null, "removed": 1, "served401": 0}, "values": null, "steps": ["1 goto /me true", "1 reload true"], "shots": [1]}, "record": {"kind": "timing", "step": {"index": 1, "kind": "goto", "locator": null}, "page": "/me", "verdict": "passed", "stoppedAt": null, "failedChecks": [], "timing": {"timing": "signed-out-reload", "key": "page /me #1", "control": "goto /me", "page": "/me"}, "events": ["cookies deleted 1", "reloaded 200"]}, "key": {"timing": "signed-out-reload", "page": "/me", "entry": 1}, "nonFinding": null, "symptom": null},
  refreshPost: {"verdict": "not-applied", "checks": [], "step": 2, "page": "/posted", "control": "button \"Send\"", "notApplied": "the reload would resend a form post", "givenUp": false, "events": ["form post blocked"], "run": {"passed": true, "failure": null, "stoppedAt": null, "endedAfterWindow": true, "recovery": null, "timing": null, "fault": null, "badInput": null, "outOfOrder": null, "pageTiming": {"notApplied": "the reload would resend a form post", "events": ["form post blocked"], "documentStatus": null, "navigationError": null, "removed": 0, "served401": 0}, "values": null, "steps": ["1 goto /form true", "2 click button \"Send\" true"], "shots": [2]}, "record": {"kind": "timing", "step": {"index": 2, "kind": "click", "locator": "button \"Send\""}, "page": "/posted", "verdict": "not-applied", "stoppedAt": null, "failedChecks": [], "timing": {"timing": "refresh", "key": "page /new #1", "control": "link \"New\"", "page": "/posted"}, "events": ["form post blocked"]}, "key": {"timing": "refresh", "page": "/posted", "entry": 1}, "nonFinding": "Not applied: post/page /posted #1/refresh (the reload would resend a form post)", "symptom": null},
  badRejected: {"verdict": "passed", "checks": ["no-uncaught-error pass", "settles pass", "no-broken-text pass", "no-5xx-on-bad-input pass", "visible-error-message pass", "values-survive pass", "retry-recovers pass"], "step": 4, "page": "/notes/new", "control": "button \"Save\"", "notApplied": null, "givenUp": false, "events": [], "run": {"passed": true, "failure": null, "stoppedAt": null, "endedAfterWindow": false, "recovery": {"action": "re-fill 2 fields, then click button \"Save\"", "passed": true, "detail": null}, "timing": null, "fault": null, "badInput": {"notApplied": null, "outcome": "rejected", "submitDisabled": false, "submitted": true, "reference": 2, "after": 2, "carrying": "POST /api/notes 422"}, "outOfOrder": null, "pageTiming": null, "values": null, "steps": ["1 goto /notes/new?mode=plain true", "2 fill label \"Title\" true value", "3 fill label \"Body\" true value", "4 click button \"Save\" true", "2 fill label \"Title\" true value", "3 fill label \"Body\" true value", "4 click button \"Save\" true", "5 expect text \"Saved\" true"], "shots": [4]}, "record": {"kind": "bad-input", "step": {"index": 4, "kind": "click", "locator": "button \"Save\""}, "page": "/notes/new", "verdict": "passed", "stoppedAt": null, "failedChecks": [], "request": {"method": "POST", "path": "/api/notes", "template": "POST /api/notes", "n": 1, "nextAction": null}, "badInput": {"id": "spaces", "field": {"name": "label \"Title\"", "kind": "text", "key": "title"}, "preview": "spaces \"   \" (3 chars)", "length": 3, "held": {"length": 3, "cutBy": null}, "outcome": "rejected"}}, "key": {"badInput": "spaces", "page": "/notes/new", "request": "POST /api/notes", "field": "title"}, "nonFinding": null, "symptom": null},
  badCrashed: {"verdict": "failed", "checks": ["no-uncaught-error pass", "settles pass", "no-broken-text pass", "no-5xx-on-bad-input fail", "visible-error-message not-evaluated", "values-survive not-evaluated", "retry-recovers not-evaluated"], "step": 4, "page": "/notes/new", "control": "button \"Save\"", "notApplied": null, "givenUp": false, "events": [], "run": {"passed": true, "failure": null, "stoppedAt": null, "endedAfterWindow": true, "recovery": null, "timing": null, "fault": null, "badInput": {"notApplied": null, "outcome": "crashed", "submitDisabled": false, "submitted": true, "reference": 2, "after": 2, "carrying": "POST /api/notes 500"}, "outOfOrder": null, "pageTiming": null, "values": null, "steps": ["1 goto /notes/new?mode=crash true", "2 fill label \"Title\" true value", "3 fill label \"Body\" true value", "4 click button \"Save\" true"], "shots": [4]}, "record": {"kind": "bad-input", "step": {"index": 4, "kind": "click", "locator": "button \"Save\""}, "page": "/notes/new", "verdict": "failed", "stoppedAt": null, "failedChecks": ["no-5xx-on-bad-input"], "request": {"method": "POST", "path": "/api/notes", "template": "POST /api/notes", "n": 1, "nextAction": null}, "badInput": {"id": "spaces", "field": {"name": "label \"Title\"", "kind": "text", "key": "title"}, "preview": "spaces \"   \" (3 chars)", "length": 3, "held": {"length": 3, "cutBy": null}, "outcome": "crashed"}}, "key": {"badInput": "spaces", "page": "/notes/new", "request": "POST /api/notes", "field": "title"}, "nonFinding": null, "symptom": "POST /api/notes answers 500 to bad input spaces in label \"Title\""},
  badKept: {"verdict": "not-applied", "checks": [], "step": 4, "page": "/notes/new", "control": "button \"Save\"", "notApplied": "the field kept the flow's own value", "givenUp": false, "events": [], "run": {"passed": true, "failure": null, "stoppedAt": null, "endedAfterWindow": true, "recovery": null, "timing": null, "fault": null, "badInput": {"notApplied": "the field kept the flow's own value", "outcome": null, "submitDisabled": false, "submitted": false, "reference": 0, "after": 0, "carrying": null}, "outOfOrder": null, "pageTiming": null, "values": null, "steps": ["1 goto /notes/new?mode=plain true", "2 fill label \"Title\" true value"], "shots": []}, "record": {"kind": "bad-input", "step": {"index": 4, "kind": "click", "locator": "button \"Save\""}, "page": "/notes/new", "verdict": "not-applied", "stoppedAt": null, "failedChecks": [], "badInput": {"id": "long", "field": {"name": "label \"Body\"", "kind": "textarea", "key": "body"}, "preview": "long \"Some body-abcdefghi-abcdefghi-abcdefg...\" (10000 chars)", "length": 10000, "held": {"length": 9, "cutBy": null}, "outcome": null}}, "key": {"badInput": "long", "page": "/notes/new", "request": "POST /api/notes", "field": "body"}, "nonFinding": "Not applied: create-note/label \"Body\"/long (the field kept the flow's own value)", "symptom": null},
  viewport: {"verdict": "failed", "checks": ["no-uncaught-error pass", "settles pass", "no-broken-text pass", "no-overflow-375 fail"], "step": 1, "page": "/", "control": "viewport 375", "notApplied": null, "givenUp": false, "events": [], "run": {"passed": true, "failure": null, "stoppedAt": null, "endedAfterWindow": false, "recovery": null, "timing": null, "fault": null, "badInput": null, "outOfOrder": null, "pageTiming": null, "values": null, "steps": ["1 goto / true overflow 2", "2 click button \"Show\" true overflow 2"], "shots": [1]}, "record": {"kind": "viewport", "step": {"index": 1, "kind": "goto", "locator": null}, "page": "/", "verdict": "failed", "stoppedAt": null, "failedChecks": ["no-overflow-375"], "viewport": {"width": 375, "height": 800}}, "key": {"viewport": 375}, "nonFinding": null, "symptom": "/ scrolls sideways at 375px"},
};

// The group key, attack link and app check ids, taken from the code before
// these moved into the kind modules.
const SEAM = {
  fault500: {"groupKey": {"page": "/form", "step": "click", "action": "POST /api/save"}, "link": {"kind": "fault", "endpoints": ["POST /api/save"]}, "ids": ["500"]},
  keepArmed: {"groupKey": {"page": "/form", "step": "click", "action": "POST /api/save"}, "link": {"kind": "fault", "endpoints": ["POST /api/save"]}, "ids": ["500"]},
  malformed: {"groupKey": {"page": "/list", "step": "click", "action": "GET /api/list"}, "link": {"kind": "fault", "endpoints": ["GET /api/list"]}, "ids": ["malformed-json"]},
  double: {"groupKey": {"page": "/noguard", "step": "click", "action": "POST /api/notes"}, "link": {"kind": "timing", "endpoints": ["POST /api/notes"]}, "ids": ["double-submit"]},
  doubleStopped: {"groupKey": {"page": "/dup500", "step": "click", "action": "POST /api/once"}, "link": {"kind": "timing", "endpoints": ["POST /api/once"]}, "ids": ["double-submit"]},
  oooStale: {"groupKey": {"page": "/search", "step": "fill", "action": "field /search GET /api/search q"}, "link": {"kind": "timing", "endpoints": ["GET /api/search"]}, "ids": ["out-of-order"]},
  oooSame: {"groupKey": {"page": "/search", "step": "fill", "action": "field /search GET /api/search q"}, "link": {"kind": "timing", "endpoints": ["GET /api/search"]}, "ids": ["out-of-order"]},
  refresh: {"groupKey": {"page": "/new", "step": "click", "action": "refresh page /new"}, "link": {"kind": "timing", "endpoints": ["refresh page /new"]}, "ids": ["refresh"]},
  back: {"groupKey": {"page": "/new", "step": "click", "action": "back page /new"}, "link": {"kind": "timing", "endpoints": ["back page /new"]}, "ids": ["back"]},
  signedOut: {"groupKey": {"page": "/me", "step": "goto", "action": "signed-out-reload page /me"}, "link": {"kind": "timing", "endpoints": ["signed-out-reload page /me"]}, "ids": ["signed-out-reload"]},
  refreshPost: {"groupKey": {"page": "/posted", "step": "click", "action": "refresh page /new"}, "link": {"kind": "timing", "endpoints": ["refresh page /new"]}, "ids": ["refresh"]},
  badRejected: {"groupKey": {"page": "/notes/new", "step": "click", "action": "POST /api/notes"}, "link": {"kind": "bad-input", "endpoints": ["POST /api/notes"]}, "ids": ["spaces"]},
  badCrashed: {"groupKey": {"page": "/notes/new", "step": "click", "action": "POST /api/notes"}, "link": {"kind": "bad-input", "endpoints": ["POST /api/notes"]}, "ids": ["spaces"]},
  badKept: {"groupKey": {"page": "/notes/new", "step": "click", "action": "POST /api/notes"}, "link": {"kind": "bad-input", "endpoints": ["POST /api/notes"]}, "ids": ["long"]},
  viewport: {"groupKey": {"page": "/", "step": "goto", "action": "viewport 375"}, "link": {"kind": "viewport", "endpoints": []}, "ids": []},
};
for (const [name, seam] of Object.entries(SEAM)) Object.assign(PINNED[name], seam);
