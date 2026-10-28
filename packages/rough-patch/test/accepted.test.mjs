import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { acceptedEntries, acceptedRecord, acceptedReport, acceptsBaseline, applyAccepted, baselineKey, testAcceptedNotes } from '../dist/accepted.mjs';
import { checkCommittedFiles } from '../dist/files.mjs';
import { checkRootEntry } from '../dist/folder.mjs';
import { compareProtected } from '../dist/protected.mjs';
import { StopError } from '../dist/exit.mjs';
import { keyOf } from '../dist/groups.mjs';
import { ownHostFor } from '../dist/attacks.mjs';
import { gitRepo, sh } from './helpers.mjs';

const info = { version: '0.1.0', cliPath: '/x/dist/cli.mjs', source: { kind: 'other', detail: '/x', resolved: null }, pluginId: null, pluginData: null, node: '22.22.1', playwright: '1.64.1', claudeCode: { version: null, floorChecked: false }, editGuard: 'n/a', versionSkew: null };
const entry = (over = {}) => ({ page: '/notes/new', step: 'click', action: 'POST /api/notes', check: 'values-survive', because: 'The form is cleared on purpose.', ...over });
const yaml = (entries) => 'schema: 0.1.0\naccepted:\n' + entries.map((e) => Object.entries(e).map(([k, v], i) => `${i === 0 ? '  - ' : '    '}${k}: ${JSON.stringify(v)}`).join('\n')).join('\n') + '\n';

// main holds `reviewed`; the feature branch's working tree holds `working`.
function repo(reviewed, working) {
  const root = gitRepo();
  const write = (text) => {
    mkdirSync(path.join(root, '.rough-patch'), { recursive: true });
    writeFileSync(path.join(root, '.rough-patch', 'accepted.yaml'), text);
  };
  writeFileSync(path.join(root, 'README.md'), 'x\n');
  if (reviewed !== null) write(reviewed);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'base');
  sh(root, 'branch', '-M', 'main');
  sh(root, 'checkout', '-q', '-b', 'feature');
  if (working !== null) write(working);
  return root;
}

function entriesIn(root) {
  const folder = checkRootEntry(root);
  const files = checkCommittedFiles(folder, { info, subcommand: 'quick', argv: ['quick'], env: {} });
  const prot = compareProtected({ root, folderDir: folder.dir, files, env: {}, pluginData: false });
  const notes = [];
  return { entries: acceptedEntries(files.accepted, prot.accepted, '0.1.0', notes), notes, prot, files };
}

test('only entries in the reviewed version apply; a branch-only entry is held and printed; editing because keeps it applied', () => {
  const merged = entry();
  const branch = entry({ check: 'settles' });
  const { entries, prot } = entriesIn(repo(yaml([merged]), yaml([{ ...merged, because: 'Reworded.' }, branch])));
  assert.deepEqual(entries.map((e) => [e.line, e.check, e.state]), [[3, 'values-survive', 'applied'], [8, 'settles', 'held']]);
  const lines = prot.entries.flatMap((e) => e.notApplied ?? []);
  assert.deepEqual(lines, ['Accepted outside review, not applied until merged: /notes/new click POST /api/notes settles.']);
});

test('a removed entry stops at once, and a file with no reviewed version applies nothing', () => {
  assert.deepEqual(entriesIn(repo(yaml([entry()]), yaml([entry({ check: 'settles' })]))).entries.map((e) => e.state), ['held']);
  assert.deepEqual(entriesIn(repo(null, yaml([entry()]))).entries.map((e) => e.state), ['held']);
});

test('an unknown check is ignored with its note; a flow field, a missing field or a 201-character because stops with exit 78', () => {
  const { entries, notes } = entriesIn(repo(yaml([entry({ check: 'foo' })]), null));
  assert.equal(entries[0].state, 'ignored');
  assert.equal(entriesIn(repo(yaml([entry({ check: 'toString' })]), null)).entries[0].state, 'ignored', 'an inherited name is not a check');
  assert.deepEqual(notes.map((n) => n.text), ["Accepted entry ignored: accepted.yaml line 3 names check foo, which rough-patch 0.1.0 doesn't have."]);
  const { page: _page, ...noPage } = entry();
  for (const bad of [entry({ flow: 'create-note' }), entry({ expires: '2027-01-01' }), noPage, entry({ because: 'x'.repeat(201) }), entry({ because: '' })]) {
    const root = repo(null, yaml([bad]));
    assert.throws(() => entriesIn(root), (e) => e instanceof StopError && e.stop.code === 'files-invalid', JSON.stringify(bad));
  }
});

