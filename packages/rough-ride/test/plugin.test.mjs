import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { fixture, scratchDir } from './helpers.mjs';
import { DUPLICATE, FLOOR, INLINE, OLD_NODE, PACKAGES, pluginsHome as home } from './fixtures/hook-rows.mjs';
import * as copy from '../hooks/plugin-checks.mjs';

const PKG = fileURLToPath(new URL('..', import.meta.url));
// Each tier skill names itself, so the preflight's floor stop says which skill to run again.
const PREFLIGHT_RULE = (tier) => `node "\${CLAUDE_PLUGIN_ROOT}/hooks/preflight.mjs" "\${CLAUDE_PLUGIN_DATA}" ${tier}`;
const PREFLIGHT_LINE = (tier) => '!`' + PREFLIGHT_RULE(tier) + '`';
const RUNNER = 'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"';
const EDIT_GUARD_OFF =
  "Edit guard: not running in this session. rough-ride's hooks did not start (hooks turned off by settings or policy, another copy holds the name, or node is missing for hooks), so edits under .rough-ride/ are not blocked.";
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
    assert.deepEqual(data['allowed-tools'], [`Bash(${PREFLIGHT_RULE(tier)})`, `PowerShell(${PREFLIGHT_RULE(tier)})`]);
    assert.ok(!/\$(ARGUMENTS|\d|[A-Za-z_{])/.test(body.replace(/\$\{CLAUDE_PLUGIN_(ROOT|DATA)\}/g, '')), 'no argument placeholder');
    assert.equal(body.split('\n')[0], PREFLIGHT_LINE(tier));
    assert.ok(
      body.trimEnd().endsWith(`reply exactly: Refused: rough-ride takes no arguments. Run /rough-ride:${tier} again with nothing after it. Requirements go in .rough-ride/specs/<name>.txt, which you write yourself.`),
    );
    assert.ok(body.includes('`ARGUMENTS:`'));
  });
}

// regress and repro run in the session that typed them: no fork, no adversary,
// one runner call whose only argument is what the skill checked.
for (const [name, hint, call, refusal] of [
  ['regress', '[test names]', `${RUNNER} regress --only <name> --plugin-data "\${CLAUDE_PLUGIN_DATA}"`, 'Refused: /rough-ride:regress takes test names made of lowercase letters, digits and dashes, or nothing.'],
  ['repro', '<run id>/r<n>', `${RUNNER} repro <id> --plugin-data "\${CLAUDE_PLUGIN_DATA}"`, 'Refused: /rough-ride:repro takes one finding id, such as 20261025-141207-quick-k3fz/r01, from a quick or standard summary.'],
]) {
  test(`skills/${name}: a main-session skill with one placeholder, one runner call and its refusal`, () => {
    const { data, keys, body } = frontmatter(`skills/${name}/SKILL.md`);
    assert.deepEqual(keys, ['name', 'description', 'argument-hint', 'allowed-tools']);
    assert.equal(data.name, name);
    assert.equal(data['argument-hint'], hint);
    assert.deepEqual(data['allowed-tools'], [`Bash(${RUNNER} ${name} *)`]);
    // The only placeholder is $ARGUMENTS, once; no shell line runs at load time.
    const rest = body.replace(/\$\{CLAUDE_PLUGIN_(ROOT|DATA)\}/g, '');
    assert.equal(rest.match(/\$ARGUMENTS/g)?.length, 1);
    assert.ok(!/\$(\d|[A-Za-z_{])/.test(rest.replace('$ARGUMENTS', '')), 'no other placeholder');
    assert.ok(!body.includes('!`'), 'no shell line');
    assert.ok(body.includes(`\n    ${call}\n`), 'the runner call, indented as code');
    assert.ok(body.includes(`reply exactly: ${refusal}`));
    assert.ok(body.includes('Use the Bash tool with timeout 600000, and run no other command.'));
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

const pluginsHome = (opts) => home(PKG, opts);

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
    DUPLICATE,
  );
  // A copy turned off in the user's settings doesn't count.
  writeFileSync(path.join(two.home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'rough-ride@claude-plugins-official': false } }));
  assert.equal(hook('session-start.mjs', { ...two, stdin: '{"session_id":"s"}' }).stdout, '');

  const one = pluginsHome({ ids: [['rough-ride@rough-ride', VERSION]] });
  const inline = hook('session-start.mjs', { root: PKG, data: one.data, stdin: '{"session_id":"s"}' });
  assert.equal(message(inline.stdout), INLINE(PKG));

  assert.equal(message(hook('session-start.mjs', { ...one, stdin: '{}', env: { AI_AGENT: 'claude-code_2-1-250_agent' } }).stdout), FLOOR(VERSION));

  const bare = pluginsHome({ ids: [['rough-ride@rough-ride', VERSION]], withPackages: false });
  assert.equal(
    message(hook('session-start.mjs', { ...bare, stdin: '{}' }).stdout),
    PACKAGES('rough-ride@rough-ride'),
  );

  const old = hook('session-start.mjs', { ...one, stdin: '{}', preload: fixture('fake-node-20.mjs') });
  assert.equal(old.code, 0);
  assert.equal(message(old.stdout), OLD_NODE('20.18.1', process.execPath));
});

