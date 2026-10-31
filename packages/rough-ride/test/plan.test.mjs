import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { cutPlanned, parsePlan, planCap, validatePlan } from '../dist/plan.mjs';

test('refused plans: a non-ASCII byte names its line, over 24 KB, an unknown key, a schema key without input; empty is fine', () => {
  assert.equal(parsePlan('attacks: []\nnoFlow:\n  - {file: a, why: "café"}\n', 'quick').refused, 'Plan refused: line 3: non-ASCII byte (write it as \\uXXXX inside double quotes)');
  assert.equal(parsePlan(`noFlow: []\n#${'x'.repeat(24 * 1024)}`, 'quick').refused, 'Plan refused: over 24 KB');
  assert.equal(parsePlan('extras: []\n', 'quick').refused, 'Plan refused: unknown key extras');
  assert.equal(parsePlan('schema: 0.1.0\nattacks: []\n', 'quick').refused, 'Plan refused: leave schema out; the runner stamps plan.json');
  assert.equal(parsePlan('a: 1\na: 2\n', 'quick').refused?.startsWith('Plan refused: not valid YAML'), true);
  assert.equal(parsePlan('- 1\n', 'quick').refused, 'Plan refused: the plan is not a mapping');
  assert.deepEqual(parsePlan('', 'quick'), { refused: null, input: {}, replay: null, warnings: [] });
});

test('replay: a whole plan.json below the floor is refused; another tier warns; its input is what counts', () => {
  assert.equal(parsePlan('{"schema":"0.0.1","input":{}}', 'quick').refused, 'Refused: plan.json schema 0.0.1 is older than this runner reads (0.1.0).');
  const r = parsePlan('{"schema":"0.1.0","tier":"standard","input":{"attacks":[]},"links":{"input":[]}}', 'quick');
  assert.equal(r.refused, null);
  assert.deepEqual(r.warnings, ['Plan warning: plan.json was made for standard; this run is quick.']);
  assert.deepEqual(r.input, { attacks: [] });
});

const attack = (flow, id) => ({ id, flow });
const cands = (over = {}) => ({
  tier: 'quick',
  aboveFlows: new Set(['create-note', 'sign-in']),
  allFlows: new Set(['create-note', 'sign-in', 'search-notes']),
  selected: new Set(['create-note/POST /api/notes #1/500!']),
  fault: (flow, request, fault, oneShot) => (request === 'POST /api/notes #1' ? attack(flow, `${flow}/${request}/${fault}${oneShot || fault === 'delay-3s' ? '' : '!'}`) : `${request} is not an attack point of ${flow}`),
  badInputs: (flow) => Array.from({ length: 12 }, (_, i) => attack(flow, `${flow}/f/in-${i}`)),
  viewport: (flow) => attack(flow, `${flow}/viewport-375`),
  ...over,
});
const entry = (over) => ({ flow: 'create-note', because: 'b', ...over });

test('entries are judged one by one: unknown points, already selected, oneShot rules, timing, sign-in bad inputs, below the cut', () => {
  const r = validatePlan({ attacks: [
    entry({ fault: '500', request: 'POST /api/note #1' }),
    entry({ fault: '500', request: 'POST /api/notes #1' }),
    entry({ fault: 'hang', request: 'POST /api/notes #1', oneShot: true }),
    entry({ fault: '500', request: 'POST /api/notes #1', oneShot: true }),
    entry({ timing: 'double-submit' }),
    entry({ flow: 'sign-in', badInputs: 2, form: 'POST /api/login' }),
    entry({ flow: 'search-notes', viewport: 375 }),
  ] }, cands());
  assert.deepEqual(r.lines, [
    'Rejected plan entry: attacks[0] (POST /api/note #1 is not an attack point of create-note)',
    'Rejected plan entry: attacks[1] (already selected)',
    'Rejected plan entry: attacks[2] (oneShot is only for 500, 400, 429, reset, malformed-json and empty-200)',
    'Rejected plan entry: attacks[4] (timing attacks are selected by the runner, never planned)',
    'Rejected plan entry: attacks[5] (bad inputs are never planned on the sign-in flow)',
    'Rejected plan entry: attacks[6] (flow search-notes is below the quick cut)',
  ]);
  assert.deepEqual(r.kept.map((a) => a.id), ['create-note/POST /api/notes #1/500']);
});

