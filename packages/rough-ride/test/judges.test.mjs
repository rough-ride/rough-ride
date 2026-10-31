import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baselineFailures, judgeBadInput, judgeFault, judgeOutOfOrder, judgePageTiming, judgeTiming, judgeViewport } from '../dist/checks.mjs';

// Hand-built flow runs with just what judging reads; no browser.
const snap = (lines = [], over = {}) => ({ lines, live: [], labels: [], ...over });
const obs = ({ before = [], samples = [], after = [], unsettled = null } = {}) => ({
  before: snap(before), samples: samples.map(([at, lines]) => ({ at, lines, live: [] })), after: snap(after), unsettled, windowEndedAt: 0, startedAt: 0,
});
const step = (index, over = {}) => ({ index, label: index === 1 ? 'goto /notes/new' : `click button "Step ${index}"`, settled: true, settleMs: 600, path: '/notes/new', observation: obs(), ...over });
// Steps are copied, so a test can replace one without touching a shared fixture.
const run = (over = {}) => ({
  passed: true, failure: null, excluded: null, refused: null, requests: [], pages: [], durationMs: 0, dialogs: [],
  unique: 'ab12cd34', envFilled: [], aborted: [], pageEvents: [], voided: null, fault: null, endedAfterWindow: false, timing: null, stoppedAt: null,
  recovery: null, shots: new Map(), formEvents: { submits: [], invalids: [] }, badInput: null, outOfOrder: null, pageTiming: null, values: null,
  storageState: null, untrustedStop: null, ...over, steps: [...(over.steps ?? [step(1), step(2), step(3)])],
});
const event = (step, text, kind = 'exception') => ({ step, at: 0, kind, text });

// Results in the key order the report writes them.
const pass = (id) => ({ id, result: 'pass', evidence: 'ok' });
const fail = (id, evidence, token) => ({ id, result: 'fail', evidence, ...(token ? { token } : {}) });
const skip = (id) => ({ id, result: 'skipped-baseline', evidence: 'fails with no attack' });
const notEvaluated = (id, why) => ({ id, result: 'not-evaluated', evidence: why });

// Byte-identical, key order included, as summary.json and record.json carry it.
const same = (actual, expected) => assert.equal(JSON.stringify(actual), JSON.stringify(expected));

// The baseline: a known console error at step 2, an unsettled step 3 and a broken line it already showed.
const baseline = run({
  pageEvents: [event(2, 'known warning', 'console')],
  steps: [step(1), step(2, { observation: obs({ after: ['Total: NaN'] }) }), step(3, { settled: false })],
});
// What baseline already had, and nothing else: every generic check passes.
const quiet = {
  pageEvents: [event(2, 'known warning', 'console')],
  steps: [step(1), step(2, { observation: obs({ after: ['Total: NaN'] }) }), step(3, { settled: false })],
};
// One new error, one new unsettled step and one new broken line.
const noisy = {
  pageEvents: [event(2, 'known warning', 'console'), event(3, 'TypeError: x is undefined')],
  steps: [
    step(1),
    step(2, { settled: false, settleMs: 10_234, value: 'typed undefined', observation: obs({ after: ['Total: NaN', 'typed undefined', 'Hello undefined'], unsettled: 'busy indicator visible' }) }),
    step(3, { settled: false }),
  ],
};
const ALL = new Set(['no-uncaught-error', 'settles', 'no-broken-text']);

const FAULT = { fired: true, events: [], firedAt: 1000, notApplied: null, pending: false, givenUp: false, absorbed: false, served: null, holdMs: 0 };
const BAD = { notApplied: null, held: null, linesBefore: [], reference: [], after: [], submitDisabled: false, submittedAt: 1, outcome: 'accepted', carrying: null };
const OOO = { notApplied: null, aborted: false, releasedAt: null, linesBefore: [], olderOnly: null, newerOnly: null };
const PAGE = { notApplied: null, events: [{ at: 1, event: 'reloaded 200' }], documentStatus: 200, navigationError: null, removed: 0, served401: 0 };

