import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  blockLines, changedDuringRun, compareFlow, compareProtected, compareTest, effectiveConfig, extraNodeCodeNote, summaryLines,
} from '../dist/protected.mjs';
import { checkCommittedFiles } from '../dist/files.mjs';
import { checkRootEntry } from '../dist/folder.mjs';
import { ReviewedVersions } from '../dist/reviewed.mjs';
import { gitRepo, memoryBlobs, scratchDir, sh } from './helpers.mjs';

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
found: {finding: no error shown, run: 20261025-141207-quick-k3fz, runner: "0.1.0", date: "2026-10-25"}
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

const info = { version: '0.1.0', cliPath: '/x/dist/cli.mjs', source: { kind: 'other', detail: '/x', resolved: null }, pluginId: null, pluginData: null, node: '22.22.1', playwright: '1.64.1', claudeCode: { version: null, floorChecked: false }, editGuard: 'n/a', versionSkew: null };

// The working tree's files, checked as every subcommand checks them.
const checked = (root) => checkCommittedFiles(checkRootEntry(root), { info: { ...info }, subcommand: 'quick', argv: ['quick'], env: {} });

const compare = async (root, env = {}, pluginData = false) =>
  compareProtected({ root, folderDir: path.join(root, '.rough-ride'), files: checked(root), env, pluginData });

const MERGE = 'm'.repeat(40);
const REF = 'f'.repeat(40);

// Working files on disk; reviewed versions in memory, at the merge base and,
// when `ref` is given, at the base ref's own commit. Paths are relative to .rough-ride/.
function compareIn({ working = {}, merge = {}, ref = null }) {
  const root = scratchDir();
  mkdirSync(path.join(root, '.rough-ride'));
  for (const [rel, text] of Object.entries(working)) {
    mkdirSync(path.dirname(path.join(root, '.rough-ride', rel)), { recursive: true });
    writeFileSync(path.join(root, '.rough-ride', rel), text);
  }
  const inFolder = (files) => Object.fromEntries(Object.entries(files).map(([rel, text]) => [`.rough-ride/${rel}`, text]));
  const blobs = memoryBlobs({ [MERGE]: inFolder(merge), ...(ref ? { [REF]: inFolder(ref) } : {}) });
  const reviewed = new ReviewedVersions(blobs, { shown: 'origin/main', ref: 'refs/remotes/origin/main', mergeBase: MERGE, refSha: ref ? REF : MERGE, local: false });
  return compareProtected({ root, folderDir: path.join(root, '.rough-ride'), files: checked(root), env: {}, pluginData: false, reviewed });
}

const lines = (out) => out.entries.map((e) => `${e.path}: ${e.change} -> ${e.outcome} [${e.used}]`);
const NO_EXPECT = FLOW.replace('  - expect: {text: Saved}\n', '');
const STEP_CHANGED = FLOW.replace('{role: button, name: Save}', '{role: button, name: Submit}');

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

test('which flow runs: each rung of 26.5 against one reviewed version', () => {
  const flowCase = (working) => {
    const out = compareIn({ working: working === null ? {} : { 'flows/f.yaml': working }, merge: { 'flows/f.yaml': FLOW } });
    return { flows: out.flows.map((f) => `${f.flow.name} ${f.used} ${f.reviewed} ${f.stepsChanged ? 'steps-changed' : '-'} ${f.flow.steps.length}`), lines: lines(out), notRun: out.notRun };
  };
  assert.deepEqual(flowCase(FLOW), { flows: ['f working-tree true - 4'], lines: [], notRun: [] });
  assert.deepEqual(flowCase(FLOW.replace('signedIn: true', 'signedIn: true # a comment')), { flows: ['f working-tree true - 4'], lines: ['flows/f.yaml: reformatted (same content) -> ran this version [working-tree]'], notRun: [] });
  assert.deepEqual(flowCase(FLOW + '  - expect: {text: More}\n'), { flows: ['f working-tree true - 5'], lines: ['flows/f.yaml: adds 1 expect -> ran this version [working-tree]'], notRun: [] });
  assert.deepEqual(flowCase(STEP_CHANGED), { flows: ['f reviewed true steps-changed 4'], lines: ['flows/f.yaml: step 3 changed -> ran the origin/main version [reviewed]'], notRun: [] });
  assert.deepEqual(flowCase(NO_EXPECT), { flows: ['f reviewed true - 4'], lines: ['flows/f.yaml: removes the expect at step 4 (text "Saved") -> ran the origin/main version [reviewed]'], notRun: [] });
  assert.deepEqual(flowCase(null), { flows: ['f reviewed true - 4'], lines: ['flows/f.yaml: deleted -> ran the origin/main version [reviewed]'], notRun: [] });
  assert.deepEqual(flowCase(FLOW + 'extra: 1\n'), { flows: ['f reviewed true - 4'], lines: ['flows/f.yaml: invalid -> ran the origin/main version [reviewed]'], notRun: [] });
});

