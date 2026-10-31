import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupLines } from '../dist/attacks.mjs';
import { CHECK_RANK, CHECK_SEVERITY } from '../dist/checks.mjs';
import { pagePath } from '../dist/flowrun.mjs';
import { confirmGroups, groupFindings, memberOf, SEVERITY_TEXT } from '../dist/groups.mjs';

const flows = {
  'sign-in': { name: 'sign-in', signedIn: false, steps: [{ goto: '/login' }, { fill: { label: 'Email' }, value: 'x' }, { click: { role: 'button', name: 'Sign in' } }] },
  'create-note': { name: 'create-note', signedIn: true, steps: [{ goto: '/notes/new' }, { fill: { label: 'Title' }, value: 'x' }, { click: { role: 'button', name: 'Save' } }] },
};

let n = 0;
// A failed attack outcome as the tier records it, with just the fields grouping reads.
function outcome({ flow = 'create-note', kind = 'fault', fault = '500', sticky = true, key = 'POST /api/notes #1', step = 3, page = '/notes/new', failed = [], diffLinked = false, id, text = [], badInput }) {
  n++;
  const template = key.replace(/ #\d+$/, '');
  const unique = `tok${String(n).padStart(4, '0')}`;
  return {
    id: id ?? `${flow}/${key}/${fault ?? kind}${sticky ? '!' : ''}`,
    flow, kind, fault, sticky, rank: 1, key, template, step, k: 1, diffLinked, closeness: 3, page,
    ...(badInput ? { badInput } : {}),
    control: 'button "Save"',
    verdict: failed.length > 0 ? 'failed' : 'passed',
    checks: ['one-write', 'visible-error-message', 'settles', 'values-survive', 'retry-recovers', 'no-uncaught-error']
      .map((c) => ({ id: c, result: failed.includes(c) ? 'fail' : 'pass', evidence: failed.includes(c) ? `${c} failed` : 'ok' })),
    events: [], voided: null, served: null, notApplied: null, givenUp: false,
    run: {
      unique,
      requests: [{ step, key, method: template.split(' ')[0], url: `http://localhost:3731${template.split(' ')[1]}`, pagePath: page, postData: null, resourceType: 'fetch' }],
      pages: [],
      steps: [{ index: step, path: page, observation: { before: { lines: [] }, after: { lines: text } } }],
      stoppedAt: null,
      fault: null,
    },
  };
}
const ctx = { flowClass: (name) => (name === 'create-note' ? 'form' : 'write') };
const members = (list) => list.map((o) => memberOf(o, flows[o.flow], new Map(list.map((x) => [x.run.unique, x.id]))));

test('the severity table: ranks and severities exactly as section 34 lists them', () => {
  assert.deepEqual(Object.entries(CHECK_RANK).sort((a, b) => a[1] - b[1]).map(([c, r]) => `${r} ${c} ${CHECK_SEVERITY[c]}`), [
    '1 one-write high', '2 no-5xx-on-bad-input high', '3 visible-error-message high', '4 settles high', '5 latest-response-wins high',
    '6 values-survive medium', '7 retry-recovers medium', '8 no-broken-text medium', '10 no-uncaught-error medium', '11 no-overflow-375 low',
  ]);
  assert.deepEqual(SEVERITY_TEXT, { high: 'HIGH', medium: 'MED ', low: 'LOW ' });
  // Same failed checks, different fault, sticky flag, method and page: same lead and severity.
  const [a, b] = members([
    outcome({ fault: '500', failed: ['settles', 'no-uncaught-error'] }),
    outcome({ fault: 'reset', sticky: false, key: 'GET /api/notes #1', page: '/notes', failed: ['settles', 'no-uncaught-error'] }),
  ]);
  assert.equal(a.lead, b.lead);
  const groups = groupFindings([a, b], ctx);
  assert.deepEqual(groups.map((g) => g.severity), ['high', 'high']);
});

test('the sample app replay: stuck-spinner, cleared-form and double-submit give exactly 3 groups', () => {
  const list = [
    ...['500', '400', '429', 'reset'].map((fault) => outcome({ flow: 'sign-in', fault, key: 'POST /api/login #1', page: '/login', failed: ['visible-error-message', 'settles', 'no-uncaught-error'] })),
    ...['500', '400', '429', 'reset'].map((fault) => outcome({ fault, failed: ['values-survive', 'retry-recovers'] })),
    ...['spaces', 'long', 'emoji'].map((input) => outcome({ kind: 'bad-input', fault: null, sticky: false, id: `create-note/label "Title"/${input}`, badInput: { inputId: input, field: { name: 'label "Title"', kind: 'text', key: 'title' } }, failed: ['values-survive'] })),
    outcome({ kind: 'timing', fault: null, sticky: false, id: 'create-note/POST /api/notes #1/double-submit', failed: ['one-write'] }),
  ];
  const groups = groupFindings(members(list), ctx);
  assert.deepEqual(groups.map((g) => `${g.severity} ${g.lead} ${g.key.page} ${g.key.step} ${g.key.action} ${g.members.length} ${g.representative.outcome.id}`), [
    'high one-write /notes/new click POST /api/notes 1 create-note/POST /api/notes #1/double-submit',
    'high visible-error-message /login click POST /api/login 4 sign-in/POST /api/login #1/500!',
    'medium values-survive /notes/new click POST /api/notes 7 create-note/POST /api/notes #1/500!',
  ]);
});

test('pass 2 folds a subset of an earlier group\'s checks into it; a check outside that set stays separate', () => {
  const list = [
    outcome({ fault: '500', failed: ['values-survive', 'retry-recovers'] }),
    outcome({ fault: '400', failed: ['retry-recovers'] }),
    outcome({ fault: '429', failed: ['no-uncaught-error'] }),
  ];
  const groups = groupFindings(members(list), ctx);
  assert.deepEqual(groups.map((g) => g.members.map((m) => m.outcome.fault).join(',')), ['500,400', '429']);
});

test('representatives and ranking: most failed checks, then kind and fault order; an all-foreign group ranks after an equal one', () => {
  const list = [
    outcome({ fault: 'reset', failed: ['settles', 'no-uncaught-error'] }),
    outcome({ fault: '500', failed: ['settles'] }),
    outcome({ fault: '400', failed: ['settles', 'no-uncaught-error'] }),
  ];
  assert.equal(groupFindings(members(list), ctx)[0].representative.outcome.fault, '400');
  const plain = outcome({ flow: 'create-note', key: 'POST /api/a #1', page: '/a', failed: ['settles'] });
  const foreignA = outcome({ flow: 'create-note', key: 'POST /api/b #1', page: '/b', failed: ['settles'] });
  foreignA.run.steps[0].observation.after.lines = [`Note ${plain.run.unique}`];
  const groups = groupFindings(members([foreignA, plain]), ctx);
  assert.deepEqual(groups.map((g) => g.key.page), ['/a', '/b']);
  const line2 = groupLines({ ...groups[1], fails: ['settles'] }, 'r02')[1];
  assert.ok(line2.endsWith(`| page showed a record from ${plain.id}`), line2);
});

test('hash routes key pages; other fragments drop', () => {
  assert.equal(pagePath('http://localhost:3731/#/notes/12'), '/#/notes/{}');
  assert.equal(pagePath('http://localhost:3731/#section'), '/');
});

test('confirmation: 5 shown and 2 capped of 7; not-confirmed moves on; limits per tier; printed checks failed twice', async () => {
  const seven = Array.from({ length: 7 }, (_, i) => outcome({ key: `POST /api/x${i} #1`, page: `/p${i}`, failed: ['settles', 'no-uncaught-error'] }));
  let groups = groupFindings(members(seven), ctx);
  let calls = [];
  const again = (failed) => async (o) => {
    calls.push(o.id);
    return { ...o, verdict: 'failed', checks: o.checks.map((c) => ({ ...c, result: failed.includes(c.id) ? 'fail' : 'pass' })), run: { ...o.run, unique: 'fresh' } };
  };
  await confirmGroups(groups, 'standard', again(['settles']));
  assert.deepEqual(groups.map((g) => g.state), ['shown', 'shown', 'shown', 'shown', 'shown', 'capped', 'capped']);
  assert.equal(calls.length, 5);
  assert.deepEqual(groups[0].fails, ['settles'], 'no-uncaught-error failed only in the attack');
  // A representative whose lead check passes again is not confirmed, and the next group is tried.
  groups = groupFindings(members(seven), ctx);
  calls = [];
  let first = true;
  await confirmGroups(groups, 'standard', async (o) => {
    const failed = first ? [] : ['settles'];
    first = false;
    return again(failed)(o);
  });
  assert.deepEqual(groups.map((g) => g.state), ['not-confirmed', 'shown', 'shown', 'shown', 'shown', 'shown', 'capped']);
  // quick: 5 runs at most, then unchecked.
  groups = groupFindings(members(seven), ctx);
  calls = [];
  await confirmGroups(groups, 'quick', again([]));
  assert.deepEqual(groups.map((g) => g.state), ['not-confirmed', 'not-confirmed', 'not-confirmed', 'not-confirmed', 'not-confirmed', 'unchecked', 'unchecked']);
  assert.equal(calls.length, 5);
  groups = groupFindings(members(seven), ctx);
  calls = [];
  await confirmGroups(groups, 'standard', again([]));
  assert.equal(calls.length, 7);
});

test('determinism: input order never changes groups, representatives or ranks', () => {
  const list = [
    outcome({ fault: '500', failed: ['values-survive', 'retry-recovers'] }),
    outcome({ fault: '400', failed: ['retry-recovers'] }),
    outcome({ flow: 'sign-in', key: 'POST /api/login #1', page: '/login', failed: ['visible-error-message'] }),
    outcome({ kind: 'timing', fault: null, sticky: false, id: 'create-note/POST /api/notes #1/double-submit', failed: ['one-write'] }),
  ];
  const shape = (gs) => gs.map((g) => `${g.representative.outcome.id} ${g.members.map((m) => m.outcome.id).sort().join(',')}`);
  const forward = shape(groupFindings(members(list), ctx));
  const backward = shape(groupFindings(members([...list].reverse()), ctx));
  assert.deepEqual(forward, backward);
});
