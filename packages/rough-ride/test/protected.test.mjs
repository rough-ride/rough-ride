import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  blockLines, changedDuringRun, compareFlow, compareProtected, compareTest, effectiveConfig, extraNodeCodeNote, summaryLines,
} from '../dist/protected.mjs';
import { gitRepo, scratchDir, sh } from './helpers.mjs';

const FLOW = `schema: 0.1.0
signedIn: true
steps:
  - goto: /notes/new
  - fill: {label: Title}
    value: "Note \${unique}"
  - click: {role: button, name: Save}
  - expect: {text: Saved}
`;
const CONFIG = `schema: 0.1.0
reset: npm run db:reset
exclude: [/admin/**]
allow:
  remoteWrites: [api.example.com]
`;
const TEST = `schema: 0.1.0
flow: create-note
attack: {fault: "500", sticky: true, request: "POST /api/notes #1", page: /notes/new}
checks: [visible-error-message, settles]
context: {timezone: UTC, locale: en-US}
found: {run: 20261025-141207-quick-k3fz}
`;

// A repo whose main holds the reviewed versions, on a feature branch with a remote-tracking origin/main.
function repoWith(files, { remote = true } = {}) {
  const root = gitRepo();
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'base');
  sh(root, 'branch', '-M', 'main');
  if (remote) {
    const bare = scratchDir();
    sh(bare, 'init', '-q', '--bare');
    sh(root, 'remote', 'add', 'origin', bare);
    sh(root, 'push', '-q', 'origin', 'main');
    sh(root, 'fetch', '-q', 'origin');
    // Newer git sets origin/HEAD on fetch; the tests name origin/main.
    sh(root, 'remote', 'set-head', 'origin', '-d');
  }
  sh(root, 'checkout', '-q', '-b', 'feature');
  return { root, write };
}

// The CheckedFiles shape compareProtected reads, from the working tree.
async function checked(root) {
  const { parse } = await import('yaml');
  const { readdirSync, readFileSync, existsSync } = await import('node:fs');
  const dir = path.join(root, '.rough-ride');
  const file = (rel, kind) => {
    const p = path.join(dir, rel);
    if (!existsSync(p)) return null;
    const text = readFileSync(p, 'utf8');
    let value = null;
    try {
      value = parse(text.replace(/^﻿/, ''));
    } catch {
      value = null;
    }
    return { shown: `.rough-ride/${rel}`, text, value, kind, schema: null, problems: [], step5: value ? [] : ['invalid'] };
  };
  const list = (sub, kind) => (existsSync(path.join(dir, sub)) ? readdirSync(path.join(dir, sub)).sort().map((n) => file(`${sub}/${n}`, kind)) : []);
  return { config: file('config.yaml', 'config'), accepted: file('accepted.yaml', 'accepted'), flows: list('flows', 'flow'), tests: list('tests', 'tests'), invalid: [], notes: [] };
}

const compare = async (root, env = {}, pluginData = false) =>
  compareProtected({ root, folderDir: path.join(root, '.rough-ride'), files: await checked(root), env, pluginData });

test('flows: a removed expect runs the reviewed version; added expects run at once; changed steps wait for the reviewed baseline', () => {
  const r = { schema: '0.1.0', signedIn: true, steps: [{ goto: '/a' }, { click: { text: 'Go' } }, { expect: { text: 'Saved' } }] };
  assert.deepEqual(compareFlow({ ...r, steps: r.steps.slice(0, 2) }, r), { kind: 'weakened', text: 'removes the expect at step 3 (text "Saved")' });
  assert.deepEqual(compareFlow({ ...r, steps: [...r.steps.slice(0, 2), { expect: { text: 'Note saved' } }] }, r), { kind: 'weakened', text: 'changes the expect at step 3 (text "Saved" -> text "Note saved")' });
  assert.equal(compareFlow({ ...r, steps: [...r.steps, { expect: { text: 'More' } }] }, r).kind, 'expects-added');
  assert.deepEqual(compareFlow({ ...r, steps: [{ goto: '/a' }, { click: { text: 'Go now' } }, r.steps[2]] }, r), { kind: 'steps-changed', text: 'step 2 changed' });
  assert.deepEqual(compareFlow({ ...r, signedIn: false }, r), { kind: 'weakened', text: 'changes signedIn' });
  assert.equal(compareFlow({ ...r, schema: '0.2.0' }, r).kind, 'expects-added', 'a schema change alone never weakens');
  // NFC against NFD in a fill value is a change.
  const fill = (v) => ({ ...r, steps: [{ goto: '/a' }, { fill: { label: 'Name' }, value: v }, r.steps[2]] });
  assert.equal(compareFlow(fill('José'), fill('José')).kind, 'steps-changed');
});

