import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { claudeCodeVersion, claudeFloorStop, derivedPluginData, detectSource, EDIT_GUARD_OFF, followUpCommand, pluginDataMismatch, runnerBlock, runnerLine, versionSkew } from '../dist/runner.mjs';
import { scratchDir } from './helpers.mjs';

const info = (source, extra = {}) => ({
  version: '0.4.0',
  cliPath: '/home/u/x/dist/cli.mjs',
  source,
  pluginId: null,
  pluginData: null,
  node: '22.22.1',
  playwright: '1.64.1',
  claudeCode: { version: null, floorChecked: false },
  editGuard: 'n/a',
  versionSkew: null,
  ...extra,
});

test('a plugin copy takes its id from the install path', () => {
  const cli = '/home/u/.claude/plugins/cache/rough-ride/rough-ride/0.4.0/dist/cli.mjs';
  assert.deepEqual(detectSource(cli, '/home/u/.claude/plugins/data/rough-ride', '/w'), {
    kind: 'plugin',
    detail: 'rough-ride@rough-ride',
    resolved: null,
  });
  assert.equal(detectSource('/src/rp/packages/rough-ride/dist/cli.mjs', '/d', '/w').detail, 'rough-ride');
});

test('the npx cache is npx, a project node_modules is a devDependency, anything else is other', () => {
  assert.equal(detectSource('/home/u/.npm/_npx/ab12/node_modules/rough-ride/dist/cli.mjs', null, '/w').kind, 'npx');
  assert.deepEqual(detectSource('/opt/rp/dist/cli.mjs', null, '/w'), {
    kind: 'other',
    detail: '/opt/rp/dist/cli.mjs',
    resolved: null,
  });
});

test('a devDependency names its package.json repo-relative and flags a non-registry tarball', () => {
  const repo = scratchDir();
  mkdirSync(path.join(repo, '.git'));
  const frontend = path.join(repo, 'frontend');
  mkdirSync(frontend);
  const cli = path.join(frontend, 'node_modules', 'rough-ride', 'dist', 'cli.mjs');
  const lock = (resolved) =>
    writeFileSync(
      path.join(frontend, 'package-lock.json'),
      JSON.stringify({ packages: { 'node_modules/rough-ride': { resolved } } }),
    );

  lock('https://registry.npmjs.org/rough-ride/-/rough-ride-0.4.0.tgz');
  assert.deepEqual(detectSource(cli, null, frontend), {
    kind: 'devDependency',
    detail: 'frontend/package.json',
    resolved: null,
  });

  lock('file:../rp.tgz');
  const source = detectSource(cli, null, frontend);
  assert.equal(source.resolved, 'file:../rp.tgz');
  assert.equal(
    runnerLine(info(source)),
    'Runner: rough-ride 0.4.0 from devDependency frontend/package.json (resolved file:../rp.tgz, not the npm registry) | Node 22.22.1 | Playwright 1.64.1',
  );
});

test('the runner line names the Claude Code version, or says it is unknown in a plugin copy', () => {
  const plugin = { kind: 'plugin', detail: 'rough-ride@rough-ride', resolved: null };
  assert.equal(
    runnerLine(info(plugin, { claudeCode: { version: '2.1.309', floorChecked: false } })),
    'Runner: rough-ride 0.4.0 from plugin rough-ride@rough-ride | Node 22.22.1 | Playwright 1.64.1 | Claude Code 2.1.309',
  );
  assert.equal(
    runnerLine(info(plugin)),
    'Runner: rough-ride 0.4.0 from plugin rough-ride@rough-ride | Node 22.22.1 | Playwright 1.64.1 | Claude Code: unknown (floor 2.1.299 not checked)',
  );
  assert.equal(
    runnerLine(info({ kind: 'npx', detail: null, resolved: null })),
    'Runner: rough-ride 0.4.0 from npx | Node 22.22.1 | Playwright 1.64.1',
  );
});

test('the Claude Code version comes from AI_AGENT, else the last segment of CLAUDE_CODE_EXECPATH', () => {
  assert.equal(claudeCodeVersion({ AI_AGENT: 'claude-code_2-1-309_agent' }), '2.1.309');
  assert.equal(claudeCodeVersion({ CLAUDE_CODE_EXECPATH: '/u/.local/share/claude/versions/2.1.300' }), '2.1.300');
  assert.equal(claudeCodeVersion({ CLAUDE_CODE_EXECPATH: '/usr/local/bin/claude' }), null);
  assert.equal(claudeCodeVersion({}), null);
});

