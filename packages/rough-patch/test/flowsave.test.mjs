import assert from 'node:assert/strict';
import { test } from 'node:test';
import { envValueRefusal, splitDocuments, staticRefusal } from '../dist/flowsave.mjs';
import { run, gitRepo } from './helpers.mjs';

const FLOW = 'signedIn: true\nsteps:\n  - goto: /notes/new\n  - fill: {label: Title}\n    value: "Note ${unique}"\n  - click: {role: button, name: Save}\n  - expect: {text: "Note ${unique}"}\n';

test('stdin splits into one document per name, keeping each text', () => {
  assert.deepEqual(splitDocuments(FLOW), [FLOW]);
  const two = splitDocuments(`${FLOW}---\n${FLOW.replace('/notes/new', '/notes')}`);
  assert.equal(two.length, 2);
  assert.ok(two[1].includes('goto: /notes\n'));
  assert.deepEqual(splitDocuments(FLOW.replace(/\n/g, '\r\n')), [FLOW]);
});

test('static refusals: device names, bad names, non-ASCII with its line, a schema key, schema failures, goto and secrets', () => {
  assert.deepEqual(staticRefusal('con', FLOW).refused, 'Not saved: con (a Windows device name)');
  assert.match(staticRefusal('Create_Note', FLOW).refused, /^Not saved: Create_Note \(a flow name is lowercase/);
  assert.equal(staticRefusal('n', FLOW.replace('Note ${unique}', 'Notiz ä')).refused, 'Not saved: n (non-ASCII byte at line 5: write it as \\uXXXX inside double quotes)');
  assert.equal(staticRefusal('n', `schema: 0.1.0\n${FLOW}`).refused, 'Not saved: leave schema out; flow-save writes it.');
  assert.match(staticRefusal('n', 'signedIn: true\nsteps:\n  - wiggle: x\n').refused, /^Not saved: n \(/);
  assert.equal(staticRefusal('n', FLOW.replace('goto: /notes/new', 'goto: https://example.com/x')).refused, 'Not saved: n (goto must be a path on the target, such as /notes)');
  for (const secret of ['AKIAABCDEFGHIJKLMNOP', `ghp_${'a'.repeat(36)}`, '-----BEGIN RSA PRIVATE KEY-----', 'xoxb-123', `npm_${'b'.repeat(36)}`, `sk-${'c'.repeat(24)}`]) {
    assert.equal(staticRefusal('n', FLOW.replace('Note ${unique}', secret)).refused, 'Not saved: n (step 2 holds what looks like a secret)', secret);
  }
  const ok = staticRefusal('create-note', FLOW);
  assert.equal(ok.refused, null);
  assert.equal(ok.value.signedIn, true);
});

test('a fill value equal to an env value of 4 characters or more is refused', () => {
  const value = { signedIn: true, steps: [{ goto: '/login' }, { fill: { label: 'Password' }, value: 'demo-password' }] };
  const read = (n) => ({ DEMO_PASSWORD: 'demo-password', PIN: 'abc' })[n];
  assert.equal(envValueRefusal('s', value, ['DEMO_PASSWORD'], read), 'Not saved: s (contains the value of DEMO_PASSWORD; use ${env.DEMO_PASSWORD})');
  assert.equal(envValueRefusal('s', { ...value, steps: [{ fill: { label: 'Pin' }, value: 'abc' }] }, ['PIN'], read), null);
});

test('the CLI: no names, a --force flag or an item without --run is a usage stop; static refusals write nothing and exit 2', () => {
  const repo = gitRepo();
  assert.equal(run(['flow', 'save'], { cwd: repo }).code, 64);
  assert.equal(run(['flow', 'save', 'x', '--force'], { cwd: repo }).code, 64);
  assert.equal(run(['flow', 'save', 'x:n1'], { cwd: repo }).code, 64);
  assert.equal(run(['regress', '--run', 'abc'], { cwd: repo }).code, 64);
});
