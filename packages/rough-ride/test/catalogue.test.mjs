import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCatalogue, fromRecord, planCandidates, resolveTest, toRecord } from '../dist/catalogue.mjs';
import { validatePlan } from '../dist/plan.mjs';
import { LOOPBACK_ONLY } from '../dist/hosts.mjs';
import { noteFlow, noteRun, req, signInFlow, signInRun } from './fixtures/catalogue-flows.mjs';

const TODAY = new Date('2026-10-25');

// create-note reaches a changed file from step 2 by the module rule; quick-note
// fills the same Title field on the same page; the sign-in flow goes last.
const flows = () => [
  { flow: noteFlow('create-note'), runs: [noteRun()], passed: true, reached: true, firstLoad: 2, reachesByRule: true },
  { flow: noteFlow('quick-note'), runs: [noteRun()], passed: true, reached: true },
  { flow: signInFlow, runs: [signInRun()], passed: true, reached: true },
];
const build = (tier, over = {}) => buildCatalogue({ tier, flows: flows(), docs: [], hosts: LOOPBACK_ONLY, today: TODAY, ...over });

const faults = (flow, request, list) => list.map((f) => `${flow}/${request}/${f}`);

test('quick: band 1 faults, double-submit, the first bad inputs and a viewport attack per reached flow, sign-in flow last', () => {
  const c = build('quick');
  assert.deepEqual(c.share.map((a) => a.id), [
    ...faults('create-note', 'GET /api/notes #1', ['500!', 'empty-200!']),
    ...faults('create-note', 'POST /api/notes #1', ['500!', 'reset!', 'double-submit']),
    'create-note/label "Title"/empty',
    'create-note/viewport-375',
    ...faults('quick-note', 'GET /api/notes #1', ['500!', 'empty-200!']),
    ...faults('quick-note', 'POST /api/notes #1', ['500!', 'reset!', 'double-submit']),
    'quick-note/viewport-375',
    ...faults('sign-in', 'POST /api/login #1', ['500!', 'reset!']),
  ]);
  assert.deepEqual(c.share.map((a) => a.closeness), [3, 3, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3]);
  assert.deepEqual(c.skipped, [
    'Skipped: empty-200 on POST /api/notes #1 (not a GET)',
    'Skipped: empty-200 on POST /api/notes #1 (not a GET)',
    'Skipped: empty-200 on POST /api/login #1 (not a GET)',
    'Skipped: double-submit on button "Sign in" (sign-in flow)',
  ]);
  assert.deepEqual(c.fieldsNotAttacked, ['Not attacked: label "Email" on /login (sign-in flow)', 'Not attacked: label "Password" on /login (sign-in flow)']);
});

test('standard: every band, page timing and the twelve inputs; the 401 skip on the sign-in flow appears only here', () => {
  const c = build('standard');
  const read = ['500!', 'empty-200!', '400!', 'reset!', '401!', '429!', 'malformed-json!', '500', 'delay-3s', 'hang!'];
  const write = ['500!', 'reset!', '400!', '401!', '429!', 'delay-3s', 'hang!', 'double-submit'];
  const pages = (flow) => [`${flow}/page /notes #1/signed-out-reload`, `${flow}/page /notes/new #1/refresh`, `${flow}/page /notes/new #1/signed-out-reload`, `${flow}/page /notes/new #1/back`];
  assert.deepEqual(c.share.map((a) => a.id), [
    ...faults('create-note', 'GET /api/notes #1', read),
    ...faults('create-note', 'POST /api/notes #1', write),
    ...pages('create-note'),
    ...['empty', 'spaces', 'specials', 'unicode', 'long'].map((i) => `create-note/label "Title"/${i}`),
    'create-note/viewport-375',
    ...faults('quick-note', 'GET /api/notes #1', read),
    ...faults('quick-note', 'POST /api/notes #1', write),
    ...pages('quick-note'),
    'quick-note/viewport-375',
    ...faults('sign-in', 'POST /api/login #1', ['500!', 'reset!', '400!', '429!', 'delay-3s', 'hang!']),
  ]);
  assert.deepEqual(c.skipped, [
    'Skipped: empty-200 on POST /api/notes #1 (not a GET)',
    'Skipped: malformed-json on POST /api/notes #1 (not a GET)',
    'Skipped: empty-200 on POST /api/notes #1 (not a GET)',
    'Skipped: malformed-json on POST /api/notes #1 (not a GET)',
    'Skipped: empty-200 on POST /api/login #1 (not a GET)',
    'Skipped: 401 on POST /api/login #1 (sign-in flow)',
    'Skipped: malformed-json on POST /api/login #1 (not a GET)',
    'Skipped: double-submit on button "Sign in" (sign-in flow)',
  ]);
});

