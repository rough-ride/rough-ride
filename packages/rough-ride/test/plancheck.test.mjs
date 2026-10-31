import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCatalogue, planCandidates, toRecord } from '../dist/catalogue.mjs';
import { validatePlan } from '../dist/plan.mjs';
import { checkPlan, verdictLines } from '../dist/plancheck.mjs';
import { noteFlow, noteRun, signInFlow, signInRun } from './fixtures/catalogue-flows.mjs';

const TODAY = new Date('2026-10-25');

// What plan would have recorded: selection.json's outline (43.3) and catalogue.json,
// and the catalogue the attack invocation builds from the same baseline runs.
function planned(tier) {
  const fresh = buildCatalogue({
    tier,
    flows: [
      { flow: noteFlow('create-note'), runs: [noteRun()], passed: true, reached: true },
      { flow: noteFlow('quick-note'), runs: [noteRun()], passed: true, reached: true },
      { flow: signInFlow, runs: [signInRun()], passed: true, reached: true },
    ],
    docs: [],
    hosts: { allowed: [], remoteTarget: null },
    today: TODAY,
  });
  const scope = { selected: fresh.share.map((a) => a.id), aboveFlows: [...new Set(fresh.share.map((a) => a.flow))] };
  const forms = (flow) => [...new Set(fresh.share.filter((a) => a.flow === flow && a.badInput).map((a) => a.badInput.formName))].map((form) => ({ form, fields: [] }));
  const plan = {
    runId: '20261028-101010-plan-ab12',
    tier,
    selected: scope.selected,
    flows: ['create-note', 'quick-note', 'sign-in'].map((name) => ({
      name,
      aboveCut: true,
      requests: [...new Set(fresh.share.filter((a) => a.flow === name && a.kind === 'fault').map((a) => a.key))].map((key) => ({ key, applies: [] })),
      forms: forms(name),
    })),
    flowPages: [],
    catalogue: JSON.parse(JSON.stringify(toRecord(fresh, scope))),
  };
  return { plan, attack: (input) => validatePlan(input, planCandidates(fresh, scope)) };
}

const entry = (over) => ({ flow: 'create-note', because: 'b', ...over });

test('--check refuses a fault that does not apply, as attack does', () => {
  const { plan, attack } = planned('quick');
  const input = { attacks: [entry({ flow: 'sign-in', fault: '401', request: 'POST /api/login #1' })] };
  assert.deepEqual(checkPlan(input, plan, []).lines, ['Rejected plan entry: attacks[0] (401 does not apply to POST /api/login #1)']);
  assert.deepEqual(checkPlan(input, plan, []).entries, attack(input).entries);
});

test('--check reads bad inputs a selected attack already runs as already selected, with their real ids, as attack does', () => {
  for (const tier of ['quick', 'standard']) {
    const { plan, attack } = planned(tier);
    const input = { attacks: [entry({ flow: 'quick-note', badInputs: 3, form: 'POST /api/notes' }), entry({ badInputs: 2, form: 'POST /api/notes' })] };
    assert.deepEqual(checkPlan(input, plan, []).entries, attack(input).entries, tier);
  }
  const { plan } = planned('standard');
  assert.deepEqual(checkPlan({ attacks: [entry({ badInputs: 2, form: 'POST /api/notes' })] }, plan, []).lines, ['Rejected plan entry: attacks[0] (already selected)']);
});

test('--check counts a bad-input entry toward the cap by the inputs attack would keep, not by the number asked for', () => {
  const { plan, attack } = planned('quick');
  const input = { attacks: [
    entry({ badInputs: 12, form: 'POST /api/notes' }),
    ...['400', '429', 'hang', 'delay-3s'].map((fault) => entry({ fault, request: 'GET /api/notes #1' })),
  ] };
  const check = checkPlan(input, plan, []);
  assert.deepEqual(check.lines, []);
  assert.deepEqual(check.kept.map((a) => a.id), attack(input).kept.map((a) => a.id));
  assert.equal(check.kept.length, 8);
});

test('--check leaves an entry on a flow saved after the plan unchecked, counted toward the cap at its upper bound', () => {
  const { plan } = planned('quick');
  const r = checkPlan({ attacks: [
    entry({ flow: 'fresh-note', badInputs: 6, form: 'POST /api/notes' }),
    entry({ flow: 'fresh-note', viewport: 375 }),
    entry({ badInputs: 2, form: 'POST /api/notes' }),
  ] }, plan, ['fresh-note']);
  assert.deepEqual(r.lines, [
    'Unchecked plan entry: attacks[0] (flow fresh-note was saved after the plan; attack checks its points)',
    'Unchecked plan entry: attacks[1] (flow fresh-note was saved after the plan; attack checks its points)',
    'Unchecked plan entry: attacks[2] (over the plan cap of 8 unless attack keeps fewer for attacks[0], attacks[1])',
  ]);
  assert.deepEqual(r.kept, []);
});

test('--check closes with how many entries attack still decides, and says nothing of it when every entry was checked', () => {
  const { plan } = planned('quick');
  const fresh = (flow) => entry({ flow, viewport: 375 });
  const valid = entry({ fault: '400', request: 'GET /api/notes #1' });
  assert.deepEqual(verdictLines(checkPlan({ attacks: [valid] }, plan, [])), ['Plan check: 1 entry valid, 1 planned attack']);
  assert.deepEqual(verdictLines(checkPlan({ attacks: [fresh('fresh-note')] }, plan, ['fresh-note'])), [
    'Plan check: 0 entries valid, 0 planned attacks',
    'Plan check: 1 entry unchecked; attack checks it against fresh baseline runs',
  ]);
  assert.deepEqual(verdictLines(checkPlan({ attacks: [fresh('fresh-note'), fresh('late-note'), valid] }, plan, ['fresh-note', 'late-note'])), [
    'Plan check: 1 entry valid, 1 planned attack',
    'Plan check: 2 entries unchecked; attack checks them against fresh baseline runs',
  ]);
});
