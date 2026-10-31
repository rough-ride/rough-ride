// test-tarball step 3, and CI's hook job on Node 18: run every hook
// hooks/hooks.json registers, with `node` and its args exactly as registered,
// from the given package folder, with the unit tests' fixture stdin
// (packages/rough-ride/test/fixtures/hook-rows.mjs). Prints one line per
// failure and exits 1. Node 18 syntax.
// Usage: node scripts/hook-fixtures.mjs <unpacked package dir>
// The folder needs its runtime packages (npm ci --omit=dev --ignore-scripts).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DUPLICATE,
  FLOOR,
  INLINE,
  OLD_NODE,
  PACKAGES,
  RUN,
  guardWorld,
  packageVersion,
  pluginsHome,
  verdict,
} from '../packages/rough-ride/test/fixtures/hook-rows.mjs';

const dir = realpathSync(path.resolve(process.argv[2] ?? 'packages/rough-ride'));
const VERSION = packageVersion(dir);
const failures = [];
const counts = {};
// Per guard handler, whether a fixture let the call through and one stopped it.
const answers = {};
const fail = (line) => failures.push(`hook-fixtures: ${line}`);

const [major, minor] = process.versions.node.split('.').map(Number);
const oldNode = major < 22 || (major === 22 && minor < 22);
// On Node 22.22 or later the old-Node message is checked with a faked version.
const FAKE_NODE_20 = 'data:text/javascript,Object.defineProperty(process.versions,"node",{value:"20.18.1"})';

// Each registration, named by its script and the args after it.
const HANDLERS = {
  'session-start.mjs': 'session-start',
  'guard.mjs': 'handler A',
  'guard.mjs ${CLAUDE_PLUGIN_DATA}': 'handler B',
  'guard.mjs read': 'handler C',
  'guard.mjs stop ${CLAUDE_PLUGIN_DATA}': 'SubagentStop',
};
const registered = {};
const hooks = JSON.parse(readFileSync(path.join(dir, 'hooks', 'hooks.json'), 'utf8')).hooks;
for (const [event, groups] of Object.entries(hooks)) {
  for (const group of groups) {
    for (const hook of group.hooks) {
      const where = `${event} ${group.matcher ?? '(no matcher)'}`;
      if (hook.command !== 'node' || !Array.isArray(hook.args) || hook.args.length === 0) {
        fail(`${where}: not "command": "node" with an args array`);
        continue;
      }
      const key = [path.posix.basename(hook.args[0]), ...hook.args.slice(1)].join(' ');
      const name = HANDLERS[key];
      if (!name || !hook.args[0].startsWith('${CLAUDE_PLUGIN_ROOT}/hooks/')) {
        fail(`${where}: no fixtures for args ${JSON.stringify(hook.args)}`);
        continue;
      }
      (registered[name] ??= []).push({ ...hook, matcher: group.matcher });
    }
  }
}
for (const name of Object.values(HANDLERS)) if (!registered[name]) fail(`${name}: not registered in hooks/hooks.json`);

const CLEAN_ENV = { AI_AGENT: '', CLAUDE_CODE_EXECPATH: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_PROJECT_DIR: '' };