// Each kind with the state that passes its own gates.
const kinds = {
  fault: (r, b, skipped) => judgeFault(run({ fault: FAULT, ...r }), b, 2, skipped, '500'),
  viewport: (r, b, skipped) => judgeViewport(run(r), b, skipped),
  timing: (r, b, skipped) => judgeTiming(run({ timing: { actionAt: 1, action: 'double-clicked' }, ...r }), b, 2, skipped, () => true),
  'bad-input': (r, b, skipped) => judgeBadInput(run({ badInput: BAD, ...r }), b, 2, skipped),
  'out-of-order': (r, b, skipped) => judgeOutOfOrder(run({ outOfOrder: OOO, ...r }), b, 2, skipped),
  'page timing': (r, b, skipped) => judgePageTiming(run({ pageTiming: PAGE, ...r }), b, skipped, []),
};
const generic = (judged) => judged.checks.filter((c) => ALL.has(c.id));

test('every kind judges no-uncaught-error, settles and no-broken-text against the baseline run the same way', () => {
  for (const [kind, judge] of Object.entries(kinds)) {
    same([kind, generic(judge(quiet, baseline, new Set()))], [kind, [pass('no-uncaught-error'), pass('settles'), pass('no-broken-text')]]);
    same([kind, generic(judge(noisy, baseline, new Set()))], [kind, [
      fail('no-uncaught-error', 'exception: TypeError: x is undefined'),
      fail('settles', kind === 'page timing' ? 'click button "Step 2": busy indicator visible' : 'click button "Step 2": busy indicator visible after 10.2 s'),
      fail('no-broken-text', '"undefined" in a new line', 'undefined'),
    ]]);
    same([kind, generic(judge(noisy, baseline, ALL))], [kind, [skip('no-uncaught-error'), skip('settles'), skip('no-broken-text')]]);
    same([kind, judge({ ...noisy, voided: 'target unstable' }, baseline, new Set()).verdict], [kind, 'void']);
  }
});

test('a generic check failure fails every kind, and the same error at another step is new', () => {
  for (const [kind, judge] of Object.entries(kinds)) {
    const moved = judge({ ...quiet, pageEvents: [event(3, 'known warning', 'console')] }, baseline, new Set());
    same([kind, moved.verdict, generic(moved)[0]], [kind, 'failed', fail('no-uncaught-error', 'console: known warning')]);
  }
});

test('settles evidence without an observation reads did not settle', () => {
  const steps = [step(1), step(2, { settled: false, settleMs: 30_000, observation: undefined }), step(3)];
  same(generic(kinds.viewport({ steps }, run(), new Set()))[1], fail('settles', 'click button "Step 2": did not settle after 30 s'));
});

test('judgeFault: gates, then the checks in report order', () => {
  same(judgeFault(run({ voided: 'dev server reloaded', fault: FAULT }), baseline, 2, new Set()), { verdict: 'void', checks: [] });
  same(judgeFault(run(), baseline, 2, new Set()), { verdict: 'fault-never-fired', checks: [] });
  same(judgeFault(run({ fault: { ...FAULT, fired: false } }), baseline, 2, new Set()), { verdict: 'fault-never-fired', checks: [] });
  same(judgeFault(run({ fault: { ...FAULT, notApplied: 'no request matched' } }), baseline, 2, new Set()), { verdict: 'not-applied', checks: [] });

  // A told 500 with a new message after it fired.
  const shown = run({ ...quiet, fault: FAULT });
  shown.steps[1] = step(2, { observation: obs({ before: ['Title'], samples: [[900, ['Saving']], [1200, ['Could not save']]], after: ['Total: NaN'] }) });
  same(judgeFault(shown, baseline, 2, new Set()), { verdict: 'passed', checks: [
    pass('no-uncaught-error'), pass('settles'), pass('visible-error-message'),
    notEvaluated('values-survive', 'not a click submit step'), pass('no-broken-text'),
    notEvaluated('retry-recovers', 'no recovery after this fault'),
  ] });

  // Text shown only before the fault fired is no message; a lost value and a failed recovery.
  const silent = run({ ...quiet, fault: FAULT, values: [{ field: 'label "Title"', before: 'Hello', after: '', password: false }, { field: 'label "Password"', before: 'x', after: '', password: true }], recovery: { action: 'click', passed: false, detail: 'step 3 failed' } });
  silent.steps[1] = step(2, { observation: obs({ samples: [[900, ['Saving']]] }) });
  same(judgeFault(silent, baseline, 2, new Set()), { verdict: 'failed', checks: [
    pass('no-uncaught-error'), pass('settles'),
    fail('visible-error-message', 'no new visible text after the failed request'),
    fail('values-survive', 'label "Title" held "Hello", then "" after the failed request'),
    pass('no-broken-text'),
    fail('retry-recovers', 'step 3 failed'),
  ] });
  same(judgeFault(silent, baseline, 2, new Set(['visible-error-message'])).checks[2], skip('visible-error-message'));
  same(judgeFault({ ...silent, recovery: { action: null, passed: false, detail: null } }, baseline, 2, new Set()).checks[5], fail('retry-recovers', 'the flow did not reach its goal'));
  same(judgeFault({ ...silent, dialogs: ['alert: failed'], recovery: { action: 'click', passed: true, detail: null } }, baseline, 2, new Set()).checks.map((c) => c.result), ['pass', 'pass', 'pass', 'fail', 'pass', 'pass']);

  // A 401 that moved to the sign-in page counts as a message; a 401 never recovers.
  const moved = run({ ...quiet, fault: FAULT, recovery: { action: 'click', passed: true, detail: null } });
  moved.steps[1] = step(2, { path: '/login' });
  same(judgeFault(moved, baseline, 2, new Set(), '401').checks.slice(2), [
    pass('visible-error-message'), notEvaluated('values-survive', 'not a click submit step'), pass('no-broken-text'),
    notEvaluated('retry-recovers', 'no recovery after this fault'),
  ]);
});

