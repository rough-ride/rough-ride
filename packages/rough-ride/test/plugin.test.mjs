import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { fixture, scratchDir } from './helpers.mjs';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const PREFLIGHT_RULE = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/preflight.mjs" "${CLAUDE_PLUGIN_DATA}"';
const PREFLIGHT_LINE = '!`' + PREFLIGHT_RULE + '`';
const EDIT_GUARD_OFF =
  "Edit guard: not running in this session. rough-ride's hooks did not start (hooks turned off by settings or policy, another copy holds the name, or node is missing for hooks), so edits under .rough-ride/ are not blocked.";
const FLOOR = (v) =>
  `rough-ride ${v} needs Claude Code 2.1.299 or later; this session runs 2.1.250. Older versions let a failed edit-blocking hook through. Update with claude update, restart Claude Code, then run /rough-ride:quick again.`;
const VERSION = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;

function frontmatter(file) {
  const text = readFileSync(path.join(PKG, file), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(match, `${file} has frontmatter`);
  return { data: parse(match[1]), keys: Object.keys(parse(match[1])), body: match[2], text };
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

for (const tier of ['quick', 'standard']) {
  test(`skills/${tier}: exact frontmatter, the preflight rules, no argument placeholders, preflight first and refusal last`, () => {
    const { data, keys, body } = frontmatter(`skills/${tier}/SKILL.md`);
    assert.deepEqual(keys, ['name', 'description', 'context', 'agent', 'background', 'allowed-tools']);
    assert.equal(data.name, tier);
    assert.equal(data.context, 'fork');
    assert.equal(data.agent, 'rough-ride:adversary');
    assert.equal(data.background, false);
    // Ticket 02's probes: heredoc calls don't match prefix rules, so the
    // runner rules leave allowed-tools and guard rule 7 allows them (41.3).
    assert.deepEqual(data['allowed-tools'], [`Bash(${PREFLIGHT_RULE})`, `PowerShell(${PREFLIGHT_RULE})`]);
    assert.ok(!/\$(ARGUMENTS|\d|[A-Za-z_{])/.test(body.replace(/\$\{CLAUDE_PLUGIN_(ROOT|DATA)\}/g, '')), 'no argument placeholder');
    assert.equal(body.split('\n')[0], PREFLIGHT_LINE);
    assert.ok(
      body.trimEnd().endsWith(`reply exactly: Refused: rough-ride takes no arguments. Run /rough-ride:${tier} again with nothing after it. Requirements go in .rough-ride/specs/<name>.txt, which you write yourself.`),
    );
    assert.ok(body.includes('`ARGUMENTS:`'));
  });
}

test('agents/adversary.md: frontmatter equals 41.2', () => {
  const { data, keys, body } = frontmatter('agents/adversary.md');
  assert.deepEqual(keys, ['name', 'description', 'tools', 'model', 'omitClaudeMd', 'maxTurns']);
  assert.deepEqual(data, {
    name: 'adversary',
    description: "rough-ride's adversary. Started only by /rough-ride:quick and /rough-ride:standard.",
    tools: 'Read, Grep, Glob, Bash',
    model: 'inherit',
    omitClaudeMd: true,
    maxTurns: 60,
  });
  assert.ok(body.includes("reply exactly: Refused: rough-ride's adversary needs Claude Code's Bash tool; on Windows that is Git Bash from Git for Windows."));
});

test('no skill or agent text names a package runner or the unscoped agent', () => {
  for (const file of [...walk(path.join(PKG, 'skills')), ...walk(path.join(PKG, 'agents'))]) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/npx|dlx|bunx/.test(text), file);
    assert.ok(!/agent:\s*adversary\b/.test(text), file);
    assert.ok(/browser download/.test(text), `${file} states the browser-download rule`);
  }
});

test('hooks.json registers the SessionStart hook in exec form', () => {
  const hooks = JSON.parse(readFileSync(path.join(PKG, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(hooks.hooks.SessionStart, [
    { hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs'], timeout: 5 }] },
  ]);
});

// A plugins root with a copy of this package installed under `ids`, as
// Claude Code lays it out. Returns the paths a hook sees.
function pluginsHome({ ids = [], withPackages = true } = {}) {
  const home = scratchDir();
  const plugins = path.join(home, 'plugins');
  const records = {};
  let first = null;
  for (const [id, version] of ids) {
    const [plugin, marketplace] = id.split('@');
    const dir = path.join(plugins, 'cache', marketplace, plugin, version);
    mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'rough-ride', version }));
    cpSync(path.join(PKG, 'hooks'), path.join(dir, 'hooks'), { recursive: true });
    cpSync(path.join(PKG, 'package.json'), path.join(dir, 'package.json'));
    if (withPackages) {
      mkdirSync(path.join(dir, 'node_modules', 'playwright-core'), { recursive: true });
      writeFileSync(path.join(dir, 'node_modules', 'playwright-core', 'package.json'), '{"version":"1.64.1"}');
    }
    records[id] = [{ scope: 'user', installPath: dir, version }];
    first ??= { root: dir, data: path.join(plugins, 'data', `${plugin}-${marketplace}`) };
  }
  mkdirSync(plugins, { recursive: true });
  writeFileSync(path.join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: records }));
  return { home, plugins, ...first };
}