test('tests: found, spec, because and added checks run as written; a removed check or changed attack waits', () => {
  const r = { schema: '0.1.0', flow: 'f', attack: { fault: '500' }, checks: ['settles', { id: 'app-x', at: 'end', assert: {}, spec: 'a', because: 'b' }], found: { run: 'x' } };
  assert.equal(compareTest({ ...r, found: { run: 'y' } }, r).asWritten, true);
  assert.equal(compareTest({ ...r, checks: ['settles', { id: 'app-x', at: 'end', assert: {}, spec: 'c', because: 'd' }] }, r).asWritten, true);
  assert.equal(compareTest({ ...r, checks: [...r.checks, 'no-uncaught-error'] }, r).asWritten, true);
  assert.deepEqual(compareTest({ ...r, checks: [r.checks[1]] }, r), { asWritten: false, text: 'removes or changes a check' });
  assert.deepEqual(compareTest({ ...r, attack: { fault: '400' } }, r), { asWritten: false, text: 'changes attack' });
});

test('config: an added remote-writes host waits, a removed exclude stays, an added one applies, target.url applies marked', () => {
  const r = { schema: '0.1.0', exclude: ['/admin/**'], allow: { remoteWrites: ['a.example'] } };
  const w = { schema: '0.1.0', exclude: ['/billing/**'], target: { url: 'http://localhost:4000' }, allow: { remoteWrites: ['a.example', 'abcd1234.supabase.co'], remoteTarget: 'staging.example' } };
  const out = effectiveConfig(w, r, 'origin/main');
  assert.deepEqual(out.config.allow, { remoteWrites: ['a.example'] });
  assert.deepEqual(out.config.exclude, ['/billing/**', '/admin/**']);
  assert.equal(out.config.target.url, 'http://localhost:4000');
  assert.deepEqual(out.lines, ["config.yaml: allow.remoteWrites adds abcd1234.supabase.co, which origin/main's config doesn't have. Not applied until merged; browser writes there are still aborted."]);
  assert.deepEqual(out.entries.map((e) => `${e.change} -> ${e.outcome}`), [
    'allow.remoteWrites adds abcd1234.supabase.co; allow.remoteTarget sets staging.example; exclude removes /admin/** -> not applied until merged',
    'changes target.url, exclude adds entries (changed outside review) -> applied',
  ]);
  // No reviewed config: none of the safety values apply.
  assert.deepEqual(effectiveConfig(w, null, 'origin/main').config.allow, { remoteWrites: [] });
});

test('in a repo: reformatted copies count as unchanged; a removed expect runs origin/main\'s version; the block and JSON say so', async () => {
  const { root, write } = repoWith({ '.rough-ride/config.yaml': CONFIG, '.rough-ride/flows/create-note.yaml': FLOW, '.rough-ride/flows/search.yaml': FLOW, '.rough-ride/tests/t.yaml': TEST });
  // CRLF, BOM, re-quoted and re-ordered: same content.
  write('.rough-ride/flows/search.yaml', '﻿' + FLOW.replace('signedIn: true\n', '').replace('schema: 0.1.0\n', "schema: '0.1.0'\nsignedIn: true\n").replace(/\n/g, '\r\n'));
  write('.rough-ride/flows/create-note.yaml', FLOW.replace('  - expect: {text: Saved}\n', ''));
  write('.rough-ride/tests/t.yaml', TEST.replace('checks: [visible-error-message, settles]', 'checks: [settles]'));
  const out = await compare(root);
  assert.equal(out.base.shown, 'origin/main');
  assert.deepEqual(out.flows.map((f) => `${f.flow.name} ${f.used}`), ['create-note reviewed', 'search working-tree']);
  assert.equal(out.flows[0].flow.steps.length, 4, 'the reviewed version, with its expect');
  const lines = blockLines(out);
  assert.match(lines[0], /^Protected files changed since origin\/main \([0-9a-f]{7}\):$/);
  assert.deepEqual(lines.slice(1), [
    '  flows/create-note.yaml: removes the expect at step 4 (text "Saved") -> ran the origin/main version',
    '  tests/t.yaml: removes or changes a check -> ran the origin/main version (pending until merged)',
    '  flows/search.yaml: reformatted (same content) -> ran this version',
  ]);
  assert.equal(out.entries.find((e) => e.path === 'flows/create-note.yaml').used, 'reviewed');
  assert.equal(out.tests[0].pending, true);
  assert.ok(out.compareLine.startsWith('Protected files compared with origin/main ('));
  assert.ok(summaryLines(out).length <= 4);
  assert.deepEqual(out.notes, []);
});