test('judgeFault: a Pending hang, an absorbed one-shot and a fault that delivered a 2xx', () => {
  const pending = judgeFault(run({ ...quiet, fault: { ...FAULT, pending: true } }), baseline, 2, new Set(), 'hang');
  same(pending, { verdict: 'pending', checks: [
    pass('no-uncaught-error'), notEvaluated('settles', 'pending hang'), notEvaluated('visible-error-message', 'pending hang'),
    notEvaluated('values-survive', 'pending hang'), pass('no-broken-text'), notEvaluated('retry-recovers', 'pending hang'),
  ] });
  // Not evaluated beats skipped: a Pending hang never reads skipped-baseline for settles.
  same(judgeFault(run({ ...quiet, fault: { ...FAULT, pending: true } }), baseline, 2, ALL, 'hang').checks[1], notEvaluated('settles', 'pending hang'));
  const pendingError = judgeFault(run({ ...noisy, fault: { ...FAULT, pending: true } }), baseline, 2, new Set(), 'hang');
  same([pendingError.verdict, pendingError.checks[1]], ['failed', notEvaluated('settles', 'pending hang')]);

  same(judgeFault(run({ ...quiet, fault: { ...FAULT, absorbed: true } }), baseline, 2, new Set()).checks.slice(2), [
    notEvaluated('visible-error-message', 'a client retry absorbed the one-shot fault'), notEvaluated('values-survive', 'the fault was not told'),
    pass('no-broken-text'), notEvaluated('retry-recovers', 'no recovery after this fault'),
  ]);
  same(judgeFault(run({ ...quiet, fault: FAULT, values: [] }), baseline, 2, new Set(), 'malformed-json').checks.slice(2, 4), [
    notEvaluated('visible-error-message', 'the fault delivered a 2xx'), notEvaluated('values-survive', 'the fault was not told'),
  ]);
  // A delay the page gave up on is told and recoverable.
  const gaveUp = judgeFault(run({ ...quiet, fault: { ...FAULT, givenUp: true }, recovery: { action: 'click', passed: true, detail: null } }), baseline, 2, new Set(), 'delay-3s');
  same(gaveUp.checks.at(-1), pass('retry-recovers'));
});

test('judgeViewport: no-overflow-375 last, and the judged step is the first that overflowed', () => {
  const wide = [step(1, { overflowPx: 1 }), step(2, { overflowPx: 40 }), step(3, { overflowPx: 80, path: null })];
  same(judgeViewport(run({ steps: wide, voided: 'target unstable' }), baseline, new Set()), { verdict: 'void', checks: [], step: 2 });
  same(judgeViewport(run({ ...quiet, steps: quiet.steps.map((s, i) => ({ ...s, overflowPx: i === 1 ? 40 : 0 })) }), baseline, new Set()), { verdict: 'failed', checks: [
    pass('no-uncaught-error'), pass('settles'), pass('no-broken-text'),
    fail('no-overflow-375', '/notes/new is 40 px wider than the 375 px viewport after click button "Step 2"'),
  ], step: 2 });
  same(judgeViewport(run({ steps: [step(1), step(2, { overflowPx: 80, path: null })] }), run(), new Set()).checks[3], fail('no-overflow-375', 'the page is 80 px wider than the 375 px viewport after click button "Step 2"'));
  same(judgeViewport(run({ steps: [step(1, { overflowPx: 1 })] }), run(), new Set(['no-overflow-375'])), { verdict: 'passed', checks: [
    pass('no-uncaught-error'), pass('settles'), pass('no-broken-text'), skip('no-overflow-375'),
  ], step: null });
});