test('the cap: 8 in quick, 20 in standard; bad inputs past it are cut with the count kept', () => {
  assert.equal(planCap('quick'), 8);
  assert.equal(planCap('standard'), 20);
  const r = validatePlan({ attacks: [entry({ badInputs: 6, form: 'POST /api/notes' }), entry({ badInputs: 4, form: 'POST /api/notes' })] }, cands());
  assert.equal(r.kept.length, 8);
  assert.deepEqual(r.lines, ['Rejected plan entry: attacks[1] (over the plan cap of 8; 2 of 4 bad inputs kept)']);
  const s = validatePlan({ attacks: [entry({ badInputs: 12, form: 'POST /api/notes' }), entry({ flow: 'sign-in', viewport: 375 })] }, cands({ tier: 'standard', badInputs: (flow) => Array.from({ length: 18 }, (_, i) => attack(flow, `${flow}/x/${i}`)) }));
  assert.equal(s.kept.length, 13);
  const n = validatePlan({ noFlow: [{ file: 'a.vue', why: 'A drag and drop journey.' }] }, cands());
  assert.deepEqual(n.lines, ['adversary: no flow ("A drag and drop journey.")']);
});

test('unchecked entries: a callback that cannot tell leaves the entry unchecked, counted toward the cap at the most it can add', () => {
  const later = { unchecked: 'flow fresh-note was saved after the plan; attack checks its points' };
  const c = cands({
    aboveFlows: new Set(['create-note', 'fresh-note']),
    allFlows: new Set(['create-note', 'fresh-note']),
    fault: (flow, request, fault) => (flow === 'fresh-note' ? later : attack(flow, `${flow}/${request}/${fault}`)),
    badInputs: (flow) => (flow === 'fresh-note' ? later : Array.from({ length: 12 }, (_, i) => attack(flow, `${flow}/f/in-${i}`))),
    viewport: (flow) => (flow === 'fresh-note' ? later : attack(flow, `${flow}/viewport-375`)),
  });
  const r = validatePlan({ attacks: [
    entry({ flow: 'fresh-note', badInputs: 4, form: 'POST /api/notes' }),
    entry({ badInputs: 3, form: 'POST /api/notes' }),
    entry({ fault: '400', request: 'POST /api/notes #1' }),
    entry({ badInputs: 6, form: 'POST /api/notes' }),
    entry({ flow: 'fresh-note', viewport: 375 }),
    entry({ viewport: 375 }),
    entry({ badInputs: 2, form: 'POST /api/notes' }),
    entry({ viewport: 375 }),
  ] }, c);
  assert.deepEqual(r.lines, [
    'Unchecked plan entry: attacks[0] (flow fresh-note was saved after the plan; attack checks its points)',
    'Unchecked plan entry: attacks[3] (over the plan cap of 8; at most 4 of 6 bad inputs kept, fewer if attack keeps more for attacks[0])',
    'Unchecked plan entry: attacks[4] (flow fresh-note was saved after the plan; attack checks its points)',
    'Unchecked plan entry: attacks[5] (over the plan cap of 8 unless attack keeps fewer for attacks[0], attacks[3], attacks[4])',
    'Unchecked plan entry: attacks[6] (which inputs come next depends on attacks[3])',
    'Unchecked plan entry: attacks[7] (already selected if attack keeps attacks[5])',
  ]);
  // 3 + 1 kept for sure fit beside the 4 attacks[0] could add; attacks[3] could add 4 more.
  assert.deepEqual(r.entries.map((e) => [e.path, e.status, e.attackIds.length]), [
    ['attacks[0]', 'unchecked', 0],
    ['attacks[1]', 'kept', 3],
    ['attacks[2]', 'kept', 1],
    ['attacks[3]', 'unchecked', 4],
    ['attacks[4]', 'unchecked', 0],
    ['attacks[5]', 'unchecked', 1],
    ['attacks[6]', 'unchecked', 0],
    ['attacks[7]', 'unchecked', 1],
  ]);
  assert.deepEqual(r.kept.map((a) => a.id), ['create-note/f/in-0', 'create-note/f/in-1', 'create-note/f/in-2', 'create-note/POST /api/notes #1/400']);
});

