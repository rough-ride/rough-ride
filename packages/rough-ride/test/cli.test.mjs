import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fixture, gitRepo, run, scratchDir, sh } from './helpers.mjs';

const SUBCOMMANDS = ['quick', 'standard', 'plan', 'snapshot', 'link', 'flow save', 'attack', 'regress', 'repro', 'pr-comment'];
const NODE_STOP =
  'rough-ride needs Node.js 22.22.0 or later; this is Node 20.18.1 at ' +
  process.execPath +
  ". A per-project version manager (Volta, asdf, mise, fnm, nvm) may have picked it from this project's settings." +
  ' Install Node 22.22 or later for this project and run again.';

function assertCanonical(text) {
  const doc = JSON.parse(text);
  assert.ok(text.endsWith('}\n'));
  assert.equal(text.match(/^\{/gm).length, 1, 'exactly one JSON document');
  const sorted = (v) =>
    Array.isArray(v) ? v.map(sorted)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]))
    : v;
  assert.equal(text, JSON.stringify(sorted(doc), null, 2) + '\n');
  return doc;
}

function assertPlainAscii(text) {
  assert.ok(!/[^\x09\x0a\x20-\x7e]/.test(text), `non-ASCII, ANSI or \\r in ${JSON.stringify(text)}`);
}

test('--version prints the three versions and exits 0 outside any git repository', () => {
  const { code, stdout } = run(['--version']);
  assert.equal(code, 0);
  assert.match(stdout, /^rough-ride \d+\.\d+\.\d+ \| Playwright 1\.64\.1 \| Node \d+\.\d+\.\d+\n$/);
});

test('--help exits 0 outside any git repository', () => {
  const { code, stdout } = run(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /^Usage: rough-ride <subcommand>/);
  for (const name of SUBCOMMANDS) assert.ok(stdout.includes(name), name);
  assertPlainAscii(stdout);
});

test('an unknown subcommand, an unknown flag or no subcommand is a usage stop', () => {
  for (const args of [['bogus'], ['flow', 'load'], ['--frobnicate', 'quick'], []]) {
    const { code, stdout } = run(args);
    assert.equal(code, 64, args.join(' '));
    const lines = stdout.trimEnd().split('\n');
    assert.match(lines[0], /^rough-ride( \S.*)? \| \d+\.\ds \| stopped$/);
    assert.match(lines.at(-1), /^Runner: rough-ride \d+\.\d+\.\d+ from other .*cli\.mjs \| Node [\d.]+ \| Playwright 1\.64\.1$/);
    assertPlainAscii(stdout.replace(/^Runner: .*$/m, ''));
  }
});

test('with --json a usage stop prints one canonical document on stdout and the text on stderr', () => {
  const { code, stdout, stderr } = run(['bogus', '--json']);
  assert.equal(code, 64);
  const doc = assertCanonical(stdout);
  assert.equal(doc.status, 'stopped');
  assert.equal(doc.exitCode, 64);
  assert.deepEqual({ kind: doc.stop.kind, code: doc.stop.code }, { kind: 'usage', code: 'usage' });
  assert.match(stderr, /^rough-ride bogus \| /);
  assert.deepEqual(doc.summaryLines, stderr.trimEnd().split('\n'));
});

test('a non-ASCII word is escaped in the header and the JSON', () => {
  const { stdout } = run(['café', '--json']);
  assert.ok(stdout.includes('caf\\u00e9'));
  assertPlainAscii(stdout.replace(/"(detail|cwd)": ".*"/g, ''));
});

test('every subcommand not built yet answers so, as a usage stop', () => {
  for (const name of SUBCOMMANDS.filter((n) => !['quick', 'standard', 'regress', 'repro', 'flow save', 'pr-comment', 'plan', 'attack', 'snapshot', 'link'].includes(n))) {
    // An app change, so the tiers get past the diff.
    const repo = gitRepo();
    writeFileSync(path.join(repo, 'frontend', 'app.vue'), '<template />\n');
    const { code, stdout } = run([...name.split(' '), '--json'], { cwd: repo });
    assert.equal(code, 64, name);
    const doc = assertCanonical(stdout);
    assert.equal(doc.command, name);
    assert.equal(doc.stop.code, 'usage');
    assert.match(doc.stop.lines[0], new RegExp(`can't run ${name} yet`));
    assert.equal(doc.tier, name === 'quick' || name === 'standard' ? name : null);
  }
});

test('an old Node prints the exact stop, exits 69 and never loads main.mjs', () => {
  const { code, stdout, stderr } = run(['quick'], { preload: fixture('fake-node-20.mjs') });
  assert.equal(code, 69);
  assert.equal(stdout, NODE_STOP + '\n');
  assert.ok(!/main\.mjs|playwright/.test(stderr), stderr);
});