const write = (over) => ({ step: 2, method: 'POST', url: 'http://localhost:3000/api/notes', key: 'POST /api/notes #1', resourceType: 'fetch', status: 201, failure: null, servedByFault: false, body: { id: 1, title: 'a' }, ...over });

test('judgeTiming: one-write first, then the generic checks', () => {
  const t = { actionAt: 1, action: 'double-clicked' };
  same(judgeTiming(run({ timing: t, voided: 'target unstable' }), baseline, 2, new Set(), () => true), { verdict: 'void', checks: [] });
  same(judgeTiming(run(), baseline, 2, new Set(), () => true), { verdict: 'fault-never-fired', checks: [] });
  const once = run({ requests: [write()] });
  const twice = run({ ...quiet, timing: t, requests: [write(), write({ key: 'POST /api/notes #2', body: { id: 2, title: 'a' } })] });
  same(judgeTiming(twice, { ...baseline, requests: once.requests }, 2, new Set(), () => true), { verdict: 'failed', checks: [
    fail('one-write', 'one-write: 2 successful POST /api/notes (the baseline run sent 1) (if this control is a toggle, give it aria-pressed)'),
    pass('no-uncaught-error'), pass('settles'), pass('no-broken-text'),
  ] });
  same(judgeTiming(twice, { ...baseline, requests: once.requests }, 2, new Set(), () => false).checks[0], pass('one-write'));
  same(judgeTiming(twice, { ...baseline, requests: once.requests }, 2, new Set(['one-write']), () => true).checks[0], skip('one-write'));
});

test('judgeBadInput: gates, the generic checks, no-5xx-on-bad-input, then the refusal checks', () => {
  const bad = (over, r = {}) => run({ ...quiet, badInput: { ...BAD, ...over }, ...r });
  same(judgeBadInput(bad({}, { voided: 'target unstable' }), baseline, 2, new Set()), { verdict: 'void', checks: [] });
  same(judgeBadInput(run(), baseline, 2, new Set()), { verdict: 'not-applied', checks: [] });
  same(judgeBadInput(bad({ notApplied: 'the field is read-only' }), baseline, 2, new Set()), { verdict: 'not-applied', checks: [] });
  same(judgeBadInput(bad({ outcome: null }), baseline, 2, new Set()), { verdict: 'void', checks: [] });
  same(judgeBadInput(bad({ outcome: 'inconclusive' }), baseline, 2, new Set()), { verdict: 'inconclusive', checks: [] });

  const carrying = { method: 'POST', path: '/api/notes', status: 500, failure: null };
  same(judgeBadInput(bad({ outcome: 'crashed', carrying }), baseline, 2, new Set()), { verdict: 'failed', checks: [
    pass('no-uncaught-error'), pass('settles'), pass('no-broken-text'),
    fail('no-5xx-on-bad-input', 'POST /api/notes answered 500 after the bad input'),
    notEvaluated('visible-error-message', 'outcome crashed'), notEvaluated('values-survive', 'outcome crashed'), notEvaluated('retry-recovers', 'outcome crashed'),
  ] });
  same(judgeBadInput(bad({ outcome: 'crashed' }), baseline, 2, new Set()).checks[3], fail('no-5xx-on-bad-input', 'a request answered no response after the bad input'));

  // Rejected: a new line after the submit; the attacked field lost its value; recovery passed.
  const reference = [{ field: 'label "Title"', value: 'Hello', password: false }, { field: 'label "Password"', value: 'secret', password: true }];
  const after = [{ field: 'label "Title"', value: '', password: false }, { field: 'label "Password"', value: '', password: true }];
  const rejected = bad({ outcome: 'rejected', carrying: { ...carrying, status: 422 }, linesBefore: ['Title'], reference, after }, { recovery: { action: 'fill', passed: true, detail: null } });
  rejected.steps[1] = step(2, { observation: obs({ samples: [[5, ['Title must be short']]], after: ['Total: NaN'] }) });
  same(judgeBadInput(rejected, baseline, 2, new Set()), { verdict: 'failed', checks: [
    pass('no-uncaught-error'), pass('settles'), pass('no-broken-text'), pass('no-5xx-on-bad-input'),
    pass('visible-error-message'),
    fail('values-survive', 'label "Title" held 5 chars before the submit, then 0'),
    pass('retry-recovers'),
  ] });
  const unshown = bad({ outcome: 'rejected', carrying: { ...carrying, status: 422 }, linesBefore: ['Total: NaN'] });
  same(judgeBadInput(unshown, baseline, 2, new Set()).checks.slice(4), [
    fail('visible-error-message', 'no new visible text after POST /api/notes answered 422'),
    notEvaluated('values-survive', 'not a click or press submit'), notEvaluated('retry-recovers', 'no recovery ran'),
  ]);
  same(judgeBadInput(bad({ outcome: 'rejected', linesBefore: ['Total: NaN'] }), baseline, 2, new Set()).checks[4], fail('visible-error-message', 'no new visible text after the submit answered nothing'));
  same(judgeBadInput(bad({ outcome: 'rejected', linesBefore: ['Total: NaN'] }, { dialogs: ['alert: too long'] }), baseline, 2, new Set()).checks[4], pass('visible-error-message'));
  same(judgeBadInput(bad({ outcome: 'silent-refusal' }, { recovery: { action: 'fill', passed: false, detail: null } }), baseline, 2, new Set()).checks.slice(4), [
    fail('visible-error-message', 'the submit ran, nothing was sent and no message appeared'),
    notEvaluated('values-survive', 'not a click or press submit'), fail('retry-recovers', 'the flow did not reach its goal'),
  ]);
  same(judgeBadInput(bad({ outcome: 'blocked-by-browser' }), baseline, 2, new Set()).checks[4], pass('visible-error-message'));
  same(judgeBadInput(bad({ outcome: 'blocked-by-app' }), baseline, 2, new Set(['visible-error-message'])).checks[4], skip('visible-error-message'));
  same(judgeBadInput(bad({ outcome: 'accepted' }), baseline, 2, new Set()).verdict, 'passed');
});

