import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import { buildTest, renderTest, testName } from '../dist/regression.mjs';

// A failed attack outcome with just the fields a test reads.
const outcome = (over) => ({
  id: 'create-note/POST /api/notes #1/500!', flow: 'create-note', kind: 'fault', fault: '500', sticky: true,
  key: 'POST /api/notes #1', template: 'POST /api/notes', step: 5, page: '/notes/new', served: null,
  run: { unique: 'ab12cd34', requests: [{ step: 5, key: 'POST /api/notes #1', pagePath: '/notes/new' }], badInput: null },
  ...over,
});
const meta = { finding: 'Typed values lost after POST /api/notes fails with 500 (button "Save")', run: '20261025-141207-quick-k3fz', runner: '0.1.0', date: '2026-10-25' };

test('the file: keys in order, flow-style values, LF, a final newline, no BOM, schema first', () => {
  const t = buildTest(outcome({}), ['values-survive'], meta);
  assert.deepEqual(Object.keys(parse(t.text)), ['schema', 'flow', 'attack', 'checks', 'context', 'found']);
  assert.ok(t.text.startsWith('schema: 0.1.0\nflow: create-note\nattack: {fault: "500", sticky: true, request: "POST /api/notes #1", page: /notes/new}\nchecks: [values-survive]\n'), t.text);
  assert.ok(t.text.endsWith('\n') && !t.text.includes('\r') && !t.text.startsWith('﻿'));
  assert.ok(!t.text.includes('ab12cd34'), 'no ${unique} token');
});

test('names: <flow>-<slug>-<6 hex>, stable for the same attack, within the name rule and 72 characters', () => {
  const o = outcome({});
  assert.match(testName('create-note', o), /^create-note-500-[0-9a-f]{6}$/);
  assert.equal(testName('create-note', o), testName('create-note', outcome({})));
  assert.notEqual(testName('create-note', o), testName('create-note', outcome({ sticky: false })));
  const long = testName('a-very-long-flow-name-that-goes-on-and-on-and-on-forever', o);
  assert.match(long, /^[a-z0-9][a-z0-9-]{0,47}$/);
  assert.ok(`.rough-ride/tests/${long}.yaml`.length <= 72);
});

test('the attack forms for every kind', () => {
  const key = (o) => parse(buildTest(o, ['x'], meta).text).attack;
  assert.deepEqual(key(outcome({})), { fault: '500', sticky: true, request: 'POST /api/notes #1', page: '/notes/new' });
  assert.deepEqual(key(outcome({ kind: 'timing', fault: null, timing: 'double-submit', page: '/notes/new' })), { timing: 'double-submit', request: 'POST /api/notes #1', page: '/notes/new' });
  assert.deepEqual(key(outcome({ kind: 'timing', fault: null, timing: 'out-of-order', page: '/notes', template: 'GET /api/notes', outOfOrder: { fieldKey: 'q' } })), { timing: 'out-of-order', page: '/notes', request: 'GET /api/notes', field: 'q' });
  assert.deepEqual(key(outcome({ kind: 'timing', fault: null, timing: 'refresh', page: '/notes/new', entry: { k: 1, previous: '/notes' } })), { timing: 'refresh', page: '/notes/new', entry: 1 });
  assert.deepEqual(key(outcome({ kind: 'viewport', fault: null })), { viewport: 375 });
  const bad = { inputId: 'long', page: '/notes/new', carrying: 'POST /api/notes', field: { name: 'label "Body"', kind: 'textarea', key: 'body' }, preview: { text: 'Body-abc...', length: 10000 }, value: 'x'.repeat(10000), limit: null };
  const t = buildTest(outcome({ kind: 'bad-input', fault: null, badInput: bad, run: { unique: 'ab12cd34', requests: [], badInput: { held: 'x'.repeat(10000) } } }), ['values-survive'], meta);
  assert.deepEqual(parse(t.text).attack, { badInput: 'long', page: '/notes/new', request: 'POST /api/notes', field: 'body' });
  assert.deepEqual(parse(t.text).found.held, { length: 10000, preview: 'long "Body-abc..." (10000 chars)', cutBy: null });
  assert.ok(!t.text.includes('x'.repeat(100)), 'never the full bad value');
  const noKey = { ...bad, field: { name: 'label "Notes"', kind: 'textarea', key: null } };
  assert.deepEqual(parse(buildTest(outcome({ kind: 'bad-input', fault: null, badInput: noKey, run: { requests: [], badInput: { held: '' } } }), ['x'], meta).text).attack.field, { name: 'label "Notes"', kind: 'textarea' });
});

test('renderTest keeps any value plain YAML that parses back to itself', () => {
  const value = { schema: '0.1.0', flow: 'f', attack: { fault: '500', sticky: true, request: 'GET /api/a #1', page: '/#/x/{}' }, checks: ['settles'], context: { timezone: 'UTC', locale: 'en-US' }, found: { finding: 'a "quoted" thing: yes', run: 'r', runner: '0.1.0', date: '2026-10-25' } };
  assert.deepEqual(parse(renderTest(value)), value);
});