test('an old Node with --json prints one environment stop document', () => {
  const { code, stdout, stderr } = run(['quick', '--json'], { preload: fixture('fake-node-20.mjs') });
  assert.equal(code, 69);
  const doc = assertCanonical(stdout);
  assert.deepEqual(doc, {
    exitCode: 69,
    status: 'stopped',
    stop: { code: 'node-too-old', kind: 'environment', lines: [NODE_STOP] },
  });
  assert.ok(stderr.includes(NODE_STOP));
});

test('a rejection inside main.mjs exits 70 with status internal-error', () => {
  const { code, stdout, stderr } = run(['quick', '--json'], { preload: fixture('cwd-throws.mjs') });
  assert.equal(code, 70);
  assert.equal(assertCanonical(stdout).status, 'internal-error');
  assert.match(stderr, /cwd unavailable/);
});

test('an uncaught exception exits 70, never 1', () => {
  const { code, stderr } = run(['--version'], { preload: fixture('throw-later.mjs') });
  assert.equal(code, 70);
  assert.match(stderr, /thrown in a timer/);
});

test('regress: no tests prints its line and exits 0; an unknown --only, a path or --base is a usage stop', () => {
  const repo = gitRepo();
  writeFileSync(path.join(repo, 'README.md'), 'x\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'base');
  const none = run(['regress'], { cwd: repo });
  assert.equal(none.code, 0);
  assert.match(none.stdout, /^rough-ride regress \| [0-9.ms]+\nNo regression tests in \.rough-ride\/tests\/\.\nRunner: /);
  mkdirSync(path.join(repo, '.rough-ride', 'tests'), { recursive: true });
  writeFileSync(path.join(repo, '.rough-ride', 'tests', 'create-note-500-a41f0c.yaml'), 'schema: 0.1.0\nflow: create-note\nattack: {fault: "500", sticky: true, request: "POST /api/notes #1", page: /notes/new}\nchecks: [settles]\ncontext: {timezone: UTC, locale: en-US}\nfound: {run: x}\n');
  const unknown = run(['regress', '--only', 'no-such-test'], { cwd: repo });
  assert.equal(unknown.code, 64);
  assert.match(unknown.stdout, /No regression test named no-such-test\. Tests: create-note-500-a41f0c\./);
  assert.equal(run(['regress', 'tests/x.yaml'], { cwd: repo }).code, 64);
  assert.equal(run(['regress', '--base', 'HEAD'], { cwd: repo }).code, 64);
});

test('with a plugin data folder: the floor stop exits 69, an unread version proceeds, and the edit-guard line follows the runner line', () => {
  const data = scratchDir();
  const old = run(['quick', '--plugin-data', data], { env: { AI_AGENT: 'claude-code_2-1-250_agent' } });
  assert.equal(old.code, 69);
  assert.match(old.stdout, /needs Claude Code 2\.1\.299 or later; this session runs 2\.1\.250\./);
  const unknown = run(['bogus', '--plugin-data', data]);
  assert.equal(unknown.code, 64);
  const lines = unknown.stdout.trimEnd().split('\n');
  assert.match(lines.at(-3), /^Runner: .* \| Claude Code: unknown \(floor 2\.1\.299 not checked\) \| plugin data: .* \(from --plugin-data, not verified\)$/);
  assert.match(lines.at(-2), /^Edit guard: not running in this session\./);
  mkdirSync(path.join(data, 'sessions'));
  writeFileSync(path.join(data, 'sessions', 'sess-9'), '');
  const on = run(['bogus', '--plugin-data', data], { env: { CLAUDE_CODE_SESSION_ID: 'sess-9' } });
  assert.ok(!on.stdout.includes('Edit guard'));
});

test('a stop after the protected-files check reports protectedLines and protected; a usage stop reports null', () => {
  const repo = gitRepo();
  writeFileSync(path.join(repo, 'README.md'), 'x\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'base');
  mkdirSync(path.join(repo, '.rough-ride', 'tests'), { recursive: true });
  writeFileSync(path.join(repo, '.rough-ride', 'tests', 'create-note-500-a41f0c.yaml'), 'schema: 0.1.0\nflow: create-note\nattack: {fault: "500", sticky: true, request: "POST /api/notes #1", page: /notes/new}\nchecks: [settles]\ncontext: {timezone: UTC, locale: en-US}\nfound: {run: x}\n');
  const stop = run(['regress', '--only', 'nope', '--json'], { cwd: repo });
  assert.equal(stop.code, 64);
  const doc = JSON.parse(stop.stdout);
  assert.ok(Array.isArray(doc.protectedLines));
  assert.ok(Array.isArray(doc.protected));
  assert.deepEqual(doc.sections.flatMap((s) => s.lines), doc.summaryLines);
  assert.equal(JSON.parse(run(['bogus', '--json']).stdout).protectedLines, null);
});