test('judgeOutOfOrder: latest-response-wins first; an AbortError after the page aborted never counts', () => {
  const ooo = (over, r = {}) => run({ ...quiet, outOfOrder: { ...OOO, ...over }, ...r });
  same(judgeOutOfOrder(ooo({}, { voided: 'target unstable' }), baseline, 2, new Set()), { verdict: 'void', checks: [] });
  same(judgeOutOfOrder(run(), baseline, 2, new Set()), { verdict: 'not-applied', checks: [] });
  same(judgeOutOfOrder(ooo({ notApplied: 'no carrying request' }), baseline, 2, new Set()), { verdict: 'not-applied', checks: [] });
  same(judgeOutOfOrder(ooo({}), baseline, 2, new Set()), { verdict: 'passed', checks: [
    pass('latest-response-wins'), pass('no-uncaught-error'), pass('settles'), pass('no-broken-text'),
  ] });

  const leaves = { releasedAt: 100, olderOnly: ['Older note'], newerOnly: ['Newer note'] };
  const appeared = ooo({ ...leaves, linesBefore: ['Newer note'] });
  appeared.steps[1] = step(2, { observation: obs({ samples: [[50, ['Older note early']], [150, ['Older note']]], after: ['Newer note'] }) });
  same(judgeOutOfOrder(appeared, baseline, 2, new Set()).checks[0], fail('latest-response-wins', 'latest-response-wins: "Older note" from the older answer appeared after the newer one'));
  const gone = ooo({ ...leaves, linesBefore: ['Newer note'] });
  gone.steps[1] = step(2, { observation: obs({ after: ['Something else'] }) });
  same(judgeOutOfOrder(gone, baseline, 2, new Set()).checks[0], fail('latest-response-wins', 'latest-response-wins: "Newer note" from the newer answer disappeared when the older one arrived'));
  const stopped = ooo({}, { stoppedAt: 3, failure: { step: 3, label: 'expect text "Saved"', message: 'Timed out\nwaiting for text' } });
  same(judgeOutOfOrder(stopped, baseline, 2, new Set()).checks[0], fail('latest-response-wins', 'latest-response-wins: step 3 failed after the older answer arrived: Timed out'));
  same(judgeOutOfOrder(stopped, baseline, 2, new Set(['latest-response-wins'])).checks[0], skip('latest-response-wins'));

  const abortEvents = [...quiet.pageEvents, event(2, 'Uncaught (in promise) AbortError: The user aborted a request.')];
  same(judgeOutOfOrder(ooo({ aborted: true }, { pageEvents: abortEvents }), baseline, 2, new Set()).checks[1], pass('no-uncaught-error'));
  same(judgeOutOfOrder(ooo({ aborted: false }, { pageEvents: abortEvents }), baseline, 2, new Set()).checks[1], fail('no-uncaught-error', 'exception: Uncaught (in promise) AbortError: The user aborted a request.'));
});

