import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { StopError } from '../dist/exit.mjs';
import { checkCommittedFiles } from '../dist/files.mjs';
import { checkRootEntry } from '../dist/folder.mjs';
import { compareVersions, configHeader, FORMATS } from '../dist/formats.mjs';
import { unifiedDiff } from '../dist/patch.mjs';
import { gitRepo, sh } from './helpers.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/formats/', import.meta.url));
const PLACES = { config: ['config.yaml'], accepted: ['accepted.yaml'], flow: ['flows'], tests: ['tests'] };

const info = (source = { kind: 'devDependency', detail: 'frontend/package.json', resolved: null }, extra = {}) => ({
  version: '0.1.0',
  cliPath: '/x/dist/cli.mjs',
  source,
  pluginId: null,
  pluginData: null,
  node: '22.22.1',
  playwright: '1.64.1',
  claudeCode: { version: null, floorChecked: false },
  editGuard: 'n/a',
  ...extra,
});

// A repository holding every fixture of one schema version, committed.
function repoWith(version, { crlf = false } = {}) {
  const root = gitRepo();
  // Set both ways: Git for Windows sets core.autocrlf=true system-wide.
  sh(root, 'config', 'core.autocrlf', crlf ? 'true' : 'false');
  for (const [kind, place] of Object.entries(PLACES)) {
    const dir = path.join(FIXTURES, kind, version);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const target = place.length === 1 && place[0].endsWith('.yaml')
        ? path.join(root, '.rough-ride', place[0])
        : path.join(root, '.rough-ride', place[0], name);
      mkdirSync(path.dirname(target), { recursive: true });
      let text = readFileSync(path.join(dir, name), 'utf8');
      if (crlf) text = text.replace(/\n/g, '\r\n');
      writeFileSync(target, text);
    }
  }
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'fixtures');
  return root;
}

function check(root, ctx = {}) {
  try {
    return { result: checkCommittedFiles(checkRootEntry(root), { info: info(), subcommand: 'quick', argv: ['quick'], env: {}, ...ctx }) };
  } catch (error) {
    if (error instanceof StopError) return { stop: error.stop, run: error.run };
    throw error;
  }
}

function snapshot(root) {
  const dir = path.join(root, '.rough-ride');
  return Object.fromEntries(
    readdirSync(dir, { recursive: true })
      .filter((p) => !p.startsWith('runs') && p.endsWith('.yaml'))
      .map((p) => [p, readFileSync(path.join(dir, p), 'utf8')]),
  );
}

test('versions compare part by part as numbers', () => {
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  for (const kind of ['config', 'flow', 'tests', 'accepted', 'plan']) {
    assert.deepEqual(FORMATS[kind], { current: '0.1.0', floor: '0.1.0' });
  }
});

test('fixtures inside [floor, current] load unchanged and silently, and formats report them', () => {
  const root = repoWith('0.1.0');
  const before = snapshot(root);
  const { result } = check(root);
  assert.deepEqual(result.notes, []);
  assert.equal(result.flows.length, 1);
  assert.equal(result.tests.length, 1);
  assert.deepEqual(result.invalid, []);
  assert.deepEqual(result.formats.flow, { current: '0.1.0', floor: '0.1.0', lowest: '0.1.0', highest: '0.1.0' });
  assert.deepEqual(result.formats.plan, { current: '0.1.0', floor: '0.1.0', lowest: null, highest: null });
  assert.deepEqual(snapshot(root), before);
});

test('schema text: v0.5.0 and 1.0.0-rc.1 stop, a quoted value and schema after other keys load', () => {
  for (const [value, ok] of [['v0.1.0', false], ['1.0.0-rc.1', false], ['"0.1.0"', true]]) {
    const root = gitRepo();
    mkdirSync(path.join(root, '.rough-ride', 'flows'), { recursive: true });
    writeFileSync(path.join(root, '.rough-ride', 'flows', 'a.yaml'), `signedIn: false\nschema: ${value}\nsteps:\n  - goto: /\n  - expect: {text: Home}\n`);
    const { stop, result } = check(root);
    if (ok) assert.equal(result.flows.length, 1, value);
    else assert.match(stop.lines[0], /^\.rough-ride\/flows\/a\.yaml line 2: schema must be a rough-ride version with three parts/, value);
  }
});