// Runs a registration as Claude Code would: node, its args with the plugin
// variables filled in, the same two variables in the environment.
function run(hook, stdin, { root = dir, data, cwd, env = {}, preload } = {}) {
  const sub = (s) => s.replaceAll('${CLAUDE_PLUGIN_ROOT}', root).replaceAll('${CLAUDE_PLUGIN_DATA}', data);
  const args = hook.args.map(sub);
  const r = spawnSync(process.execPath, preload ? ['--import', preload, ...args] : args, {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...CLEAN_ENV, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data, ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function expect(name, label, r, expected) {
  counts[name] = (counts[name] ?? 0) + 1;
  (answers[name] ??= new Set()).add(expected === '' || expected === 'allow' ? 'allow' : 'deny');
  let got;
  try {
    got = verdict(r.stdout);
  } catch (_) {
    got = r.stdout;
  }
  if (r.code !== 0) fail(`${name}: ${label}: exited ${r.code}`);
  else if (r.stderr !== '') fail(`${name}: ${label}: stderr ${JSON.stringify(r.stderr.trim().split('\n')[0])}`);
  else if (got !== expected) fail(`${name}: ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
}

const matches = (hook, toolName) => new RegExp(`^(?:${hook.matcher})$`).test(toolName);

// ---- The session-start hook ----

function walk(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(folder, e.name)) : [path.join(folder, e.name)]));
}

function sessionStart() {
  const [hook] = registered['session-start'] ?? [];
  if (!hook) return;
  const name = 'session-start';
  // Every case also prints the old-Node line when this Node is below 22.22.
  const message = (...lines) => {
    const all = oldNode ? [...lines, OLD_NODE(process.versions.node, process.execPath)] : lines;
    return all.length > 0 ? `message: ${all.join('\n')}` : '';
  };
  if (!existsSync(path.join(dir, 'node_modules', 'playwright-core', 'package.json'))) {
    fail(`${name}: ${dir} has no node_modules/playwright-core; run npm ci --omit=dev --ignore-scripts there first`);
    return;
  }

  const none = pluginsHome(dir);
  const opts = (h, env) => ({ data: h.data, cwd: h.home, env });
  expect(name, 'every condition passes', run(hook, { session_id: 'abc-123', cwd: none.home }, opts(none, { AI_AGENT: 'claude-code_2-1-311_agent' })), message());
  const marker = path.join(none.data, 'sessions', 'abc-123');
  const written = walk(none.data);
  if (written.length !== 1 || written[0] !== marker || readFileSync(marker, 'utf8') !== '') {
    fail(`${name}: wrote ${JSON.stringify(written)}, expected only the empty marker ${marker}`);
  }

  const sessions = path.join(none.data, 'sessions');
  for (const [file, days] of [['old', 8], ['recent', 6]]) {
    writeFileSync(path.join(sessions, file), '');
    const t = new Date(Date.now() - days * 86_400_000);
    utimesSync(path.join(sessions, file), t, t);
  }
  expect(name, 'markers older than 7 days', run(hook, { session_id: 'new' }, opts(none)), message());
  const left = readdirSync(sessions).sort().join(' ');
  if (left !== 'abc-123 new recent') fail(`${name}: markers left ${left}, expected abc-123 new recent`);

  // Run from the unpacked folder, outside the plugins cache, so each installed copy also reads as replaced.
  const two = pluginsHome(dir, { ids: [['rough-ride@rough-ride', '0.9.3'], ['rough-ride@claude-plugins-official', '1.0.0']] });
  expect(name, 'two copies installed', run(hook, { session_id: 's' }, opts(two)), message(DUPLICATE, INLINE(dir)));

  expect(name, 'Claude Code below the floor', run(hook, {}, opts(none, { AI_AGENT: 'claude-code_2-1-250_agent' })), message(FLOOR(VERSION)));

  // Missing packages need a copy without node_modules: a cache copy of this package's hooks.
  const bare = pluginsHome(dir, { ids: [['rough-ride@rough-ride', VERSION]], withPackages: false });
  expect(name, 'packages missing', run(hook, {}, { ...opts(bare), root: bare.root }), message(PACKAGES('rough-ride@rough-ride')));

  if (!oldNode) {
    expect(name, 'old Node for hooks', run(hook, {}, { ...opts(none), preload: FAKE_NODE_20 }), `message: ${OLD_NODE('20.18.1', process.execPath)}`);
  }

  const unreadable = pluginsHome(dir);
  expect(name, 'unreadable stdin', run(hook, 'garbage', opts(unreadable)), message());
  if (existsSync(path.join(unreadable.data, 'sessions'))) fail(`${name}: wrote a marker without a session id`);
}

// ---- guard.mjs ----

function guard() {
  const w = guardWorld(dir);
  const opts = { data: w.data, cwd: w.repo, env: { CLAUDE_PROJECT_DIR: w.projectDir } };
  const rows = [...w.ROWS, ...w.CASE_ROWS];

  // Handler B gets every row written for it; handler A, which has no data
  // folder, the ones written for it and the file-tool rows of rule 1.
  for (const [label, stdin, expected, args, env] of rows) {
    const forA = args.length === 0 || /^rule 1: /.test(label);
    const forB = args.length > 0;
    for (const [name, wanted] of [['handler A', forA], ['handler B', forB]]) {
      if (!wanted) continue;
      const hook = (registered[name] ?? []).find((h) => matches(h, stdin.tool_name));
      if (hook) expect(name, label, run(hook, stdin, { ...opts, env: { ...opts.env, ...env } }), expected);
    }
  }

  for (const [label, stdin, expected] of w.READ_ROWS) {
    const hook = (registered['handler C'] ?? []).find((h) => matches(h, stdin.tool_name));
    if (!hook) continue;
    expect('handler C', `${label} (adversary)`, run(hook, { ...stdin, agent_type: w.adv.agent_type }, opts), expected);
    expect('handler C', `${label} (no agent_type)`, run(hook, stdin, opts), '');
  }

  const [stop] = registered.SubagentStop ?? [];
  if (stop) {
    w.record('stop-planned', {});
    expect('SubagentStop', 'planned, not attacked', run(stop, w.stopInput('stop-planned'), opts), `block: Run node "${dir}/dist/cli.mjs" attack --run ${RUN} --plugin-data "${w.data}" before you finish.`);
    w.record('stop-good', { attacked: true });
    expect('SubagentStop', 'attacked and quoted', run(stop, w.stopInput('stop-good'), opts), '');
  }
}

sessionStart();
guard();

for (const name of Object.values(HANDLERS)) {
  if (registered[name] && !counts[name]) fail(`${name}: no fixture reached it`);
  else if (name !== 'session-start' && registered[name] && answers[name].size < 2) fail(`${name}: needs an allow and a deny fixture`);
}
if (failures.length > 0) {
  console.log(failures.join('\n'));
  process.exit(1);
}
const summary = Object.values(HANDLERS).map((name) => `${name} ${counts[name]}`).join(', ');
console.log(`hook-fixtures: ${Object.values(counts).reduce((a, b) => a + b, 0)} fixtures passed on Node ${process.versions.node} (${summary})`);
