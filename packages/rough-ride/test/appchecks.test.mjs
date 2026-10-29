import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import { baselineGate, evaluateCheck, judgeAppChecks, normText, pathMatches, shapeOf } from '../dist/appchecks.mjs';
import { symptom } from '../dist/attacks.mjs';
import { checkRank, checkSeverity } from '../dist/checks.mjs';
import { groupFindings, memberOf } from '../dist/groups.mjs';
import { parsePlan, validatePlan } from '../dist/plan.mjs';
import { judgeRun } from '../dist/regress.mjs';
import { buildTest } from '../dist/regression.mjs';

const SPEC = 'Notes\n\nIf the body is too long,   the message says\r\nthe body is too long.\nThe cafe\u0301 page shows version 1.2.3 of the notes.\nIf saving fails, the page stays on /notes/new.\n';
const flow = { name: 'create-note', signedIn: true, steps: [{ goto: '/notes/new' }, { fill: { label: 'Title' }, value: 'Note ${unique}' }, { fill: { label: 'Body' }, value: 'Body text' }, { click: { role: 'button', name: 'Save' } }, { expect: { text: 'Note ${unique}' } }] };
const facts = (over = {}) => ({
  specs: new Map([['notes', { text: SPEC, changed: false }]]),
  flows: new Set(['create-note']),
  footprint: () => ({ paths: ['/notes/new', '/notes'], requests: ['POST /api/notes #1', 'GET /api/notes #1'], steps: [{ label: 'Title' }, { label: 'Body' }, { role: 'button', name: 'Save' }], fills: ['Note ${unique}', 'Body text'] }),
  apiKeys: ['POST /api/notes'],
  baseline: () => ({ lines: ['New note', 'Title', 'Body', 'Save', 'Back to notes'], withinMatched: (l) => l.role === 'heading' }),
  ...over,
});
const cands = (over = {}) => ({
  tier: 'quick', aboveFlows: new Set(['create-note']), allFlows: new Set(['create-note']), selected: new Set(),
  fault: () => 'no', badInputs: () => 'no', viewport: () => 'no', checks: facts(), ...over,
});
const check = (over = {}) => ({
  id: 'app-body-too-long', flow: 'create-note',
  when: { attack: 'bad-input', field: { label: 'Body' }, outcome: 'refused' }, at: 'settled',
  assert: { text: 'body is too long', within: { role: 'alert' } },
  spec: 'notes', quote: 'If the body is too long, the message says the body is too long.', because: 'An overlong body gets a message about the body',
  ...over,
});
const lines = (checks, c = cands()) => validatePlan({ checks }, c).lines;

test('the quote check: NFC, CRLF and whitespace runs collapse; a quote not in the spec is rejected; a changed spec rejects its checks', () => {
  assert.deepEqual(lines([check()]), []);
  assert.deepEqual(lines([check({ quote: 'The caf\u00e9 page shows   version 1.2.3', assert: { outcome: 'refused' } })]), []);
  assert.deepEqual(lines([check({ quote: 'If the body is short, nothing happens.' })]), ['Rejected plan entry: checks[0] (quote not found in spec notes)']);
  assert.deepEqual(lines([check({ quote: 'too long' })]), ['Rejected plan entry: checks[0] (quote is 12 to 300 characters)']);
  const changed = cands({ checks: facts({ specs: new Map([['notes', { text: SPEC, changed: true }]]) }) });
  assert.deepEqual(lines([check()], changed), ['Rejected plan entry: checks[0] (spec notes changed since the plan was made)']);
  assert.equal(normText(' ae\u0301\n\n b '), 'a\u00e9 b');
});