// A failed fault outcome at POST /api/notes from /notes/new, step 3 (a click).
const flow = { name: 'create-note', signedIn: true, steps: [{ goto: '/notes/new' }, { fill: { label: 'Title' }, value: 'x' }, { click: { role: 'button', name: 'Save' } }] };
const outcome = (failed) => ({
  id: 'create-note/POST /api/notes #1/500!', flow: 'create-note', kind: 'fault', fault: '500', sticky: true, key: 'POST /api/notes #1', template: 'POST /api/notes', step: 3, page: '/notes/new',
  control: 'button "Save"', verdict: 'failed', diffLinked: true,
  checks: [...failed.map((id) => ({ id, result: 'fail', evidence: 'e' })), { id: 'settles', result: 'pass', evidence: '' }],
  run: { requests: [{ step: 3, key: 'POST /api/notes #1', method: 'POST', pagePath: '/notes/new', resourceType: 'fetch', status: 500, postData: null }], steps: [], pages: [], unique: 'u' },
});

test('a matching applied entry removes the check; with nothing else failed the verdict is accepted-finding', () => {
  const key = keyOf(outcome(['values-survive']), flow);
  assert.deepEqual(key, { page: '/notes/new', step: 'click', action: 'POST /api/notes' });
  const entries = [{ line: 3, ...entry(), state: 'applied', matched: [] }, { line: 8, ...entry({ check: 'retry-recovers' }), state: 'held', matched: [] }];
  const only = outcome(['values-survive']);
  applyAccepted(only, flow, entries);
  assert.equal(only.verdict, 'accepted-finding');
  assert.equal(only.checks[0].result, 'accepted');
  const two = outcome(['values-survive', 'retry-recovers']);
  applyAccepted(two, flow, entries);
  assert.equal(two.verdict, 'failed', 'a held entry never applies');
  assert.deepEqual(two.checks.filter((c) => c.result === 'fail').map((c) => c.id), ['retry-recovers']);
  assert.deepEqual(entries[0].matched, [only.id]);
  assert.deepEqual(acceptedReport(entries), [
    `accepted.yaml line 3: page /notes/new | step click | action POST /api/notes | check values-survive: applied, matched ${only.id}`,
    'accepted.yaml line 8: page /notes/new | step click | action POST /api/notes | check retry-recovers: held until merged',
  ]);
  assert.deepEqual(acceptedRecord(entries, true), { file: '.rough-patch/accepted.yaml', entries: [{ line: 3, applied: true, matched: [only.id] }, { line: 8, applied: false, matched: [] }] });
  assert.deepEqual(testAcceptedNotes(entries, outcome(['values-survive']), flow, ['values-survive']), ['accepted.yaml line 3 accepts this check here; the test still checks it.']);
});

test('fails-with-no-attack lines match by the step where the check first failed', () => {
  // A third-party call sent first never becomes the action.
  const run = { requests: [{ step: 3, key: 'POST /v1/t #1', url: 'https://api.segment.io/v1/t', resourceType: 'fetch' }, { step: 3, key: 'POST /api/notes #1', url: 'http://localhost:8731/api/notes', resourceType: 'fetch' }], steps: [{ index: 3, label: 'button "Save"' }] };
  const key = baselineKey(flow, run, 3, '/notes/new', ownHostFor([]));
  assert.deepEqual(key, { page: '/notes/new', step: 'click', action: 'POST /api/notes' });
  const entries = [{ line: 3, ...entry({ check: 'settles' }), state: 'applied', matched: [] }];
  assert.equal(acceptsBaseline(entries, key, 'settles', 'fails with no attack: create-note step 3'), true);
  assert.equal(acceptsBaseline(entries, key, 'no-uncaught-error', 'x'), false);
  assert.deepEqual(acceptedReport(entries), ['accepted.yaml line 3: page /notes/new | step click | action POST /api/notes | check settles: applied, matched fails with no attack: create-note step 3']);
  assert.match(acceptedReport([{ line: 4, ...entry(), state: 'applied', matched: [] }])[0], /: applied, matched nothing this run$/);
});