test('follow-up commands use the form that ran the runner', () => {
  const plugin = info(
    { kind: 'plugin', detail: 'rough-ride@rough-ride', resolved: null },
    { cliPath: '/p/dist/cli.mjs', pluginData: { path: '/data', verified: false } },
  );
  assert.equal(followUpCommand(plugin, ['quick']), '/rough-ride:quick');
  assert.equal(followUpCommand(plugin, ['regress']), 'node "/p/dist/cli.mjs" regress --plugin-data "/data"');
  assert.equal(
    followUpCommand(info({ kind: 'devDependency', detail: 'package.json', resolved: null }), ['regress']),
    'npx --no rough-ride regress',
  );
  // The More attacks line in quick, CI mode included (52.2).
  assert.equal(followUpCommand(info({ kind: 'devDependency', detail: 'package.json', resolved: null }), ['standard']), 'npx --no rough-ride standard');
  assert.equal(followUpCommand(info({ kind: 'npx', detail: null, resolved: null }), ['quick']), 'npx -y rough-ride@0.4.0 quick');
  assert.equal(
    followUpCommand(info({ kind: 'other', detail: '/home/u/x/dist/cli.mjs', resolved: null }), ['repro', 'a1']),
    'node "/home/u/x/dist/cli.mjs" repro a1',
  );
});

const PLUGIN = { kind: 'plugin', detail: 'rough-ride@rough-ride', resolved: null };
const CACHE_CLI = '/home/u/.claude/plugins/cache/rough-ride/rough-ride/0.4.0/dist/cli.mjs';

test('a cache copy derives its data folder; a --plugin-data that differs is the exact stop, case-insensitive on macOS', () => {
  assert.equal(derivedPluginData(CACHE_CLI), '/home/u/.claude/plugins/data/rough-ride-rough-ride');
  assert.equal(derivedPluginData('/home/u/.claude/plugins/cache/my.market/rough-ride/0.4.0/dist/cli.mjs'), '/home/u/.claude/plugins/data/rough-ride-my-market');
  assert.equal(derivedPluginData('/src/rp/packages/rough-ride/dist/cli.mjs'), null);
  const given = (p) => info(PLUGIN, { cliPath: CACHE_CLI, pluginData: { path: p, verified: false } });
  assert.equal(pluginDataMismatch(given('/home/u/.claude/plugins/data/rough-ride-rough-ride/'), 'linux'), null);
  assert.equal(pluginDataMismatch(given('/home/u/.claude/plugins/data/Rough-Ride-rough-ride'), 'darwin'), null);
  assert.equal(
    pluginDataMismatch(given('/tmp/elsewhere'), 'linux'),
    "rough-ride: --plugin-data /tmp/elsewhere is not this plugin copy's data folder (/home/u/.claude/plugins/data/rough-ride-rough-ride). Run the plugin's skills instead of typing this command.",
  );
  // An in-place load takes the flag as given, and the runner line says so.
  const inPlace = info(PLUGIN, { pluginData: { path: '/tmp/data', verified: false } });
  assert.equal(pluginDataMismatch(inPlace), null);
  assert.match(runnerLine(inPlace), / \| plugin data: \/tmp\/data \(from --plugin-data, not verified\)$/);
});

test('the floor check runs only with a plugin data folder and a readable version', () => {
  const withData = (version) => info(PLUGIN, { pluginData: { path: '/d', verified: true }, claudeCode: { version, floorChecked: version !== null } });
  assert.equal(
    claudeFloorStop(withData('2.1.250'), 'standard'),
    'rough-ride 0.4.0 needs Claude Code 2.1.299 or later; this session runs 2.1.250. Older versions let a failed edit-blocking hook through. Update with claude update, restart Claude Code, then run /rough-ride:standard again.',
  );
  assert.equal(claudeFloorStop(withData('2.1.299'), 'quick'), null);
  assert.equal(claudeFloorStop(withData(null), 'quick'), null);
  assert.equal(claudeFloorStop(info(PLUGIN, { claudeCode: { version: '2.1.1', floorChecked: false } }), 'quick'), null);
});