test('no credential: signed-out-reload leaves the share and its Skipped line appears once, after the first flow that had one', () => {
  const c = build('standard', { noCredential: true });
  assert.ok(!c.share.some((a) => a.timing === 'signed-out-reload'));
  assert.deepEqual(c.skipped.slice(0, 4), [
    'Skipped: empty-200 on POST /api/notes #1 (not a GET)',
    'Skipped: malformed-json on POST /api/notes #1 (not a GET)',
    'Skipped: signed-out-reload (the session holds no credential the runner can remove or refuse)',
    'Skipped: empty-200 on POST /api/notes #1 (not a GET)',
  ]);
  assert.equal(c.skipped.filter((l) => l.startsWith('Skipped: signed-out-reload')).length, 1);
});

test('a field shared by two flows is attacked through the first only; unreached, failed or run-less flows add nothing', () => {
  for (const tier of ['quick', 'standard']) assert.ok(!build(tier).share.some((a) => a.flow === 'quick-note' && a.kind === 'bad-input'), tier);
  const others = buildCatalogue({
    tier: 'quick',
    flows: [
      { flow: noteFlow('create-note'), runs: [noteRun()], passed: true, reached: false },
      { flow: noteFlow('quick-note'), runs: [noteRun()], passed: false, reached: true },
      { flow: noteFlow('never-ran'), runs: [], passed: false, reached: true },
    ],
    docs: [],
    hosts: LOOPBACK_ONLY,
    today: TODAY,
  });
  assert.deepEqual([others.share, others.skipped, others.fieldsNotAttacked], [[], [], []]);
});

// The attack invocation's plan validation (45.4): the selected attacks above the cut and the flows they are on.
const scopeOf = (c) => ({ selected: c.share.map((a) => a.id), aboveFlows: new Set(c.share.map((a) => a.flow)) });
const entry = (over) => ({ flow: 'create-note', because: 'b', ...over });

test('plan entries resolve against the catalogue: unknown points, faults that do not apply, default and one-shot forms, viewport', () => {
  const c = build('quick');
  const r = validatePlan({ attacks: [
    entry({ fault: '500', request: 'POST /api/note #1' }),
    entry({ flow: 'sign-in', fault: '401', request: 'POST /api/login #1' }),
    entry({ fault: '500', request: 'POST /api/notes #1' }),
    entry({ fault: 'reset', request: 'POST /api/notes #1', oneShot: true }),
    entry({ fault: '500', request: 'GET /api/notes #1', oneShot: true }),
    entry({ fault: 'delay-3s', request: 'GET /api/notes #1' }),
    entry({ fault: '400', request: 'GET /api/notes #1' }),
    entry({ flow: 'sign-in', viewport: 375 }),
  ] }, planCandidates(c, scopeOf(c)));
  assert.deepEqual(r.lines, [
    'Rejected plan entry: attacks[0] (POST /api/note #1 is not an attack point of create-note)',
    'Rejected plan entry: attacks[1] (401 does not apply to POST /api/login #1)',
    'Rejected plan entry: attacks[2] (already selected)',
    'Rejected plan entry: attacks[7] (no viewport attack on the sign-in flow)',
  ]);
  assert.deepEqual(r.kept.map((a) => [a.id, a.sticky, a.rank]), [
    ['create-note/POST /api/notes #1/reset', false, 6],
    ['create-note/GET /api/notes #1/500', false, 17],
    ['create-note/GET /api/notes #1/delay-3s', false, 18],
    ['create-note/GET /api/notes #1/400!', true, 9],
  ]);
});