test('session-start: a project-scope copy counts only for its own project, in any spelling of it', () => {
  const two = pluginsHome({ ids: [['rough-ride@rough-ride', '0.9.3'], ['rough-ride@claude-plugins-official', '1.0.0']] });
  const file = path.join(two.plugins, 'installed_plugins.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const cwd = scratchDir();
  const asProject = (projectPath) => {
    doc.plugins['rough-ride@claude-plugins-official'][0] = { ...doc.plugins['rough-ride@claude-plugins-official'][0], scope: 'project', projectPath };
    writeFileSync(file, JSON.stringify(doc));
    return message(hook('session-start.mjs', { ...two, stdin: JSON.stringify({ session_id: 's', cwd }) }).stdout);
  };
  assert.equal(asProject(scratchDir()), null);
  assert.equal(asProject(cwd + path.sep), DUPLICATE);
  if (process.platform === 'darwin') assert.equal(asProject(path.join('/System/Volumes/Data', cwd)), DUPLICATE);
});

test('session-start: an install record whose projectPath cannot be read is skipped, not the whole list', { skip: process.platform === 'win32' && 'POSIX permissions' }, () => {
  const three = pluginsHome({ ids: [['rough-ride@rough-ride', '0.9.3'], ['rough-ride@claude-plugins-official', '1.0.0'], ['rough-ride@third', '1.0.0']] });
  const file = path.join(three.plugins, 'installed_plugins.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const locked = path.join(scratchDir(), 'locked');
  mkdirSync(path.join(locked, 'project'), { recursive: true });
  doc.plugins['rough-ride@third'][0] = { ...doc.plugins['rough-ride@third'][0], scope: 'project', projectPath: path.join(locked, 'project') };
  writeFileSync(file, JSON.stringify(doc));
  chmodSync(locked, 0o000);
  try {
    assert.equal(message(hook('session-start.mjs', { ...three, stdin: JSON.stringify({ session_id: 's', cwd: scratchDir() }) }).stdout), DUPLICATE);
  } finally {
    chmodSync(locked, 0o700);
  }
});

test('session-start: a projectPath that cannot be read is compared with the cwd as written', { skip: process.platform === 'win32' && 'POSIX permissions' }, () => {
  const two = pluginsHome({ ids: [['rough-ride@rough-ride', '0.9.3'], ['rough-ride@claude-plugins-official', '1.0.0']] });
  const file = path.join(two.plugins, 'installed_plugins.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const locked = path.join(scratchDir(), 'locked');
  const project = path.join(locked, 'project');
  mkdirSync(project, { recursive: true });
  doc.plugins['rough-ride@claude-plugins-official'][0] = { ...doc.plugins['rough-ride@claude-plugins-official'][0], scope: 'project', projectPath: project };
  writeFileSync(file, JSON.stringify(doc));
  chmodSync(locked, 0o000);
  try {
    const start = (cwd) => message(hook('session-start.mjs', { ...two, stdin: JSON.stringify({ session_id: 's', cwd }) }).stdout);
    assert.equal(start(project), DUPLICATE);
    assert.equal(start(path.join(locked, 'other')), null);
  } finally {
    chmodSync(locked, 0o700);
  }
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
  const floor = hook('preflight.mjs', { ...p, args: [p.data, 'quick'], env: { AI_AGENT: 'claude-code_2-1-250_agent' } });
  assert.deepEqual([floor.code, floor.stdout], [1, FLOOR(VERSION) + '\n']);
  // /rough-ride:standard's preflight names standard; a missing or unknown name says quick.
  const standard = hook('preflight.mjs', { ...p, args: [p.data, 'standard'], env: { AI_AGENT: 'claude-code_2-1-250_agent' } });
  assert.deepEqual([standard.code, standard.stdout], [1, FLOOR(VERSION).replace('/rough-ride:quick', '/rough-ride:standard') + '\n']);
  for (const args of [[p.data], [p.data, 'other']]) {
    assert.equal(hook('preflight.mjs', { ...p, args, env: { AI_AGENT: 'claude-code_2-1-250_agent' } }).stdout, FLOOR(VERSION) + '\n');
  }

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

// ---- The Plugin copy module, through its interface ----

const CACHE_ROWS = [
  ['the runner file of a cache copy', '/home/u/.claude/plugins/cache/rough-ride/rough-ride/0.4.0/dist/cli.mjs',
    { id: 'rough-ride@rough-ride', pluginsRoot: '/home/u/.claude/plugins', dataFolder: '/home/u/.claude/plugins/data/rough-ride-rough-ride' }],
  ['the copy root itself', '/home/u/.claude/plugins/cache/rough-ride/rough-ride/0.4.0',
    { id: 'rough-ride@rough-ride', pluginsRoot: '/home/u/.claude/plugins', dataFolder: '/home/u/.claude/plugins/data/rough-ride-rough-ride' }],
  ['a marketplace name with a dot', '/home/u/.claude/plugins/cache/my.market/rough-ride/0.4.0',
    { id: 'rough-ride@my.market', pluginsRoot: '/home/u/.claude/plugins', dataFolder: '/home/u/.claude/plugins/data/rough-ride-my-market' }],
  ['a Windows copy, printed with forward slashes', 'C:\\Users\\u\\.claude\\plugins\\cache\\rough-ride\\rough-ride\\0.4.0\\dist\\cli.mjs',
    { id: 'rough-ride@rough-ride', pluginsRoot: 'C:/Users/u/.claude/plugins', dataFolder: 'C:/Users/u/.claude/plugins/data/rough-ride-rough-ride' }],
  ['no version folder', '/home/u/.claude/plugins/cache/rough-ride/rough-ride', null],
  ['a cache folder outside plugins', '/home/u/cache/rough-ride/rough-ride/0.4.0/dist/cli.mjs', null],
  ['a checkout', '/src/rp/packages/rough-ride/dist/cli.mjs', null],
];

test('cacheCopy: one parser of <plugins root>/cache/<marketplace>/<plugin>/<version>/', () => {
  for (const [name, given, expected] of CACHE_ROWS) {
    assert.deepEqual(copy.cacheCopy(given), expected, name);
    if (!given.endsWith('cli.mjs')) assert.equal(copy.copyId(given), expected ? expected.id : 'rough-ride', `${name}: copyId`);
  }
});

test('the floor, the edit-guard line, the session id, semver and the Claude Code version', () => {
  assert.equal(copy.EDIT_GUARD_OFF, EDIT_GUARD_OFF);
  assert.equal(copy.floorStop('0.4.0', '2.1.250', '/rough-ride:standard'), FLOOR('0.4.0').replace('/rough-ride:quick', '/rough-ride:standard'));
  assert.equal(copy.floorStop('0.4.0', copy.CLAUDE_FLOOR, '/rough-ride:quick'), null);
  assert.equal(copy.floorStop('0.4.0', null, '/rough-ride:quick'), null);
  assert.ok(copy.validSession('abc_DEF-123'));
  assert.ok(copy.validSession('a'.repeat(200)));
  assert.ok(!copy.validSession('a'.repeat(201)));
  assert.ok(!copy.validSession('../x'));
  assert.ok(!copy.validSession(''));
  assert.ok(copy.compareSemver('2.1.300', '2.1.299') > 0);
  assert.ok(copy.compareSemver('2.1.30', '2.1.299') < 0);
  assert.equal(copy.compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(copy.claudeCodeVersion({ AI_AGENT: 'claude-code_2-1-309_agent' }), '2.1.309');
  assert.equal(copy.claudeCodeVersion({ CLAUDE_CODE_EXECPATH: '/u/.local/share/claude/versions/2.1.300' }), '2.1.300');
  assert.equal(copy.claudeCodeVersion({ CLAUDE_CODE_EXECPATH: '/usr/local/bin/claude' }), null);
  assert.equal(copy.claudeCodeVersion({}), null);
});