test('which flow runs with no reviewed version: a valid one runs and is listed as new', () => {
  const out = compareIn({ working: { 'flows/f.yaml': FLOW } });
  assert.deepEqual(out.flows.map((f) => `${f.flow.name} ${f.used} ${f.reviewed}`), ['f working-tree false']);
  assert.deepEqual(lines(out), ['flows/f.yaml: new, no reviewed version -> ran this version [working-tree]']);
});

test('which test runs: each rung of 26.6 against one reviewed version', () => {
  const testCase = (working, merge = { 'tests/t.yaml': TEST }) => {
    const out = compareIn({ working: working === null ? {} : { 'tests/t.yaml': working }, merge });
    return { tests: out.tests.map((t) => `${t.name} ${t.used} ${t.pending} ${t.value.checks.length}`), lines: lines(out) };
  };
  assert.deepEqual(testCase(TEST), { tests: ['t working-tree false 2'], lines: [] });
  assert.deepEqual(testCase(TEST.replace('quick-k3fz', 'quick-aaaa')), { tests: ['t working-tree false 2'], lines: ["tests/t.yaml: changes found or a check's spec or because -> ran this version [working-tree]"] });
  assert.deepEqual(testCase(TEST.replace('settles]', 'settles, no-uncaught-error]')), { tests: ['t working-tree false 3'], lines: ['tests/t.yaml: adds checks -> ran this version [working-tree]'] });
  assert.deepEqual(testCase(TEST.replace('[visible-error-message, settles]', '[settles]')), { tests: ['t reviewed true 2'], lines: ['tests/t.yaml: removes or changes a check -> ran the origin/main version (pending until merged) [reviewed]'] });
  assert.deepEqual(testCase(null), { tests: ['t reviewed true 2'], lines: ['tests/t.yaml: deleted -> ran the origin/main version (pending until merged) [reviewed]'] });
  assert.deepEqual(testCase(TEST + 'extra: 1\n'), { tests: ['t reviewed true 2'], lines: ['tests/t.yaml: invalid -> ran the origin/main version (pending until merged) [reviewed]'] });
  assert.deepEqual(testCase(TEST + 'extra: 1\n', {}), { tests: [], lines: ['tests/t.yaml: invalid, no reviewed version (stale) -> not run [none]'] });
  assert.deepEqual(testCase(TEST, {}), { tests: ['t working-tree false 2'], lines: [] });
});

test('a reviewed version below the floor is not compared, and the working copy is used, for every kind (26.3, 26.13)', () => {
  const OLD = (t) => t.replace('schema: 0.1.0', 'schema: 0.0.9');
  const used = `the origin/main version is in a format this runner can't read (schema 0.0.9), so this version is used`;
  const flow = compareIn({ working: { 'flows/f.yaml': NO_EXPECT }, merge: { 'flows/f.yaml': OLD(FLOW) } });
  assert.deepEqual(flow.flows.map((f) => `${f.used} ${f.flow.steps.length}`), ['working-tree 3']);
  assert.deepEqual(lines(flow), [`flows/f.yaml: ${used} -> ran this version [working-tree]`]);
  const test = compareIn({ working: { 'tests/t.yaml': TEST }, merge: { 'tests/t.yaml': OLD(TEST) } });
  assert.deepEqual(test.tests.map((t) => `${t.used} ${t.pending}`), ['working-tree false']);
  assert.deepEqual(lines(test), [`tests/t.yaml: ${used} -> ran this version [working-tree]`]);
  const entry = (check) => `  - {page: /notes/new, step: click, action: POST /api/notes, check: ${check}, because: on purpose}\n`;
  const both = compareIn({
    working: { 'accepted.yaml': 'schema: 0.1.0\naccepted:\n' + entry('settles'), 'config.yaml': CONFIG.replace('[api.example.com]', '[api.example.com, new.example.com]') },
    merge: { 'accepted.yaml': 'schema: 0.0.9\naccepted: []\n', 'config.yaml': OLD(CONFIG) },
  });
  assert.deepEqual(both.accepted.map((e) => e.check), ['settles']);
  assert.deepEqual(both.config.allow.remoteWrites, ['api.example.com', 'new.example.com']);
  assert.deepEqual(lines(both), [`accepted.yaml: ${used} -> applied [working-tree]`, `config.yaml: ${used} -> applied [working-tree]`]);
});