test('a flow with no schema stops with the add-a-line message', () => {
  const root = gitRepo();
  mkdirSync(path.join(root, '.rough-ride', 'flows'), { recursive: true });
  writeFileSync(path.join(root, '.rough-ride', 'flows', 'checkout.yaml'), 'signedIn: false\nsteps: []\n');
  const { stop } = check(root);
  assert.deepEqual([stop.code, stop.lines], [
    'files-invalid',
    ['.rough-ride/flows/checkout.yaml has no schema line. Add "schema: 0.1.0" as its first line: the flow format rough-ride 0.1.0 reads.'],
  ]);
});

test('failures across kinds collect into one stop; a test or flow failing only step 5 never stops', () => {
  const root = repoWith('0.1.0');
  const rp = path.join(root, '.rough-ride');
  writeFileSync(path.join(rp, 'tests', 'bad-test-000000.yaml'), 'schema: 0.1.0\nflow: create-note\nextra: 1\n');
  writeFileSync(path.join(rp, 'flows', 'bad-flow.yaml'), 'schema: 0.1.0\nsignedIn: maybe\nsteps: []\n');
  const { result } = check(root);
  assert.deepEqual(result.invalid.map((f) => f.shown).sort(), ['.rough-ride/flows/bad-flow.yaml', '.rough-ride/tests/bad-test-000000.yaml']);

  writeFileSync(path.join(rp, 'accepted.yaml'), 'schema: 0.1.0\naccepted:\n  - page: /r\n    step: click\n    action: x\n    check: settles\n    because: ""\n');
  writeFileSync(path.join(rp, 'config.yaml'), 'reset: x\n');
  const { stop } = check(root);
  assert.equal(stop.code, 'files-invalid');
  assert.equal(stop.lines.length, 2);
  assert.match(stop.lines[0], /^\.rough-ride\/config\.yaml has no schema line/);
  assert.match(stop.lines[1], /^\.rough-ride\/accepted\.yaml line 7: accepted\[0\]\.because must be/);
});

test('a file newer than the runner stops naming the highest schema and the fix for each source', () => {
  const root = repoWith('0.1.0');
  const rp = path.join(root, '.rough-ride');
  writeFileSync(path.join(rp, 'flows', 'create-note.yaml'), readFileSync(path.join(rp, 'flows', 'create-note.yaml'), 'utf8').replace('0.1.0', '0.8.0'));
  writeFileSync(path.join(rp, 'config.yaml'), 'schema: 0.7.0\nreset: x\n');
  writeFileSync(path.join(rp, 'accepted.yaml'), 'schema: 0.0.1\naccepted: []\n');
  const { stop } = check(root);
  assert.equal(stop.code, 'schema-newer');
  assert.deepEqual(stop.lines, [
    "rough-ride 0.1.0 can't read 2 files written for a newer rough-ride:",
    '  .rough-ride/flows/create-note.yaml  schema: 0.8.0',
    '  .rough-ride/config.yaml             schema: 0.7.0',
    'They need rough-ride 0.8.0 or later. This invocation used 0.1.0 from devDependency frontend/package.json.',
    'Update it: npm i -D -E rough-ride@0.8.0 in frontend/',
  ]);
  const fix = (source, extra) => check(root, { info: info(source, extra), argv: ['quick', '--json'] }).stop.lines.at(-1);
  assert.equal(
    fix({ kind: 'plugin', detail: 'rough-ride@rough-ride', resolved: null }, { pluginId: 'rough-ride@rough-ride' }),
    'Update it: /plugin marketplace update rough-ride, then /plugin update rough-ride@rough-ride',
  );
  assert.equal(fix({ kind: 'npx', detail: null, resolved: null }), 'Update it: npx -y rough-ride@0.8.0 quick --json');
  assert.equal(fix({ kind: 'other', detail: '/x', resolved: null }), 'Update it: Install rough-ride 0.8.0 or later.');
});