test('unchecked entries: once the entries known kept fill the cap, an unchecked entry is rejected, as attack would reject it', () => {
  const c = cands({ allFlows: new Set(['create-note', 'fresh-note']), aboveFlows: new Set(['create-note', 'fresh-note']), viewport: (flow) => (flow === 'fresh-note' ? { unchecked: 'saved after the plan' } : attack(flow, `${flow}/viewport-375`)) });
  const r = validatePlan({ attacks: [entry({ badInputs: 8, form: 'POST /api/notes' }), entry({ flow: 'fresh-note', viewport: 375 }), entry({ flow: 'fresh-note', badInputs: 2, form: 'POST /api/notes' })] }, { ...c, badInputs: (flow) => (flow === 'fresh-note' ? { unchecked: 'saved after the plan' } : c.badInputs(flow)) });
  assert.deepEqual(r.lines, ['Rejected plan entry: attacks[1] (over the plan cap of 8)', 'Rejected plan entry: attacks[2] (over the plan cap of 8; 0 of 2 bad inputs kept)']);
});

test('the planned cut: planned attacks go after selected ones, and the first that overruns the window is cut with every later one', () => {
  const sel = [{ flow: 'a', nominalMs: 10_000 }, { flow: 'b', nominalMs: 10_000 }, { flow: 'sign-in', nominalMs: 10_000 }];
  const planned = Array.from({ length: 6 }, () => ({ flow: 'a', nominalMs: 10_000 }));
  assert.deepEqual(cutPlanned(sel, planned, 35_000), [true, true, true, true, false, false]);
});

test('the locator subschema is byte-identical in the flow, test and plan schemas', () => {
  const locators = (name) => {
    const out = [];
    const walk = (v) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === 'object') {
        if (typeof v.description === 'string' && v.description.startsWith('Exactly one of role')) out.push(JSON.stringify(v));
        Object.values(v).forEach(walk);
      }
    };
    walk(JSON.parse(readFileSync(new URL(`../src/schemas/${name}.schema.json`, import.meta.url), 'utf8')));
    return out;
  };
  const all = ['flow', 'test', 'plan'].flatMap(locators);
  assert.ok(all.length >= 3);
  assert.equal(new Set(all).size, 1);
});

test('the check subschema is byte-identical in the test and plan schemas', () => {
  const read = (name) => JSON.parse(readFileSync(new URL(`../src/schemas/${name}.schema.json`, import.meta.url), 'utf8'));
  const inTest = read('test').properties.checks.items.oneOf[1].properties;
  const inPlan = read('plan').properties.input.properties.checks.items.properties;
  for (const key of ['id', 'at', 'assert', 'spec', 'because']) assert.equal(JSON.stringify(inTest[key]), JSON.stringify(inPlan[key]), key);
  assert.equal(JSON.stringify(inTest.when.properties.outcome), JSON.stringify(inPlan.when.properties.outcome));
});

test('the agent body example attack plan validates against the plan schema input and parses as a plan', async () => {
  const { parse } = await import('yaml');
  const { loadSchema, validate } = await import('../dist/schema.mjs');
  const body = readFileSync(new URL('../agents/adversary.md', import.meta.url), 'utf8');
  const block = body.split('An attack plan adds attacks')[1].split('```yaml\n')[1].split('```')[0];
  const input = parse(block);
  assert.deepEqual(validate(loadSchema('plan.schema.json').properties.input, input), []);
  assert.equal(parsePlan(block, 'quick').refused, null);
});