test('the runner block: runner line, then the edit-guard line when off, then the skew line', () => {
  const skew = { pin: '0.3.1', file: 'package.json', ciWillStop: false, line: 'Version skew: x' };
  assert.deepEqual(runnerBlock(info(PLUGIN, { editGuard: 'on' })), [runnerLine(info(PLUGIN))]);
  assert.deepEqual(runnerBlock(info(PLUGIN, { editGuard: 'off', versionSkew: skew })), [runnerLine(info(PLUGIN)), EDIT_GUARD_OFF, 'Version skew: x']);
  assert.deepEqual(runnerBlock(info({ kind: 'npx', detail: null, resolved: null })).length, 1);
});

test('version skew: the exact line, the CI will stop clause for an exact pin below a file schema, never for a range', () => {
  const repo = scratchDir();
  const frontend = path.join(repo, 'frontend');
  mkdirSync(frontend);
  const plugin = info(PLUGIN, { version: '0.8.3', pluginId: 'rough-ride@rough-ride' });
  const pin = (spec, dir = frontend) => writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { 'rough-ride': spec } }));
  pin('0.6.2');
  const written = [{ shown: '.rough-ride/flows/checkout.yaml', schema: '0.8.0' }, { shown: '.rough-ride/config.yaml', schema: '0.7.0' }, { shown: '.rough-ride/flows/a.yaml', schema: '0.1.0' }];
  assert.deepEqual(versionSkew(plugin, repo, ['', 'frontend/'], written, ['quick']), {
    pin: '0.6.2',
    file: 'frontend/package.json',
    ciWillStop: true,
    line: "Version skew: this run used rough-ride 0.8.3 from the plugin; frontend/package.json pins 0.6.2, which CI runs. CI will stop: 0.6.2 can't read 2 files written for 0.8.0 (.rough-ride/flows/checkout.yaml and 1 more). Align them: npm i -D -E rough-ride@0.8.3 in frontend/",
  });
  assert.equal(
    versionSkew(plugin, repo, ['', 'frontend/'], [], ['quick']).line,
    'Version skew: this run used rough-ride 0.8.3 from the plugin; frontend/package.json pins 0.6.2, which CI runs. Align them: npm i -D -E rough-ride@0.8.3 in frontend/',
  );
  pin('^0.6.2');
  assert.equal(versionSkew(plugin, repo, ['', 'frontend/'], written, ['quick']).ciWillStop, false);
  // An installed copy decides the version; the git root's package.json comes first.
  mkdirSync(path.join(repo, 'node_modules', 'rough-ride'), { recursive: true });
  writeFileSync(path.join(repo, 'node_modules', 'rough-ride', 'package.json'), '{"version":"0.8.3"}');
  pin('^0.8.0', repo);
  assert.equal(versionSkew(plugin, repo, ['', 'frontend/'], written, ['quick']), null);
  // A pin newer than the plugin's runner: the fix is the plugin update.
  rmSync(path.join(repo, 'node_modules'), { recursive: true });
  pin('0.9.0', repo);
  assert.match(versionSkew(plugin, repo, ['', 'frontend/'], [], ['quick']).line, /pins 0\.9\.0, which CI runs\. Align them: \/plugin marketplace update rough-ride, then \/plugin update rough-ride@rough-ride$/);
});

test('a file the invocation writes counts for the CI will stop clause and formats', async () => {
  const { wroteFile } = await import('../dist/files.mjs');
  const repo = scratchDir();
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ devDependencies: { 'rough-ride': '0.0.9' } }));
  const plugin = info(PLUGIN, { version: '0.1.0', pluginId: 'rough-ride@rough-ride' });
  const files = { written: [], formats: {} };
  wroteFile(files, plugin, repo, null, ['flow', 'save', 'x']);
  assert.equal(plugin.versionSkew.ciWillStop, false);
  wroteFile(files, plugin, repo, null, ['flow', 'save', 'x'], { shown: '.rough-ride/flows/x.yaml', schema: '0.1.0', kind: 'flow' });
  assert.equal(plugin.versionSkew.ciWillStop, true);
  assert.match(plugin.versionSkew.line, /CI will stop: 0\.0\.9 can't read 1 file written for 0\.1\.0 \(\.rough-ride\/flows\/x\.yaml\)\./);
  assert.equal(files.formats.flow.highest, '0.1.0');
});