test('an unknown YAML file is ignored with a note, or joins the stop when newer', () => {
  const root = repoWith('0.1.0');
  writeFileSync(path.join(root, '.rough-ride', 'budgets.yaml'), 'schema: 0.1.0\n');
  assert.deepEqual(check(root).result.notes, [
    { id: 'ignored', text: "Ignored: .rough-ride/budgets.yaml (rough-ride 0.1.0 doesn't use it)." },
  ]);
  writeFileSync(path.join(root, '.rough-ride', 'budgets.yaml'), 'schema: 0.9.0\n');
  const { stop } = check(root);
  assert.equal(stop.code, 'schema-newer');
  assert.equal(stop.lines[1], '  .rough-ride/budgets.yaml  schema: 0.9.0');
});

// A fixture format break: flows 0.2.0 renames a press step's `key` to `keys`.
const BREAK = {
  formats: { ...FORMATS, flow: { current: '0.2.0', floor: '0.2.0' }, config: { current: '0.2.0', floor: '0.2.0' } },
  upgraders: [
    {
      kind: 'flow',
      to: '0.2.0',
      upgrade(text) {
        const edits = [];
        const described = [];
        text.split('\n').forEach((line, i) => {
          if (/^    key: /.test(line.replace(/\r$/, ''))) {
            edits.push({ op: 'replace', line: i + 1, text: line.replace(/\r$/, '').replace('key:', 'keys:') });
            described.push(`line ${i + 1}: press option key renamed to keys (0.2.0)`);
          }
        });
        return { edits, described, dropped: [], handEdits: [] };
      },
    },
  ],
};

for (const crlf of [false, true]) {
  test(`a file below the floor writes an upgrade patch that git apply accepts${crlf ? ' (core.autocrlf=true, CRLF files)' : ''}`, () => {
    const root = repoWith('0.1.0', { crlf });
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { 'rough-ride': '0.1.0' } }));
    const before = snapshot(root);
    const ctx = { ...BREAK, info: info(undefined, { version: '0.2.0' }), env: {} };
    const { stop, run } = check(root, ctx);
    assert.equal(stop.code, 'schema-older');
    assert.deepEqual(snapshot(root), before, 'no committed file changes');
    const rel = `.rough-ride/runs/${run.id}`;
    assert.deepEqual(stop.lines, [
      'rough-ride 0.2.0 no longer reads the format of 2 files (config changed in 0.2.0, flows in 0.2.0):',
      '  .rough-ride/config.yaml             schema: 0.1.0',
      '  .rough-ride/flows/create-note.yaml  schema: 0.1.0',
      'An upgrade patch is ready. Review it, then run this in your terminal and commit the result:',
      `  git -C "${root}" apply ${rel}/upgrade.patch`,
      'Raise the pin in the same commit, or CI stops on the upgraded files: npm i -D -E rough-ride@0.2.0',
      'Release notes: https://github.com/rough-ride/rough-ride/releases/tag/v0.2.0',
    ]);
    const txt = readFileSync(path.join(root, rel, 'upgrade.txt'), 'utf8');
    assert.match(txt, /\.rough-ride\/flows\/create-note\.yaml line 8: press option key renamed to keys \(0\.2\.0\)/);
    assert.match(txt, /\.rough-ride\/config\.yaml line 2: schema 0\.1\.0 -> 0\.2\.0/);

    // Run the printed command from a subfolder, exactly as a person would.
    const apply = spawnSync('git', ['-C', root, 'apply', `${rel}/upgrade.patch`], { cwd: path.join(root, 'frontend'), encoding: 'utf8' });
    assert.equal(apply.status, 0, apply.stderr);
    const config = readFileSync(path.join(root, '.rough-ride', 'config.yaml'), 'utf8');
    assert.match(config, /^# yaml-language-server: \$schema=https:\/\/raw\.githubusercontent\.com\/rough-ride\/rough-ride\/v0\.2\.0\//);
    assert.match(config, crlf ? /\r\nschema: 0\.2\.0\r\n/ : /\nschema: 0\.2\.0\n/);
    assert.match(readFileSync(path.join(root, '.rough-ride', 'flows', 'create-note.yaml'), 'utf8'), /keys: Enter/);
    // The upgraded files are in range for the new runner.
    const after = check(root, { ...ctx, upgraders: [] });
    assert.ok(after.result || after.stop.code === 'files-invalid', JSON.stringify(after.stop));
    if (after.stop) assert.ok(after.stop.lines.every((l) => !/schema/.test(l)), after.stop.lines.join('\n'));
  });
}