test('Japanese with no spaces and Arabic with a bidi mark pass the quote check for quotes copied as \\uXXXX escapes', () => {
  const escape = (t) => [...t].map((ch) => (/[\x20-\x7e]/.test(ch) && ch !== '"' && ch !== '\\' ? ch : `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)).join('');
  const ja = '\u672c\u6587\u304c\u9577\u3059\u304e\u308b\u3068\u304d\u306f\u3001\u672c\u6587\u304c\u9577\u3059\u304e\u308b\u3068\u3044\u3046\u30e1\u30c3\u30bb\u30fc\u30b8\u3092\u8868\u793a\u3059\u308b\u3002';
  const ar = '\u0625\u0630\u0627 \u0643\u0627\u0646 \u0627\u0644\u0646\u0635 \u0637\u0648\u064a\u0644\u0627\u064b \u062c\u062f\u0627\u064b\u200f\u060c \u062a\u0638\u0647\u0631 \u0631\u0633\u0627\u0644\u0629 \u062e\u0637\u0623.';
  for (const [name, text, quote] of [['ja', `\u30e1\u30e2\n${ja}\n`, ja.slice(0, 20)], ['ar', `\u0645\u0644\u0627\u062d\u0638\u0627\u062a\n${ar}\n`, ar]]) {
    const yaml = `checks:\n  - id: app-${name}-message\n    flow: create-note\n    when: {attack: bad-input, outcome: refused}\n    at: settled\n    assert: {outcome: refused}\n    spec: ${name}\n    quote: "${escape(quote)}"\n    because: The spec asks for a refusal.\n`;
    const parsed = parsePlan(yaml, 'quick');
    assert.equal(parsed.refused, null, name);
    const r = validatePlan(parsed.input, cands({ checks: facts({ specs: new Map([[name, { text, changed: false }]]) }) }));
    assert.deepEqual(r.lines, [], name);
    assert.deepEqual(r.appChecks.map((c) => c.id), [`app-${name}-message`]);
  }
});

test('literals: dates and times are rejected, a version passes; the anchor gate disables text found nowhere', () => {
  const text = (t, extra = {}) => check({ when: { attack: 'bad-input' }, assert: { text: t, ...extra } });
  assert.deepEqual(lines([text('Saved on 2026-10-25')]), ['Rejected plan entry: checks[0] ("Saved on 2026-10-25" is shaped like a date or time, which follows the machine\'s time zone and locale)']);
  assert.deepEqual(lines([text('at 14:30')]), ['Rejected plan entry: checks[0] ("at 14:30" is shaped like a date or time, which follows the machine\'s time zone and locale)']);
  assert.deepEqual(lines([text('version 1.2.3', {})].map((c) => ({ ...c, quote: 'The caf\u00e9 page shows version 1.2.3 of the notes.' }))), []);
  assert.deepEqual(lines([text('Saved for good')]), ['App-specific check app-body-too-long: disabled (its text is in neither the quote nor a baseline run)']);
  assert.deepEqual(lines([text('Back to notes')]), []);
  assert.deepEqual(lines([text('Note ${unique}')]), []);
  assert.deepEqual(lines([text('ab')]), ['Rejected plan entry: checks[0] (a text literal is 3 to 200 characters)']);
  // An absent literal that is part of a fill value could be tripped by parallel attacks.
  assert.deepEqual(lines([check({ at: 'end', when: { attack: 'bad-input' }, assert: { text: 'Body text', absent: true } })]), ['Rejected plan entry: checks[0] (the absent text is part of a fill value of create-note)']);
  // In --check there is no baseline run, so the text anchor waits for attack.
  assert.deepEqual(lines([text('Saved for good')], cands({ checks: facts({ baseline: undefined }) })), []);
});

test('every-step takes absence only; settled needs an attacked step; outcome needs a bad input; anchors on paths and requests', () => {
  const es = (assert_) => check({ at: 'every-step', when: { attack: 'fault' }, assert: assert_ });
  assert.deepEqual(lines([es({ text: 'body is too long' })]), ['Rejected plan entry: checks[0] (every-step takes absence conditions only)']);
  assert.deepEqual(lines([es({ count: { of: { text: 'Note ${unique}' }, is: 1 } })]), ['Rejected plan entry: checks[0] (every-step takes absence conditions only)']);
  assert.deepEqual(lines([es({ path: { isNot: '/login' } }), { ...es({ requests: { key: 'POST /api/notes', status: '5xx', atMost: 0 } }), id: 'app-two' }]), []);
  assert.deepEqual(lines([check({ when: { attack: 'viewport' }, at: 'settled', assert: { path: { is: '/notes' } } })]), ['Rejected plan entry: checks[0] (at settled needs when.attack fault, bad-input or timing)']);
  assert.deepEqual(lines([check({ when: { attack: 'fault' }, assert: { outcome: 'refused' } })]), ['Rejected plan entry: checks[0] (assert.outcome needs when.attack bad-input and at settled)']);
  assert.deepEqual(lines([check({ when: { attack: 'fault', outcome: 'refused' } })]), ['Rejected plan entry: checks[0] (when.outcome refused needs when.attack bad-input)']);
  assert.deepEqual(lines([check({ when: { attack: 'fault' }, assert: { path: { is: '/elsewhere' } } })]), ['Rejected plan entry: checks[0] (path /elsewhere is neither a page create-note visited nor in the quote)']);
  assert.deepEqual(lines([check({ when: { attack: 'fault' }, quote: 'If saving fails, the page stays on /notes/new.', assert: { path: { is: '/notes/new' } } })]), []);
  assert.deepEqual(lines([check({ when: { attack: 'fault', point: 'DELETE /api/notes/{}' } })]), ['Rejected plan entry: checks[0] (DELETE /api/notes/{} is not an attack point of create-note)']);
  assert.deepEqual(lines([check({ assert: { count: { of: { role: 'listitem' }, atLeast: 1 } } })]), ['Rejected plan entry: checks[0] (a count locator contains ${unique})']);
  assert.deepEqual(lines([check({ assert: { text: '${env.SECRET} shown' } })]), ['Rejected plan entry: checks[0] (the only placeholder is ${unique})']);
  // An end check's within locator must match in a baseline run; a settled one's may appear only under attack.
  assert.deepEqual(lines([check({ at: 'end', when: { attack: 'bad-input' } })]), ['App-specific check app-body-too-long: disabled (its within locator role "alert" matches nothing in a baseline run)']);
});

test('the cap of 10, generic ids, duplicate ids, and no spec', () => {
  const eleven = Array.from({ length: 11 }, (_, i) => check({ id: `app-c${i}` }));
  const r = validatePlan({ checks: eleven }, cands());
  assert.deepEqual(r.lines, ['Rejected plan entry: checks[10] (over the check cap of 10)']);
  assert.equal(r.appChecks.length, 10);
  for (const id of ['no-uncaught-error', 'no-5xx-on-bad-input', 'settles', 'visible-error-message', 'no-broken-text', 'values-survive', 'one-write', 'retry-recovers', 'no-overflow-375', 'latest-response-wins']) {
    assert.deepEqual(lines([check({ id })]), [`Rejected plan entry: checks[0] (${id} is a generic check id)`]);
  }
  assert.deepEqual(lines([check(), check()]), ['Rejected plan entry: checks[1] (id app-body-too-long is used twice)']);
  const none = cands({ checks: facts({ specs: new Map() }) });
  assert.deepEqual(lines([check(), check({ id: 'app-other' })], none), [
    'Rejected plan entry: checks[0] (no spec: app-specific checks quote a spec file)',
    'Rejected plan entry: checks[1] (no spec: app-specific checks quote a spec file)',
  ]);
  // With no check facts at all, as in older callers, every check reads no spec.
  assert.deepEqual(lines([check()], cands({ checks: undefined })), ['Rejected plan entry: checks[0] (no spec: app-specific checks quote a spec file)']);
});

// A flow run with just what evaluation reads.
const obs = (lines, after = lines) => ({ before: { lines: [], live: [], labels: [] }, samples: [{ at: 1, lines, live: [] }], after: { lines: after, live: [], labels: [] }, unsettled: null, windowEndedAt: 0, startedAt: 0 });
const req = (over) => ({ step: 4, method: 'POST', url: 'http://localhost:8731/api/notes', key: 'POST /api/notes #1', resourceType: 'fetch', status: 201, failure: null, servedByFault: false, ...over });
const run = (over = {}) => ({
  unique: 'ab12cd34', failure: null, voided: null, excluded: null, endedAfterWindow: false, stoppedAt: null, recovery: null, fault: null, badInput: { outcome: 'rejected' },
  steps: [
    { index: 1, label: 'goto /notes/new', path: '/notes/new', observation: obs(['New note']) },
    { index: 2, label: 'fill label "Title"', path: '/notes/new', value: 'Note ab12cd34', observation: obs(['New note']) },
    { index: 3, label: 'fill label "Body"', path: '/notes/new', value: 'x'.repeat(30), observation: obs(['New note']) },
    { index: 4, label: 'click button "Save"', path: '/notes/new', observation: obs(['New note', 'Saving...'], ['New note', 'Check the title: it must be 1 to 200 characters.']) },
    { index: 5, label: 'expect text "Note ${unique}"', path: '/notes', observation: obs(['Notes', 'Note ab12cd34']) },
  ],
  requests: [req({ status: 422 }), req({ status: 500, servedByFault: true }), req({ step: 5, method: 'GET', key: 'GET /api/notes #1', url: 'http://localhost:8731/api/notes', status: 200 })],
  ...over,
});
const probe = (step, over = {}) => ({ step, end: false, recovery: false, requests: 3, records: step, path: step === 5 ? '/notes' : '/notes/new', within: {}, counts: {}, ...over });
const own = () => true;
const ev = (c, r = run(), probes = [], step = 4, outcome) => evaluateCheck({ ...check(), ...c }, { run: r, probes, step, outcome, ownHost: own });

test('text: present over the window, absent at the point, within the elements a locator matches', () => {
  assert.equal(ev({ assert: { text: 'Saving...' } }).result, 'pass');
  assert.deepEqual(ev({ assert: { text: 'body is too long' } }), { result: 'fail', reason: 'text "body is too long" (not visible)' });
  assert.deepEqual(ev({ assert: { text: 'Check the title', absent: true } }), { result: 'fail', reason: 'text "Check the title" absent (visible: "Check the title: it must be 1 to 200 characters.")' });
  assert.equal(ev({ assert: { text: 'Saving...', absent: true } }).result, 'pass');
  const alert = probe(4, { within: { 'role "alert"': ['Check the title: it must be 1 to 200 characters.'] } });
  assert.deepEqual(ev({}, run(), [alert]), { result: 'fail', reason: 'text "body is too long" within role "alert" (role "alert" showed "Check the title: it must be 1 to 200 characters.")' });
  assert.equal(ev({ assert: { text: 'the  title', within: { role: 'alert' } } }, run(), [alert]).result, 'pass');
  assert.deepEqual(ev({}, run(), [probe(4)]), { result: 'fail', reason: 'text "body is too long" within role "alert" (nothing matched role "alert")' });
  // The point is the end of the attacked step's window: a run that never got there is not evaluated.
  assert.equal(ev({}, run({ steps: run().steps.slice(0, 2) })).result, 'not-evaluated');
});

test('count, path and requests at the evaluation point; served fault responses never count', () => {
  const counted = probe(5, { end: true, counts: { 'text "Note ${unique}"': 2 } });
  assert.deepEqual(ev({ at: 'end', assert: { count: { of: { text: 'Note ${unique}' }, is: 1 } } }, run(), [counted]), { result: 'fail', reason: 'count of text "Note ${unique}" is 1 (counted 2 at the end)' });
  assert.equal(ev({ at: 'end', assert: { count: { of: { text: 'Note ${unique}' }, atLeast: 1 } } }, run(), [counted]).result, 'pass');
  assert.equal(ev({ assert: { path: { is: '/notes/new' } } }, run(), [probe(4)]).result, 'pass');
  assert.deepEqual(ev({ assert: { path: { is: '/notes/{}' } } }, run(), [probe(4, { path: '/notes' })]), { result: 'fail', reason: 'path is /notes/{} (the page was /notes)' });
  assert.ok(pathMatches('/notes/{}', '/notes/7') && !pathMatches('/notes/{}', '/notes/7/edit'));
  assert.equal(ev({ assert: { requests: { key: 'POST /api/notes', status: '5xx', is: 0 } } }, run(), [probe(4)]).result, 'pass');
  assert.deepEqual(ev({ assert: { requests: { key: 'POST /api/notes', status: '4xx', atMost: 0 } } }, run(), [probe(4)]), { result: 'fail', reason: 'requests POST /api/notes 4xx at most 0 (1 sent)' });
  // Requests from the attacked step's start to the point only.
  assert.equal(ev({ assert: { requests: { key: 'GET /api/notes', is: 0 } } }, run(), [probe(4, { requests: 2 })]).result, 'pass');
  assert.equal(ev({ at: 'end', assert: { requests: { key: 'GET /api/notes', is: 1 } } }, run(), [probe(5, { end: true })]).result, 'pass');
});

test('outcome, every-step, and end on a stopped run', () => {
  assert.equal(ev({ assert: { outcome: 'refused' } }, run(), [], 4, { cls: 'refused', shown: 'refused' }).result, 'pass');
  assert.deepEqual(ev({ assert: { outcome: 'refused' } }, run(), [], 4, { cls: 'accepted', shown: 'accepted' }), { result: 'fail', reason: 'outcome refused (the outcome was accepted)' });
  const steps = [1, 2, 3, 4, 5].map((s) => probe(s));
  assert.deepEqual(ev({ at: 'every-step', assert: { text: 'Saving...', absent: true } }, run(), steps).result, 'pass');
  assert.deepEqual(ev({ at: 'every-step', assert: { path: { isNot: '/notes' } } }, run(), steps), { result: 'fail', reason: 'path is not /notes (the page was /notes after step 5 (expect text "Note ${unique}"))' });
  assert.deepEqual(ev({ at: 'end', assert: { text: 'Saved' } }, run({ stoppedAt: 5 })), { result: 'not-evaluated', reason: 'the flow stopped at step 5' });
  assert.equal(ev({ at: 'end', assert: { text: 'Saved' } }, run({ endedAfterWindow: true })).result, 'not-evaluated');
});

test('the baseline gate: an end check failing with no attack prints its line and is no finding', () => {
  const c = check({ at: 'end', when: { attack: 'bad-input' }, assert: { text: 'Welcome back' } });
  assert.equal(baselineGate(c, run(), [], own), 'App-specific check app-body-too-long fails with no attack: text "Welcome back" (not visible at the end)');
  assert.equal(baselineGate({ ...c, assert: { text: 'Notes' } }, run(), [], own), null);
  assert.equal(baselineGate(check(), run(), [], own), null);
});

const attack = { id: 'create-note/label "Body"/long', flow: 'create-note', kind: 'bad-input', fault: null, template: 'POST /api/notes', step: 4, page: '/notes/new', control: 'button "Save"', badInput: { inputId: 'long', fillStep: 3, submitStep: 4, field: { name: 'label "Body"' } } };

test('judging an attack: when must match; an app failure ranks 9 at medium and reads as an app check symptom', () => {
  const alert = probe(4, { within: { 'role "alert"': ['Check the title: it must be 1 to 200 characters.'] } });
  const results = judgeAppChecks([check(), check({ id: 'app-title', when: { attack: 'bad-input', field: { label: 'Title' } } })], attack, flow, run(), [alert], 'passed', own);
  assert.deepEqual(results.map((r) => [r.id, r.result]), [['app-body-too-long', 'fail']]);
  assert.equal(results[0].app.spec, 'notes');
  // A fault attack never matches a bad-input check, and an outcome that didn't happen means no match.
  assert.deepEqual(judgeAppChecks([check()], { ...attack, kind: 'fault', fault: '500' }, flow, run(), [alert], 'passed', own), []);
  assert.deepEqual(judgeAppChecks([check()], attack, flow, run({ badInput: { outcome: 'accepted' } }), [alert], 'passed', own), []);
  assert.equal(checkRank('app-x'), 9);
  assert.ok(checkRank('no-broken-text') < 9 && 9 < checkRank('no-uncaught-error'));
  assert.equal(checkSeverity('app-x'), 'medium');
  const o = { ...attack, verdict: 'failed', checks: [{ id: 'no-uncaught-error', result: 'pass', evidence: 'ok' }, ...results], run: { ...run(), unique: 'ab12cd34', requests: [], pages: [] }, sticky: false, k: 0, key: 'POST /api/notes #1', diffLinked: false };
  assert.equal(symptom(o), 'App check app-body-too-long fails on /notes/new after bad input long in label "Body"');
  const [g] = groupFindings([memberOf(o, flow, new Map())], { flowClass: () => 'form' });
  assert.equal(g.severity, 'medium');
  assert.equal(g.lead, 'app-body-too-long');
});

test('a confirmed app finding is written inline in the test; regress reads an outcome mismatch as not evaluated', () => {
  const alert = probe(4, { within: { 'role "alert"': ['Check the title: it must be 1 to 200 characters.'] } });
  const results = judgeAppChecks([check()], attack, flow, run(), [alert], 'passed', own);
  const o = { ...attack, sticky: false, served: null, checks: results, run: { unique: 'ab12cd34', requests: [], badInput: { held: 'x'.repeat(10) } }, badInput: { ...attack.badInput, value: 'x'.repeat(10), preview: { text: 'xxx', length: 10 }, field: { name: 'label "Body"', kind: 'textarea', key: 'POST /api/notes body' } } };
  const t = buildTest(o, ['app-body-too-long'], { finding: 'f', run: '20261025-141207-quick-k3fz', runner: '0.1.0', date: '2026-10-25' });
  const written = parse(t.text).checks[0];
  assert.deepEqual(written, { id: 'app-body-too-long', at: 'settled', when: { outcome: 'refused' }, assert: { text: 'body is too long', within: { role: 'alert' } }, spec: 'notes', because: 'An overlong body gets a message about the body' });
  assert.ok(!('flow' in written) && !('quote' in written));
  // regress: the inline check, now that the long body is accepted.
  const inline = shapeOf(written, true);
  const now = judgeAppChecks([inline], attack, flow, run({ badInput: { outcome: 'accepted' } }), [alert], 'passed', own);
  assert.deepEqual(now.map((r) => [r.result, r.evidence]), [['not-evaluated', 'outcome now accepted; the check needs refused']]);
  const outcome = (extra) => ({ verdict: 'passed', checks: [...now, ...extra], run: { stoppedAt: null, fault: null }, kind: 'bad-input', id: 'x' });
  assert.deepEqual(judgeRun([written], outcome([])), { state: 'stale', reason: 'not evaluated (outcome now accepted; the check needs refused)', failed: [], alsoFailed: [] });
  assert.equal(judgeRun([written, 'settles'], outcome([{ id: 'settles', result: 'fail', evidence: 'e' }])).state, 'fail');
});