test('bad-input entries: the next inputs not already selected, named by carrying request or submit step; a field owned by an earlier flow is skipped', () => {
  const c = build('quick');
  const r = validatePlan({ attacks: [
    entry({ badInputs: 2, form: 'POST /api/notes' }),
    entry({ badInputs: 1, form: { submit: { role: 'button', name: 'Save' } } }),
    entry({ flow: 'quick-note', badInputs: 3, form: 'POST /api/notes' }),
    entry({ badInputs: 1, form: 'POST /api/other' }),
  ] }, planCandidates(c, scopeOf(c)));
  assert.deepEqual(r.entries.map((e) => [e.path, e.status, e.attackIds]), [
    ['attacks[0]', 'kept', ['create-note/label "Title"/spaces', 'create-note/label "Title"/specials']],
    ['attacks[1]', 'kept', ['create-note/label "Title"/unicode']],
    ['attacks[2]', 'already-selected', []],
    ['attacks[3]', 'rejected', []],
  ]);
  assert.equal(r.lines.at(-1), 'Rejected plan entry: attacks[3] (POST /api/other is not a form of create-note)');
  assert.ok(r.kept.every((a) => a.rank === 8 && a.badInput));
  const runless = buildCatalogue({ tier: 'quick', flows: [{ flow: noteFlow('never-ran'), runs: [], passed: false }], docs: [], hosts: LOOPBACK_ONLY, today: TODAY });
  const none = validatePlan({ attacks: [entry({ flow: 'never-ran', badInputs: 1, form: 'POST /api/notes' }), entry({ flow: 'never-ran', fault: '500', request: 'POST /api/notes #1' }), entry({ flow: 'never-ran', viewport: 375 })] }, planCandidates(runless, { selected: [], aboveFlows: ['never-ran'] }));
  assert.deepEqual(none.lines, ['Rejected plan entry: attacks[0] (never-ran has no baseline run)', 'Rejected plan entry: attacks[1] (POST /api/notes #1 is not an attack point of never-ran)']);
  assert.deepEqual(none.kept.map((a) => a.id), ['never-ran/viewport-375']);
});

// Every kind of entry on every flow, including ones that name nothing.
const everyEntry = () => {
  const out = [];
  for (const flow of ['create-note', 'quick-note', 'sign-in', 'never-ran', 'missing']) {
    for (const request of ['POST /api/notes #1', 'GET /api/notes #1', 'POST /api/login #1', 'POST /api/note #1']) {
      for (const fault of ['500', '400', '401', '429', 'malformed-json', 'empty-200', 'reset', 'hang', 'delay-3s']) {
        out.push(entry({ flow, fault, request }), entry({ flow, fault, request, oneShot: true }));
      }
    }
    for (const form of ['POST /api/notes', 'POST /api/login', 'POST /api/x', { submit: { role: 'button', name: 'Save' } }, { submit: { label: 'x' } }]) out.push(entry({ flow, badInputs: 12, form }));
    out.push(entry({ flow, viewport: 375 }));
  }
  return out;
};

test('round trip: a recorded catalogue resolves every entry to the same ids and refusals as the fresh one, and holds no bad-input value', () => {
  for (const tier of ['quick', 'standard']) {
    const fresh = buildCatalogue({ tier, flows: [...flows(), { flow: noteFlow('never-ran'), runs: [], passed: false }], docs: [], hosts: LOOPBACK_ONLY, today: TODAY });
    const scope = { selected: fresh.share.map((a) => a.id), aboveFlows: [...new Set(fresh.share.map((a) => a.flow)), 'never-ran'] };
    const text = JSON.stringify(toRecord(fresh, scope));
    for (const value of fresh.share.map((a) => a.badInput?.value ?? '').filter((v) => v.length >= 20)) assert.ok(!text.includes(value.slice(0, 20)), 'no bad-input value is recorded');
    if (tier === 'standard') assert.ok(fresh.share.some((a) => a.badInput?.value.length === 10_000));
    const recorded = fromRecord(JSON.parse(text));
    assert.deepEqual(recorded.scope, scope);
    const plain = (r) => ({ lines: r.lines, entries: r.entries, kept: r.kept.map((a) => [a.id, a.flow]) });
    for (const one of everyEntry()) {
      // One entry at a time, so the cap never decides.
      assert.deepEqual(plain(validatePlan({ attacks: [one] }, planCandidates(recorded.catalogue, recorded.scope))), plain(validatePlan({ attacks: [one] }, planCandidates(fresh, scope))), JSON.stringify(one));
    }
    assert.deepEqual(plain(validatePlan({ attacks: everyEntry() }, planCandidates(recorded.catalogue, recorded.scope))), plain(validatePlan({ attacks: everyEntry() }, planCandidates(fresh, scope))));
  }
  for (const bad of [null, [], { format: 2 }, { format: 1, tier: 'quick', flows: [{ name: 'a' }], fieldOwner: [], selected: [], aboveFlows: [] }]) assert.equal(fromRecord(bad), null);
});