const CLEAN_ENV = { AI_AGENT: '', CLAUDE_CODE_EXECPATH: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_PLUGIN_ROOT: '', CLAUDE_PLUGIN_DATA: '' };

function hook(script, { root, data, stdin = '', env = {}, args = [], preload, cwd } = {}) {
  const file = path.join(root, 'hooks', script);
  const nodeArgs = preload ? ['--import', pathToFileURL(preload).href, file, ...args] : [file, ...args];
  const r = spawnSync(process.execPath, nodeArgs, {
    input: stdin,
    encoding: 'utf8',
    cwd: cwd ?? scratchDir(),
    env: { ...process.env, ...CLEAN_ENV, ...(script === 'session-start.mjs' ? { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data } : {}), ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const message = (stdout) => (stdout === '' ? null : JSON.parse(stdout).systemMessage);

test('session-start: prints nothing when every condition passes, and writes only the session marker', () => {
  const p = pluginsHome({ ids: [['rough-ride@rough-ride', VERSION]] });
  const r = hook('session-start.mjs', { ...p, stdin: JSON.stringify({ session_id: 'abc-123', cwd: p.home }), env: { AI_AGENT: 'claude-code_2-1-311_agent' } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.deepEqual(walk(p.data), [path.join(p.data, 'sessions', 'abc-123')]);
  assert.equal(readFileSync(path.join(p.data, 'sessions', 'abc-123'), 'utf8'), '');
});

test('session-start: deletes markers older than 7 days and keeps newer ones', () => {
  const p = pluginsHome({ ids: [['rough-ride@rough-ride', VERSION]] });
  const sessions = path.join(p.data, 'sessions');
  mkdirSync(sessions, { recursive: true });
  for (const [name, days] of [['old', 8], ['recent', 6]]) {
    writeFileSync(path.join(sessions, name), '');
    const t = new Date(Date.now() - days * 86_400_000);
    utimesSync(path.join(sessions, name), t, t);
  }
  hook('session-start.mjs', { ...p, stdin: JSON.stringify({ session_id: 'new' }) });
  assert.deepEqual(readdirSync(sessions).sort(), ['new', 'recent']);
});

test('session-start: each condition prints its exact message as systemMessage, and it still exits 0', () => {
  const two = pluginsHome({ ids: [['rough-ride@rough-ride', '0.9.3'], ['rough-ride@claude-plugins-official', '1.0.0']] });
  assert.equal(
    message(hook('session-start.mjs', { ...two, stdin: '{"session_id":"s"}' }).stdout),
    "rough-ride is installed twice: rough-ride@rough-ride 0.9.3 and rough-ride@claude-plugins-official 1.0.0. Only one copy's hooks run, and each copy keeps its own data folder. Remove one: /plugin uninstall rough-ride@rough-ride",
  );
  // A copy turned off in the user's settings doesn't count.
  writeFileSync(path.join(two.home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'rough-ride@claude-plugins-official': false } }));
  assert.equal(hook('session-start.mjs', { ...two, stdin: '{"session_id":"s"}' }).stdout, '');

  const one = pluginsHome({ ids: [['rough-ride@rough-ride', VERSION]] });
  const inline = hook('session-start.mjs', { root: PKG, data: one.data, stdin: '{"session_id":"s"}' });
  assert.equal(message(inline.stdout), `rough-ride is loaded from ${PKG.replace(/\/$/, '')} for this session (--plugin-dir) and replaces the installed copy.`);

  assert.equal(message(hook('session-start.mjs', { ...one, stdin: '{}', env: { AI_AGENT: 'claude-code_2-1-250_agent' } }).stdout), FLOOR(VERSION));

  const bare = pluginsHome({ ids: [['rough-ride@rough-ride', VERSION]], withPackages: false });
  assert.equal(
    message(hook('session-start.mjs', { ...bare, stdin: '{}' }).stdout),
    "rough-ride's packages are not installed: Claude Code's install of them did not finish (60-second limit). Run in your shell: claude plugin update rough-ride@rough-ride",
  );

  const old = hook('session-start.mjs', { ...one, stdin: '{}', preload: fixture('fake-node-20.mjs') });
  assert.equal(old.code, 0);
  assert.equal(message(old.stdout), `rough-ride's hooks run on Node 20.18.1 (${process.execPath}); the runner needs 22.22 or later.`);
});

test('session-start: unreadable input prints nothing and exits 0', () => {
  const p = pluginsHome({ ids: [['rough-ride@rough-ride', VERSION]] });
  writeFileSync(path.join(p.plugins, 'installed_plugins.json'), 'not json');
  const r = hook('session-start.mjs', { ...p, stdin: 'garbage' });
  assert.deepEqual([r.code, r.stdout], [0, '']);
  assert.ok(!existsSync(path.join(p.data, 'sessions')), 'no marker without a session id');
});

test('preflight: exits 1 on an old Claude Code, missing packages or an old Node, printing the message', () => {
  const p = pluginsHome({ ids: [['rough-ride@rough-ride', VERSION]] });
  const floor = hook('preflight.mjs', { ...p, args: [p.data], env: { AI_AGENT: 'claude-code_2-1-250_agent' } });
  assert.deepEqual([floor.code, floor.stdout], [1, FLOOR(VERSION) + '\n']);

  const bare = pluginsHome({ ids: [['rough-ride@rough-ride', VERSION]], withPackages: false });
  const missing = hook('preflight.mjs', { ...bare, args: [bare.data] });
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /^rough-ride's packages are not installed: .* claude plugin update rough-ride@rough-ride\n$/);

  const old = hook('preflight.mjs', { ...p, args: [p.data], preload: fixture('fake-node-20.mjs') });
  assert.equal(old.code, 1);
  assert.equal(old.stdout, `rough-ride needs Node.js 22.22.0 or later; this is Node 20.18.1 at ${process.execPath}. A per-project version manager (Volta, asdf, mise, fnm, nvm) may have picked it from this project's settings. Install Node 22.22 or later for this project and run again.\n`);
});

test('preflight: prints the edit-guard line without a marker, nothing with one, and deletes this session\'s adversary-runs file', () => {
  const p = pluginsHome({ ids: [['rough-ride@rough-ride', VERSION]] });
  const runs = path.join(p.data, 'adversary-runs');
  mkdirSync(runs, { recursive: true });
  writeFileSync(path.join(runs, 'sess-1.json'), '{}');
  writeFileSync(path.join(runs, 'other.json'), '{}');
  const off = hook('preflight.mjs', { ...p, args: [p.data], env: { CLAUDE_CODE_SESSION_ID: 'sess-1' } });
  assert.deepEqual([off.code, off.stdout], [0, EDIT_GUARD_OFF + '\n']);
  assert.deepEqual(readdirSync(runs), ['other.json']);

  mkdirSync(path.join(p.data, 'sessions'), { recursive: true });
  writeFileSync(path.join(p.data, 'sessions', 'sess-1'), '');
  const on = hook('preflight.mjs', { ...p, args: [p.data], env: { CLAUDE_CODE_SESSION_ID: 'sess-1' } });
  assert.deepEqual([on.code, on.stdout], [0, '']);
});
