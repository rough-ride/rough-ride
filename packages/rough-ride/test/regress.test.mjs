import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combine, judgeRun, resolveTest } from '../dist/regress.mjs';

const flow = { name: 'create-note', signedIn: true, steps: [{ goto: '/notes' }, { click: { role: 'link', name: 'New note' } }, { fill: { label: 'Title' }, value: 'x' }, { click: { role: 'button', name: 'Save' } }] };
const req = (over) => ({ step: 4, method: 'POST', url: 'http://localhost:8731/api/notes', key: 'POST /api/notes #1', resourceType: 'fetch', offsetMs: 10, navigation: false, pagePath: '/notes/new', status: 201, failure: null, mediaType: 'application/json', emptyBody: false, streaming: false, jsonRoot: 'object', credentialed: true, postData: '{"title":"x"}', oversize: false, servedByFault: false, ...over });
const baseline = (requests, pages = [{ path: '/notes', step: 1, entry: 'full-load', requests: [], previous: null, method: 'GET' }, { path: '/notes/new', step: 2, entry: 'in-app', requests: [], previous: '/notes', method: null }]) => ({
  requests, pages, steps: flow.steps.map((_, i) => ({ index: i + 1, path: i === 0 ? '/notes' : '/notes/new', label: '', settled: true, settleMs: 0, ...(i === 2 ? { value: 'x', field: { tag: 'input', type: 'text', inputmode: null, autocomplete: null, role: null, required: true, ariaRequired: false, maxlength: null, minlength: null, min: null, max: null, step: null, pattern: null, multiple: false, readonly: false, disabled: false, contenteditable: false, novalidate: false, visible: true, options: null, held: 'x' } } : {}), ...(i === 3 ? { control: { tag: 'button', type: 'submit', role: null, ariaPressed: null, ariaChecked: null, ariaExpanded: null } } : {}) })),
  formEvents: { submits: [], invalids: [] }, unique: 'tok12345',
});
const opts = { allowed: [], remoteTarget: null, signInFlow: false, today: new Date('2026-10-25') };
const fault = { fault: '500', sticky: true, request: 'POST /api/notes #1', page: '/notes/new' };

test('a fault test finds its request, or reads stale: not sent, moved to another page, or no longer sent from the browser', () => {
  assert.equal(resolveTest({ flow: 'create-note', attack: fault, checks: ['settles'] }, flow, baseline([req({})]), [], opts).attack.id, 'create-note/POST /api/notes #1/500!');
  assert.deepEqual(resolveTest({ flow: 'create-note', attack: fault, checks: [] }, flow, baseline([]), [], opts), { stale: 'fault never fired (POST /api/notes #1 not sent)' });
  assert.deepEqual(resolveTest({ flow: 'create-note', attack: fault, checks: [] }, flow, baseline([req({ pagePath: '/notes' })]), [], opts), { stale: 'attack point moved (POST /api/notes #1 is now sent on /notes, was /notes/new)' });
  const get = { fault: '500', sticky: true, request: 'GET /api/notes #1', page: '/notes' };
  assert.deepEqual(resolveTest({ flow: 'create-note', attack: get, checks: [] }, flow, baseline([]), [], opts), { stale: 'fault never fired: GET /api/notes is no longer sent from the browser on /notes (the flow enters it by full page load)' });
});

test('timing tests: a POST now sent by a fill step, and a page now entered by full load, read stale', () => {
  const ds = { timing: 'double-submit', request: 'POST /api/notes #1', page: '/notes/new' };
  assert.deepEqual(resolveTest({ flow: 'create-note', attack: ds, checks: [] }, flow, baseline([req({ step: 3 })]), [], opts), { stale: 'attack point moved (POST /api/notes #1 is no longer sent by a click or press step)' });
  const refresh = { timing: 'refresh', page: '/notes/new', entry: 1 };
  const fullLoad = baseline([], [{ path: '/notes/new', step: 1, entry: 'full-load', requests: [], previous: null, method: 'GET' }]);
  assert.deepEqual(resolveTest({ flow: 'create-note', attack: refresh, checks: [] }, flow, fullLoad, [], opts), { stale: 'attack point moved (/notes/new #1 is now entered by full page load)' });
  assert.deepEqual(resolveTest({ flow: 'create-note', attack: refresh, checks: [] }, flow, baseline([], []), [], opts), { stale: 'fault never fired (the flow no longer enters /notes/new)' });
});

test('only listed checks decide; a listed check failing in the baseline fails with no attack; others print as also failed', () => {
  const o = (checks, verdict = 'failed') => ({ verdict, checks: checks.map(([id, result]) => ({ id, result, evidence: 'e' })), run: { stoppedAt: null, fault: null }, kind: 'fault', id: 'x' });
  assert.deepEqual(judgeRun(['settles'], o([['settles', 'fail'], ['no-uncaught-error', 'fail']])), { state: 'fail', reason: null, failed: ['settles'], alsoFailed: ['no-uncaught-error'] });
  assert.equal(judgeRun(['settles'], o([['settles', 'pass'], ['no-uncaught-error', 'fail']])).state, 'pass');
  assert.deepEqual(judgeRun(['settles'], o([['settles', 'skipped-baseline']], 'passed')), { state: 'fail', reason: 'fails with no attack', failed: ['settles'], alsoFailed: [] });
  assert.equal(judgeRun(['settles'], o([], 'fault-never-fired')).state, 'stale');
  assert.equal(judgeRun([{ id: 'app-x' }, 'settles'], o([['settles', 'not-evaluated']], 'passed')).state, 'stale');
});

test('outcomes from two runs: pass, fail, flaky or stale; a stale run plus a failing one is fail', () => {
  const j = (state) => ({ state, reason: null, failed: [], alsoFailed: [] });
  assert.equal(combine(j('pass'), null), 'pass');
  assert.equal(combine(j('fail'), j('fail')), 'fail');
  assert.equal(combine(j('fail'), j('pass')), 'flaky');
  assert.equal(combine(j('stale'), j('stale')), 'stale');
  assert.equal(combine(j('stale'), j('fail')), 'fail');
});