test('in CI mode a schema-older stop points into the job output and prints no git -C line; a plugin data folder or CI=false keeps the local lines', () => {
  const root = repoWith('0.1.0');
  const flows = path.join(root, '.rough-ride', 'flows');
  for (const name of ['a-note.yaml', 'b-note.yaml']) cpSync(path.join(flows, 'create-note.yaml'), path.join(flows, name));
  const ci = check(root, { ...BREAK, info: info(undefined, { version: '0.2.0' }), env: { CI: '1' } });
  assert.equal(ci.stop.code, 'schema-older');
  const id = ci.run.id;
  assert.deepEqual(ci.stop.lines, [
    'rough-ride 0.2.0 no longer reads the format of 4 files (config changed in 0.2.0, flows in 0.2.0):',
    '  .rough-ride/config.yaml             schema: 0.1.0',
    '  .rough-ride/flows/a-note.yaml       schema: 0.1.0',
    `  ... and 2 more (all listed in ${id}/upgrade.txt in the job's uploaded run output)`,
    `This ran in CI: take ${id}/upgrade.patch from the job's uploaded run output and apply it at the repository root with git apply, or run rough-ride 0.2.0 locally to get the same patch.`,
    'Release notes: https://github.com/rough-ride/rough-ride/releases/tag/v0.2.0',
  ]);
  assert.ok(existsSync(path.join(root, '.rough-ride', 'runs', id, 'upgrade.patch')));
  for (const ctx of [{ env: { CI: '1' }, info: info(undefined, { version: '0.2.0', pluginData: { path: '/d', verified: true } }) }, { env: { CI: 'false' }, info: info(undefined, { version: '0.2.0' }) }]) {
    const local = check(root, { ...BREAK, ...ctx });
    const lines = local.stop.lines.join('\n');
    assert.match(lines, new RegExp(`all listed in \\.rough-ride/runs/${local.run.id}/upgrade\\.txt\\)`));
    assert.match(lines, /git -C "/);
    assert.doesNotMatch(lines, /This ran in CI|job's uploaded run output/);
  }
});

test('the patch keeps a missing final newline and uses 3 lines of context', () => {
  const before = 'a\nb\nc\nd\ne\nf\ng\nh\nschema: 0.1.0';
  const after = 'a\nb\nc\nd\ne\nf\ng\nh\nschema: 0.2.0';
  assert.equal(
    unifiedDiff('x.yaml', before, after),
    'diff --git a/x.yaml b/x.yaml\n--- a/x.yaml\n+++ b/x.yaml\n@@ -6,4 +6,4 @@\n f\n g\n h\n-schema: 0.1.0\n\\ No newline at end of file\n+schema: 0.2.0\n\\ No newline at end of file\n',
  );
  assert.equal(unifiedDiff('x.yaml', before, before), '');
});

test('the config header and template start with the editor comment and the config current', () => {
  const header = configHeader();
  assert.equal(
    header,
    '# yaml-language-server: $schema=https://raw.githubusercontent.com/rough-ride/rough-ride/v0.1.0/packages/rough-ride/src/schemas/config.schema.json\nschema: 0.1.0\n',
  );
  const template = readFileSync(new URL('../templates/config.yaml', import.meta.url), 'utf8');
  assert.ok(template.startsWith(header));
});

test('the locator and condition subschemas are identical in every file that holds them', () => {
  const dir = fileURLToPath(new URL('../dist/schemas/', import.meta.url));
  const found = { locator: new Set(), condition: new Set() };
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.description?.startsWith('Exactly one of role')) found.locator.add(JSON.stringify(node));
    if (node.description?.startsWith('Exactly one condition')) found.condition.add(JSON.stringify(node));
    Object.values(node).forEach(walk);
  };
  for (const name of ['flow.schema.json', 'test.schema.json', 'plan.schema.json']) walk(JSON.parse(readFileSync(path.join(dir, name), 'utf8')));
  assert.equal(found.locator.size, 1);
  assert.equal(found.condition.size, 1);
});