// regress and repro: one flow's catalogue from this invocation's baseline run (25.3).
const testOn = (run) => buildCatalogue({ tier: 'standard', flows: [{ flow: noteFlow('create-note'), runs: [run], passed: true }], docs: [], hosts: LOOPBACK_ONLY, today: TODAY });
const resolve = (run, attack) => resolveTest(testOn(run), 'create-note', attack);
const fault = { fault: '500', sticky: true, request: 'POST /api/notes #1', page: '/notes/new' };

test('a fault test finds its request, or reads stale: not sent, moved to another page, or no longer sent from the browser', () => {
  assert.equal(resolve(noteRun({ requests: [req({})] }), fault).attack.id, 'create-note/POST /api/notes #1/500!');
  assert.deepEqual(resolve(noteRun({ requests: [] }), fault), { stale: 'fault never fired (POST /api/notes #1 not sent)' });
  assert.deepEqual(resolve(noteRun({ requests: [req({ pagePath: '/notes' })] }), fault), { stale: 'attack point moved (POST /api/notes #1 is now sent on /notes, was /notes/new)' });
  const get = { fault: '500', sticky: true, request: 'GET /api/notes #1', page: '/notes' };
  assert.deepEqual(resolve(noteRun({ requests: [] }), get), { stale: 'fault never fired: GET /api/notes is no longer sent from the browser on /notes (the flow enters it by full page load)' });
});

test('a fault test on a form the point no longer takes keeps its own fault and stickiness; a request with no point reads stale', () => {
  const once = resolve(noteRun({ requests: [req({})] }), { ...fault, fault: '429', sticky: false });
  assert.deepEqual([once.attack.id, once.attack.fault, once.attack.sticky], ['create-note/POST /api/notes #1/429', '429', false]);
  assert.deepEqual(resolve(noteRun({ requests: [req({ url: 'https://elsewhere.example/api/notes' })] }), fault), { stale: "fault never fired (POST /api/notes #1 can't take 500)" });
});

test('timing tests: a POST now sent by a fill step, and a page now entered by full load, read stale', () => {
  const ds = { timing: 'double-submit', request: 'POST /api/notes #1', page: '/notes/new' };
  assert.deepEqual(resolve(noteRun({ requests: [req({ step: 3 })] }), ds), { stale: 'attack point moved (POST /api/notes #1 is no longer sent by a click or press step)' });
  const refresh = { timing: 'refresh', page: '/notes/new', entry: 1 };
  const fullLoad = noteRun({ requests: [], pages: [{ path: '/notes/new', step: 1, entry: 'full-load', requests: [], previous: null, method: 'GET' }] });
  assert.deepEqual(resolve(fullLoad, refresh), { stale: 'attack point moved (/notes/new #1 is now entered by full page load)' });
  assert.deepEqual(resolve(noteRun({ requests: [], pages: [] }), refresh), { stale: 'fault never fired (the flow no longer enters /notes/new)' });
});

test("a bad-input test finds its field and input, passes when the browser's validation blocks the input, or reads stale", () => {
  const empty = { badInput: 'empty', page: '/notes/new', field: 'title' };
  const found = resolve(noteRun(), empty).attack;
  assert.deepEqual([found.id, found.rank], ['create-note/label "Title"/empty', 2]);
  const native = { ...noteRun(), formEvents: { submits: [{ step: 4, novalidate: false, formnovalidate: false }], invalids: [] } };
  assert.deepEqual(resolve(native, empty), { pass: "pass (blocked by the browser's validation: valueMissing)" });
  assert.deepEqual(resolve(noteRun(), { ...empty, field: 'body' }), { stale: 'field not found' });
});