test('judgePageTiming: gates, the document additions and full-load errors, and the runner\'s own steps', () => {
  const page = (over, r = {}, fullLoad = []) => judgePageTiming(run({ ...quiet, pageTiming: { ...PAGE, ...over }, ...r }), baseline, new Set(), fullLoad);
  same(page({}, { voided: 'target unstable' }), { verdict: 'void', checks: [] });
  same(judgePageTiming(run(), baseline, new Set(), []), { verdict: 'not-applied', checks: [] });
  same(page({ notApplied: 'the reload would resend a form post' }), { verdict: 'not-applied', checks: [] });
  same(page({ events: [] }), { verdict: 'fault-never-fired', checks: [] });
  same(page({}), { verdict: 'passed', checks: [pass('no-uncaught-error'), pass('settles'), pass('no-broken-text')] });

  const loadError = [...quiet.pageEvents, event(3, 'Hydration failed')];
  same(page({ documentStatus: 500 }, { pageEvents: loadError }).checks[0], fail('no-uncaught-error', 'the document answered 500 after the runner\'s navigation'));
  same(page({ documentStatus: 500 }, { pageEvents: loadError }, ['document 500']).checks[0], fail('no-uncaught-error', 'exception: Hydration failed'));
  same(page({ documentStatus: 500 }, { pageEvents: loadError }, ['document 500', 'Hydration failed']).checks[0], pass('no-uncaught-error'));
  same(page({ documentStatus: null, navigationError: 'net::ERR_TOO_MANY_REDIRECTS' }).checks[0], fail('no-uncaught-error', 'the navigation failed with net::ERR_TOO_MANY_REDIRECTS'));
  same(page({ documentStatus: null, navigationError: 'net::ERR_TOO_MANY_REDIRECTS' }, {}, ['net::ERR_TOO_MANY_REDIRECTS']).checks[0], pass('no-uncaught-error'));

  // The runner's reload shares the entry step's index; it is judged even where the baseline step did not settle.
  const reload = (over) => step(3, { label: 'reload', settled: false, settleMs: 10_400, observation: obs(over) });
  same(page({}, { steps: [...quiet.steps, reload({ unsettled: 'busy indicator visible' })] }).checks[1], fail('settles', 'reload: busy indicator visible'));
  same(page({}, { steps: [...quiet.steps, reload({ unsettled: 'not ready 30 s after the reload' })] }).checks[1], fail('settles', 'reload: not ready 30 s after the reload'));
  same(page({}, { steps: [...quiet.steps, { ...reload({ unsettled: 'busy indicator visible' }), label: 'go back' }] }).checks[1], fail('settles', 'go back: busy indicator visible'));
});

test('baselineFailures: the first page event, the first unsettled step and the first broken line, with their pages', () => {
  same(baselineFailures(run()), []);
  same(baselineFailures(run({
    pageEvents: [event(2, 'TypeError: a'), event(3, 'TypeError: b')],
    steps: [
      step(1, { value: 'typed NaN', observation: obs({ after: ['typed NaN'] }) }),
      step(2, { settled: false, path: '/notes' }),
      step(3, { settled: false, path: '/notes/3', observation: obs({ samples: [[1, ['Created Invalid Date']]] }) }),
    ],
  })), [
    { id: 'no-uncaught-error', step: 2, page: '/notes' },
    { id: 'settles', step: 2, page: '/notes' },
    { id: 'no-broken-text', step: 3, page: '/notes/3' },
  ]);
  same(baselineFailures(run({ pageEvents: [event(9, 'late')] })), [{ id: 'no-uncaught-error', step: 9, page: null }]);
});
