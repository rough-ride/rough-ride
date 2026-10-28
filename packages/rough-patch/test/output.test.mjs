import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson, escapeName, formatDuration, headerLine } from '../dist/output.mjs';

test('canonical JSON sorts keys at every level, indents 2, escapes non-ASCII and ends with a newline', () => {
  const text = canonicalJson({ b: 1, a: { d: [{ z: 1, y: 'caf\u00e9 \u2192' }], c: null } });
  assert.equal(
    text,
    '{\n  "a": {\n    "c": null,\n    "d": [\n      {\n        "y": "caf\\u00e9 \\u2192",\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
  );
});

test('durations read 0.4s, 48s, 1m52s and 2m05s', () => {
  assert.equal(formatDuration(0), '0.0s');
  assert.equal(formatDuration(449), '0.4s');
  assert.equal(formatDuration(9_999), '9.9s');
  assert.equal(formatDuration(48_700), '48s');
  assert.equal(formatDuration(112_000), '1m52s');
  assert.equal(formatDuration(125_000), '2m05s');
});

test('names are escaped to ASCII and cut at 40 characters', () => {
  assert.equal(escapeName('caf\u00e9\x1b[31m'), 'caf\\u00e9\\u001b[31m');
  const long = escapeName('x'.repeat(50));
  assert.equal(long.length, 40);
  assert.ok(long.endsWith('...'));
});

test('header line 1', () => {
  assert.equal(headerLine('quick', 1_500, 'stopped'), 'rough-patch quick | 1.5s | stopped');
  assert.equal(headerLine('attack', 48_000, 'stopped', '20261027-a1b2'), 'rough-patch attack | 48s | run 20261027-a1b2 | stopped');
  assert.equal(headerLine('', 0, 'stopped'), 'rough-patch | 0.0s | stopped');
});