test('a reviewed version written for a newer rough-ride stops the invocation, as a newer working copy does (ADR 0002): a weakened working copy never runs, for every kind', () => {
  const NEWER = (t) => t.replace('schema: 0.1.0', 'schema: 9.0.0');
  const entry = (check) => `  - {page: /notes/new, step: click, action: POST /api/notes, check: ${check}, because: on purpose}\n`;
  const cases = [
    ['flows/f.yaml', NO_EXPECT, NEWER(FLOW)],
    ['tests/t.yaml', TEST.replace('[visible-error-message, settles]', '[settles]'), NEWER(TEST)],
    ['accepted.yaml', 'schema: 0.1.0\naccepted:\n' + entry('settles'), 'schema: 9.0.0\naccepted: []\n'],
    ['config.yaml', CONFIG.replace('[api.example.com]', '[api.example.com, new.example.com]'), NEWER(CONFIG)],
  ];
  for (const [p, working, merge] of cases) {
    assert.throws(() => compareIn({ working: { [p]: working }, merge: { [p]: merge } }), (error) => {
      assert.equal(error.stop.code, 'schema-newer');
      assert.deepEqual(error.stop.lines, [
        "rough-ride 0.1.0 can't read 1 file written for a newer rough-ride:",
        `  .rough-ride/${p} (origin/main version)  schema: 9.0.0`,
        'They need rough-ride 9.0.0 or later. This invocation used 0.1.0 from other /x.',
        'Update it: Install rough-ride 9.0.0 or later.',
      ]);
      return true;
    }, p);
  }
});

test('a reviewed version that fails this runner\'s checks is kept, not compared, and neither version runs: no flow or test runs, no accepted entry or allow host applies', () => {
  const why = "the origin/main version doesn't pass this runner's checks";
  for (const merge of [FLOW + 'extra: 1\n', 'schema: 0.1.0\nsteps: [\n']) {
    const out = compareIn({ working: { 'flows/f.yaml': NO_EXPECT }, merge: { 'flows/f.yaml': merge } });
    assert.deepEqual(out.flows, []);
    assert.deepEqual(out.notRun, ['f']);
    assert.deepEqual(lines(out), [`flows/f.yaml: ${why}, so neither version runs -> not run [none]`]);
  }
  const deleted = compareIn({ merge: { 'flows/f.yaml': FLOW + 'extra: 1\n' } });
  assert.deepEqual([deleted.flows, deleted.notRun, lines(deleted)], [[], [], [`flows/f.yaml: deleted; ${why} -> not run [none]`]]);
  const test = compareIn({ working: { 'tests/t.yaml': TEST.replace('[visible-error-message, settles]', '[settles]') }, merge: { 'tests/t.yaml': TEST + 'extra: 1\n' } });
  assert.deepEqual(test.tests, []);
  assert.deepEqual(lines(test), [`tests/t.yaml: ${why}, so neither version runs -> not run [none]`]);
  const entry = (check) => `  - {page: /notes/new, step: click, action: POST /api/notes, check: ${check}, because: on purpose}\n`;
  const both = compareIn({
    working: { 'accepted.yaml': 'schema: 0.1.0\naccepted:\n' + entry('settles'), 'config.yaml': CONFIG.replace('[api.example.com]', '[api.example.com, new.example.com]') },
    merge: { 'accepted.yaml': 'schema: 0.1.0\naccepted:\n' + entry('settles') + 'extra: 1\n', 'config.yaml': CONFIG + 'extra: 1\n' },
  });
  assert.deepEqual(both.accepted, []);
  assert.deepEqual(both.config.allow.remoteWrites, []);
  assert.equal(both.config.reset, 'npm run db:reset', 'the working copy still gives the values outside review');
  assert.deepEqual(lines(both), [
    `accepted.yaml: ${why}, so no entry in this version applies -> not applied until merged [none]`,
    `config.yaml: ${why}, so this version's allow values are not applied -> not applied until merged [none]`,
  ]);
  assert.deepEqual(both.entries.map((e) => e.notApplied), [
    ['Accepted outside review, not applied until merged: /notes/new click POST /api/notes settles.'],
    ['allow.remoteWrites adds api.example.com', 'allow.remoteWrites adds new.example.com'],
  ]);
});