test('in a repo: a working copy equal to the base ref\'s own version runs even when the merge base differs; --base never moves the reviewed base', async () => {
  const { root, write } = repoWith({ '.rough-ride/flows/f.yaml': FLOW });
  // main moves on with a flow that drops the expect, after the branch point.
  sh(root, 'checkout', '-q', 'main');
  write('.rough-ride/flows/f.yaml', FLOW.replace('  - expect: {text: Saved}\n', ''));
  sh(root, 'commit', '-qam', 'main moves');
  sh(root, 'push', '-q', 'origin', 'main');
  sh(root, 'fetch', '-q', 'origin');
  sh(root, 'checkout', '-q', 'feature');
  write('.rough-ride/flows/f.yaml', FLOW.replace('  - expect: {text: Saved}\n', ''));
  const out = await compare(root);
  assert.equal(out.flows[0].used, 'working-tree');
});

test('trust lines: no remote, a ref moved by update-ref, no base branch; GITHUB_BASE_REF ignored with a plugin data folder', async () => {
  const local = repoWith({ '.rough-ride/flows/f.yaml': FLOW }, { remote: false });
  assert.equal((await compare(local.root)).notes[0].text, "Protected files compared with local main (no remote). Commits on main count as reviewed, so rough-ride can't tell your commits there from an agent's.");
  const moved = repoWith({ '.rough-ride/flows/f.yaml': FLOW });
  sh(moved.root, 'commit', '-q', '--allow-empty', '-m', 'agent commit');
  sh(moved.root, 'update-ref', 'refs/remotes/origin/main', sh(moved.root, 'rev-parse', 'HEAD').trim());
  assert.equal((await compare(moved.root)).notes[0]?.text, 'origin/main was last moved by something other than fetch, pull or push: protected files may be compared with an unreviewed commit.');
  const none = gitRepo();
  writeFileSync(path.join(none, 'a.txt'), 'x');
  sh(none, 'add', '-A');
  sh(none, 'commit', '-qm', 'x');
  sh(none, 'branch', '-M', 'dev');
  mkdirSync(path.join(none, '.rough-ride'));
  assert.equal((await compare(none)).notes[0].text, 'Protected files: no reviewed version (no base branch found). Files are used as they are.');
  const ci = repoWith({ '.rough-ride/flows/f.yaml': FLOW });
  assert.equal((await compare(ci.root, { GITHUB_BASE_REF: 'nope' }, true)).base.shown, 'origin/main');
});

test('CI inputs are listed and never judged; extra Node code is disclosed; files rewritten during the run are not used', async () => {
  const { root, write } = repoWith({ '.rough-ride/flows/f.yaml': FLOW, '.github/workflows/ci.yml': 'on: push\n', 'package.json': '{"devDependencies":{"rough-ride":"0.1.0"}}\n' });
  write('.github/workflows/ci.yml', 'on: pull_request\n');
  write('package.json', '{"devDependencies":{"rough-ride":"0.2.0"}}\n');
  const out = await compare(root);
  assert.deepEqual(out.entries.filter((e) => e.kind === 'ci').map((e) => `${e.path}: ${e.change} -> ${e.outcome}`), [
    '.github/workflows/ci.yml: CI workflow changed -> listed, not judged',
    'package.json: the rough-ride pin changed -> listed, not judged',
  ]);
  assert.deepEqual(summaryLines(out), ['Protected files: 2 changes since origin/main, used as written (report.txt)']);
  assert.equal(extraNodeCodeNote([], '--require ./x.cjs').text, 'Node loads extra code into rough-ride (--require ./x.cjs from NODE_OPTIONS); code loaded this way could change its verdicts.');
  assert.equal(extraNodeCodeNote([], '--max-old-space-size=4096'), null);
  write('.rough-ride/flows/f.yaml', FLOW + '  - expect: {text: More}\n');
  assert.equal(changedDuringRun(path.join(root, '.rough-ride'), out.texts).text, 'Changed during this run, not used: .rough-ride/flows/f.yaml.');
});
