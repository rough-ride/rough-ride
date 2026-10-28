import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { attackNominalMs, bandOf, computeCut, flowNominalMs, orderedList, reserveMs } from '../dist/budget.mjs';
import { canonicalJson } from '../dist/output.mjs';
import { loadSchema, validate } from '../dist/schema.mjs';
import { TIER_TABLE, tierTableSha256 } from '../dist/tiers.mjs';

test('dist/tiers.json is the compiled tier table, and its sha256 is what record.json names', () => {
  const file = readFileSync(new URL('../dist/tiers.json', import.meta.url), 'utf8');
  assert.equal(file, canonicalJson(TIER_TABLE));
  assert.equal(tierTableSha256(), createHash('sha256').update(file).digest('hex'));
  const kinds = (tier) => TIER_TABLE.tiers[tier].kinds;
  assert.deepEqual(kinds('quick').filter((k) => k.badInputs).map((k) => [k.rank, k.band, k.badInputs]), [[2, 1, { from: 1, to: 3, perField: 1, select: false }]]);
  assert.deepEqual(kinds('standard').filter((k) => k.badInputs).map((k) => [k.rank, k.band, k.badInputs]), [[2, 1, { from: 1, to: 3, perField: 1, select: false }], [8, 2, { from: 4, to: 12, perField: null, select: true }]]);
  assert.deepEqual(kinds('quick').filter((k) => k.timing).map((k) => [k.timing, k.rank, k.band, k.appliesTo]), [['double-submit', 3, 1, 'post-steps']]);
  assert.deepEqual(kinds('standard').filter((k) => k.timing).map((k) => [k.timing, k.rank, k.band, k.appliesTo]), [
    ['double-submit', 3, 1, 'post-steps'], ['out-of-order', 11, 2, 'get-fields'], ['refresh', 14, 2, 'in-app-entries'],
    ['signed-out-reload', 15, 2, 'signed-in-entries'], ['back', 19, 3, 'in-app-entries-from-another-path'],
  ]);
  assert.deepEqual(['quick', 'standard'].map((t) => [TIER_TABLE.tiers[t].budgetMs, TIER_TABLE.tiers[t].serialGraceMs, TIER_TABLE.tiers[t].confirmRuns, TIER_TABLE.tiers[t].tests, TIER_TABLE.tiers[t].planCap]), [[120_000, 30_000, 5, 6, 8], [450_000, 30_000, 8, 24, 20]]);
  assert.ok(kinds('standard').filter((k) => !k.fault).every((k) => k.signInFlow === false));
});

test('no config field sets a budget, a grace, a cap or the confirmation runs', () => {
  const schema = loadSchema('config.schema.json');
  for (const extra of [{ budget: 200 }, { tiers: {} }, { confirmRuns: 9 }, { planCap: 30 }]) assert.ok(validate(schema, { schema: '0.1.0', ...extra }).length > 0, JSON.stringify(extra));
});

const flow = { name: 'create-note', signedIn: true, steps: [{ goto: '/notes/new' }, { fill: { label: 'Title' }, value: 'x' }, { click: { role: 'button', name: 'Save' } }, { expect: { text: 'x' } }] };
const attack = (over) => ({ id: 'a', flow: 'create-note', kind: 'fault', fault: '500', sticky: true, rank: 1, key: 'POST /api/notes #1', template: 'POST /api/notes', step: 3, k: 1, diffLinked: false, closeness: 3, ...over });

test('nominal time: 400 ms a run, 1,500 a full load, 800 an action, 100 an expect, plus each kind\'s surcharge', () => {
  assert.equal(flowNominalMs(flow), 400 + 1500 + 800 + 800 + 100);
  assert.equal(attackNominalMs(attack({}), flow), 3600 + 2000 + 900, 'sticky 500 on a write: grace and the steps from the attacked one again');
  assert.equal(attackNominalMs(attack({ template: 'GET /api/notes' }), flow), 3600 + 5000 + 900);
  assert.equal(attackNominalMs(attack({ fault: 'hang' }), flow), 400 + 1500 + 800 + 14_000);
  assert.equal(attackNominalMs(attack({ kind: 'viewport', fault: null }), flow), 3600);
  assert.equal(attackNominalMs(attack({ kind: 'timing', fault: null, timing: 'double-submit' }), flow), 4100);
});

test('the ordered list: band by band across flows, the sign-in segment last; quick\'s attacks lead standard\'s in the same order', () => {
  const a = (id, flowName, rank, closeness = 3) => ({ ...attack({ id, flow: flowName, rank, closeness }) });
  const quick = [a('c/500w', 'c', 1), a('c/vp', 'c', 7), a('s/500w', 'sign-in', 1), a('l/500r', 'l', 4)];
  const standard = [...quick, a('c/400', 'c', 9), a('l/hang', 'l', 20), a('s/429', 'sign-in', 13)];
  const ids = (list) => orderedList(['c', 'l', 'sign-in'], list).map((x) => x.id);
  assert.deepEqual(ids(quick), ['c/500w', 'c/vp', 'l/500r', 's/500w']);
  assert.deepEqual(ids(standard), ['c/500w', 'c/vp', 'l/500r', 'c/400', 'l/hang', 's/500w', 's/429']);
  assert.deepEqual(ids(standard).filter((id) => ids(quick).includes(id)), ids(quick).filter((id) => !id.startsWith('s/')).concat(['s/500w']));
  assert.deepEqual([1, 2, 3, 6, 7, 8, 11, 19, 20].map(bandOf), [1, 1, 1, 1, 1, 2, 2, 3, 3]);
});

test('the cut: the first item past W and every item after it are cut, even a shorter one; the digest depends only on the inputs', () => {
  const list = Array.from({ length: 12 }, (_, i) => attack({ id: `x${String(i).padStart(2, '0')}` }));
  const nominal = (x) => (x.id === 'x11' ? 1000 : 40_000);
  const make = () => computeCut({ tier: 'quick', list, nominal, signInNominalMs: 3600, baselineNominalMs: [3600, 3600, 3600], tableSha256: 't' });
  const cut = make();
  assert.equal(cut.nominalPlanMs, 3600 + 3600 + 2000);
  assert.equal(cut.windowMs, 120_000 - 9200 - 3000);
  const first = cut.items.findIndex((x) => !x.aboveCut);
  assert.ok(first > 0 && cut.items.slice(first).every((x) => !x.aboveCut), 'nothing after the first cut item runs');
  assert.equal(cut.items.at(-1).aboveCut, false, 'a later shorter item stays cut');
  assert.equal(make().selectionDigest, cut.selectionDigest);
  assert.notEqual(computeCut({ tier: 'standard', list, nominal, signInNominalMs: 3600, baselineNominalMs: [3600], tableSha256: 't' }).selectionDigest, cut.selectionDigest);
});

test('the reserve holds the first L failed attacks\' durations and 3 s for the report', () => {
  assert.equal(reserveMs([5000, 6000, 7000, 8000], 'quick'), 18_000 + 3000);
  assert.equal(reserveMs([], 'standard'), 3000);
});