test('a reviewed version this runner can\'t read never runs: with an invalid working copy too, the flow is listed and not run', () => {
  const out = compareIn({ working: { 'flows/f.yaml': FLOW + 'extra: 1\n' }, merge: { 'flows/f.yaml': FLOW.replace('schema: 0.1.0', 'schema: 0.0.9') } });
  assert.deepEqual(out.flows, []);
  assert.deepEqual(out.notRun, ['f']);
  assert.deepEqual(lines(out), ["flows/f.yaml: invalid; the origin/main version is in a format this runner can't read (schema 0.0.9) -> not run [none]"]);
});

test('content equal to either reviewed version counts as reviewed, for tests, accepted entries and config as for flows (26.3)', () => {
  const entry = (check) => `  - {page: /notes/new, step: click, action: POST /api/notes, check: ${check}, because: on purpose}\n`;
  const later = {
    'tests/t.yaml': TEST.replace('[visible-error-message, settles]', '[settles]'),
    'accepted.yaml': 'schema: 0.1.0\naccepted:\n' + entry('settles'),
    'config.yaml': CONFIG.replace('[api.example.com]', '[api.example.com, new.example.com]'),
  };
  const out = compareIn({ working: later, merge: { 'tests/t.yaml': TEST, 'config.yaml': CONFIG }, ref: later });
  assert.deepEqual(out.tests.map((t) => `${t.used} ${t.pending} ${t.value.checks.length}`), ['working-tree false 1']);
  assert.deepEqual(out.accepted.map((e) => e.check), ['settles']);
  assert.deepEqual(out.config.allow.remoteWrites, ['api.example.com', 'new.example.com']);
  assert.deepEqual(lines(out), []);
});

test('an invalid flow with no reviewed version or saved copy is listed and not run, as an invalid test is (26.5 rule 4)', () => {
  const out = compareIn({ working: { 'flows/f.yaml': FLOW + 'extra: 1\n' } });
  assert.deepEqual(out.flows, []);
  assert.deepEqual(out.notRun, ['f']);
  assert.deepEqual(lines(out), ['flows/f.yaml: invalid, no reviewed version -> not run [none]']);
});

test('a checkout with CRLF endings or a BOM is not a change: nothing is listed (27.3, core.autocrlf)', () => {
  const crlf = (text) => '﻿' + text.replace(/\n/g, '\r\n');
  const files = { 'flows/f.yaml': FLOW, 'tests/t.yaml': TEST, 'config.yaml': CONFIG };
  const out = compareIn({ working: Object.fromEntries(Object.entries(files).map(([p, t]) => [p, crlf(t)])), merge: files });
  assert.deepEqual(lines(out), []);
  assert.deepEqual(out.flows.map((f) => f.used), ['working-tree']);
});

test('accepted.yaml and config.yaml: entries and safety values only from the reviewed version', () => {
  const entry = (check) => `  - {page: /notes/new, step: click, action: POST /api/notes, check: ${check}, because: on purpose}\n`;
  const out = compareIn({
    working: { 'accepted.yaml': 'schema: 0.1.0\naccepted:\n' + entry('settles') + entry('values-survive'), 'config.yaml': CONFIG.replace('[api.example.com]', '[api.example.com, new.example.com]') },
    merge: { 'accepted.yaml': 'schema: 0.1.0\naccepted:\n' + entry('settles'), 'config.yaml': CONFIG },
  });
  assert.deepEqual(out.accepted.map((e) => e.check), ['settles']);
  assert.deepEqual(out.config.allow.remoteWrites, ['api.example.com']);
  assert.deepEqual(lines(out), [
    'accepted.yaml: adds 1 entry -> not applied until merged [reviewed]',
    'config.yaml: allow.remoteWrites adds new.example.com -> not applied until merged [reviewed]',
  ]);
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
