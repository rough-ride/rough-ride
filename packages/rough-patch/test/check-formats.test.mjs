import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { prProblems, readFormats, schemaBreaks, tagProblems, urlProblems } from '../../../scripts/check-formats.mjs';

const formats = readFormats(readFileSync(new URL('../src/formats.mts', import.meta.url), 'utf8'));
const flow = JSON.parse(readFileSync(new URL('../src/schemas/flow.schema.json', import.meta.url), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

test('adding an optional property is not a break; removing one, changing a type or narrowing an enum is', () => {
  const added = clone(flow);
  added.properties.note = { type: 'string' };
  assert.deepEqual(schemaBreaks(flow, added, 'flow'), []);

  const removed = clone(flow);
  delete removed.properties.signedIn;
  assert.deepEqual(schemaBreaks(flow, removed, 'flow'), ['/signedIn removed']);

  const retyped = clone(flow);
  retyped.properties.signedIn.type = 'string';
  assert.deepEqual(schemaBreaks(flow, retyped, 'flow'), ['/signedIn type changed']);

  const config = JSON.parse(readFileSync(new URL('../src/schemas/config.schema.json', import.meta.url), 'utf8'));
  const narrowed = clone(config);
  narrowed.properties.browser.enum = ['chrome'];
  assert.equal(schemaBreaks(config, narrowed, 'config').length, 2);
});

test('a PR that changes flow.schema.json must raise the flow current above the latest tag', () => {
  const after = clone(flow);
  after.properties.note = { type: 'string' };
  const base = { kind: 'flow', tagVersion: '0.1.0', before: flow, after, upgraders: [], fixtureVersions: { past: [], have: [] } };
  assert.deepEqual(prProblems({ ...base, formats }), [
    'flow: flow.schema.json changed since v0.1.0, so its current (0.1.0) must be above 0.1.0.',
  ]);
  assert.deepEqual(prProblems({ ...base, formats: { ...formats, flow: { current: '0.2.0', floor: '0.1.0' } } }), []);
  assert.deepEqual(prProblems({ ...base, after: flow, formats }), []);
});

test('a PR that removes a property must move floor, add an upgrader and fixtures for past versions', () => {
  const after = clone(flow);
  delete after.properties.signedIn;
  const moved = { ...formats, flow: { current: '0.2.0', floor: '0.1.0' } };
  const base = { kind: 'flow', tagVersion: '0.1.0', before: flow, after, fixtureVersions: { past: ['0.1.0'], have: [] } };
  assert.deepEqual(prProblems({ ...base, formats: moved, upgraders: [] }), [
    'flow: breaking change (/signedIn removed) needs floor moved to 0.2.0.',
    'flow: breaking change needs an upgrader to 0.2.0 in src/upgraders.',
    'flow: fixtures missing for 0.1.0.',
  ]);
  const done = { ...formats, flow: { current: '0.2.0', floor: '0.2.0' } };
  assert.deepEqual(
    prProblems({ ...base, formats: done, upgraders: [{ kind: 'flow', to: '0.2.0' }], fixtureVersions: { past: ['0.1.0'], have: ['0.1.0'] } }),
    [],
  );
});

test('on a release tag no current or floor is above it, changed kinds equal it, and patch tags change no schema', () => {
  assert.deepEqual(tagProblems({ tag: 'v0.1.0', formats, changedKinds: [] }), []);
  assert.deepEqual(tagProblems({ tag: 'v0.2.0-rc.1', formats, changedKinds: ['flow'] }), [
    'flow: changed since the previous tag, so current must be 0.2.0.',
  ]);
  assert.equal(tagProblems({ tag: 'v0.0.9', formats, changedKinds: [] }).length, 5);
  assert.deepEqual(tagProblems({ tag: 'v0.1.1', formats, changedKinds: ['config'] }), ['config: patch release 0.1.1 changes config.schema.json.']);
});

test('every schema URL and the config template agree with current', () => {
  const url = (v) => `https://raw.githubusercontent.com/rough-patch/rough-patch/${v}/packages/rough-patch/src/schemas/flow.schema.json`;
  assert.deepEqual(urlProblems('README.md', `see ${url('v0.1.0')}`, formats), []);
  assert.deepEqual(urlProblems('README.md', `see ${url('main')}`, formats), ['README.md: flow schema URL names main, expected v0.1.0.']);
  assert.deepEqual(urlProblems('packages/rough-patch/templates/config.yaml', 'schema: 0.0.9\n', formats), [
    'packages/rough-patch/templates/config.yaml: schema 0.0.9, expected 0.1.0.',
  ]);
});
