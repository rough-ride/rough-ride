import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { parseArgs } from '../dist/args.mjs';
import { makeStop } from '../dist/exit.mjs';
import { runnerBlock as runnerBlockOf, runnerInfo } from '../dist/runner.mjs';
import { createRunOutput } from '../dist/runoutput.mjs';
import { BLOCK_END, BLOCK_START } from '../dist/summary.mjs';
import { SAVE_JS, startCiSite } from './fixtures/ci-site.mjs';
import { gitRepo, runAsync, scratchDir, sh } from './helpers.mjs';

// Every run sets both variables, so the machine running the tests can't put it in CI mode.
const LOCAL = { CI: undefined, GITHUB_ACTIONS: undefined, GITHUB_EVENT_NAME: undefined };

let site;
before(async () => {
  site = await startCiSite();
});
after(() => site?.server.close());

const SAVE_FLOW = 'schema: 0.1.0\nsignedIn: false\nsteps:\n  - goto: /\n  - click: {role: button, name: Save}\n  - expect: {text: Saved}\n';
const TEST = 'schema: 0.1.0\nflow: save\nattack: {fault: "500", sticky: true, request: "POST /api/save #1", page: /}\nchecks: [no-uncaught-error]\ncontext: {timezone: UTC, locale: en-US}\nfound: {finding: x, run: 20261028-101010-quick-ab12, runner: 0.1.0, date: 2026-10-28}\n';

// A repository whose save flow reaches the changed src/save.js on the fixture
// site, so quick finds a missing error message.
function findingRepo({ config = '', tests = {} } = {}) {
  const root = gitRepo();
  sh(root, 'checkout', '-q', '-b', 'main');
  mkdirSync(path.join(root, '.rough-ride', 'flows'), { recursive: true });
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, '.rough-ride', 'config.yaml'), `schema: 0.1.0\ntarget:\n  url: ${site.url}\n${config}`);
  writeFileSync(path.join(root, '.rough-ride', 'flows', 'save.yaml'), SAVE_FLOW);
  if (Object.keys(tests).length > 0) mkdirSync(path.join(root, '.rough-ride', 'tests'));
  for (const [name, text] of Object.entries(tests)) writeFileSync(path.join(root, '.rough-ride', 'tests', `${name}.yaml`), text);
  writeFileSync(path.join(root, 'src', 'save.js'), SAVE_JS);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'base');
  writeFileSync(path.join(root, 'src', 'save.js'), SAVE_JS + '// changed\n');
  return root;
}

const runDir = (root, id) => path.join(root, '.rough-ride', 'runs', id);
const runFile = (root, id, name) => readFileSync(path.join(runDir(root, id), name), 'utf8');
const files = (root, id) => readdirSync(runDir(root, id)).sort();
const keys = (value) => Object.keys(value).sort();
const text = (lines) => lines.map((l) => l + '\n').join('');

async function call(root, args, options = {}) {
  const { code, stdout, stderr } = await runAsync([...args, '--json'], { cwd: root, env: LOCAL, ...options });
  let doc;
  try {
    doc = JSON.parse(stdout);
  } catch {
    assert.fail(`${args.join(' ')}: no document (exit ${code})\n${stdout}\n${stderr}`);
  }
  assert.equal(doc.exitCode, code);
  return doc;
}

// The run's summary.json is the stdout document, and summary.txt its lines.
function assertSummaryFiles(root, doc) {
  assert.deepEqual(JSON.parse(runFile(root, doc.runId, 'summary.json')), doc);
  assert.equal(runFile(root, doc.runId, 'summary.txt'), text(doc.summaryLines));
}

// The fields record.json adds to the document, leaves out, and replaces.
function recordShape(root, doc) {
  const record = JSON.parse(runFile(root, doc.runId, 'record.json'));
  return {
    added: keys(record).filter((k) => !(k in doc)),
    missing: keys(doc).filter((k) => !(k in record)),
    replaced: keys(doc).filter((k) => k in record && JSON.stringify(record[k]) !== JSON.stringify(doc[k])),
  };
}

// The document every outcome prints; subcommands add their own fields.
const DOCUMENT = ['command', 'contract', 'cwd', 'diff', 'exitCode', 'formats', 'notes', 'phase', 'preRelease', 'protected', 'protectedLines', 'root', 'runDir', 'runId', 'runner', 'scope', 'sections', 'spec', 'status', 'stop', 'summaryLines', 'tier', 'versionSkew'];

const TIER_RECORD = { added: ['accepted', 'constants', 'cut', 'environment', 'fieldsNotAttacked', 'groups', 'nonFindings', 'skipped', 'specParts'], missing: [], replaced: ['attacks', 'flows', 'tier'] };

test('finished runs: each subcommand leaves its run files, with summary.json equal to the stdout document and summary.txt its lines', async () => {
  const root = findingRepo();

  const quick = await call(root, ['quick']);
  assert.equal(quick.status, 'findings');
  assert.deepEqual(files(root, quick.runId), ['attacks.jsonl', 'diff-map.json', 'diff.patch', 'record.json', 'report.txt', 'repros', 'summary.json', 'summary.txt', 'tests']);
  assertSummaryFiles(root, quick);
  assert.deepEqual(recordShape(root, quick), TIER_RECORD);

  // regress's record.json holds everything in summary.json, plus the environment.
  const regress = await call(root, ['regress']);
  assert.equal(regress.status, 'findings');
  assert.deepEqual(files(root, regress.runId), ['record.json', 'report.txt', 'summary.json', 'summary.txt']);
  assertSummaryFiles(root, regress);
  assert.deepEqual(recordShape(root, regress), { added: ['environment'], missing: [], replaced: [] });

  const repro = await call(root, ['repro', `${quick.runId}/${quick.findings[0].representative.repro}`]);
  assert.match(repro.runId, /-repro-/);
  assert.deepEqual(files(root, repro.runId), ['summary.json', 'summary.txt']);
  assertSummaryFiles(root, repro);

  const saved = await call(root, ['flow', 'save', 'home'], { input: 'signedIn: false\nsteps:\n  - goto: /\n' });
  assert.equal(saved.status, 'passed');
  assert.match(saved.runId, /-flow-/);
  assert.deepEqual(files(root, saved.runId), ['summary.json', 'summary.txt']);
  assertSummaryFiles(root, saved);

  const plan = await call(root, ['plan', 'quick']);
  assert.equal(plan.status, 'planned');
  assert.deepEqual(files(root, plan.runId), ['adversary', 'catalogue.json', 'diff-map.json', 'diff.patch', 'record.json', 'report.txt', 'summary.json', 'summary.txt']);
  assertSummaryFiles(root, plan);
  assert.deepEqual(recordShape(root, plan), TIER_RECORD);

  const attack = await call(root, ['attack', '--run', plan.runId]);
  assert.equal(attack.runId, plan.runId);
  assert.equal(attack.phase, 'attacked');
  assertSummaryFiles(root, attack);
  assert.deepEqual(recordShape(root, attack), TIER_RECORD);
});

test('calls that name a run write only its adversary/summary.txt, the block as printed, and leave its summary files alone', async () => {
  const root = findingRepo();
  const data = scratchDir();
  const plan = await call(root, ['plan', 'quick', '--plugin-data', data]);
  assert.equal(plan.status, 'planned');
  const before = files(root, plan.runId).map((name) => [name, name.endsWith('.json') || name.endsWith('.txt') ? runFile(root, plan.runId, name) : null]);

  const { code, stdout } = await runAsync(['link', '--run', plan.runId, '--plugin-data', data], { cwd: root, env: LOCAL, input: '{}\n' });
  assert.equal(code, 2, stdout);
  assert.equal(runFile(root, plan.runId, path.join('adversary', 'summary.txt')), stdout);
  assert.match(stdout, new RegExp(`^.*\\n?rough-ride link \\| [\\d.]+s \\| run ${plan.runId}`));
  assert.deepEqual(files(root, plan.runId).map((name) => [name, name.endsWith('.json') || name.endsWith('.txt') ? runFile(root, plan.runId, name) : null]), before);
});

test('stops: a tier stop names the run it made and writes its summary files there; regress names none', async () => {
  const reset = 'reset: node -e "process.exit(1)"\n';
  const root = findingRepo({ config: reset });
  const stop = await call(root, ['quick']);
  assert.equal(stop.stop.code, 'reset-failed');
  assert.equal(stop.status, 'stopped');
  assert.match(stop.runId, /-quick-/);
  assert.match(stop.summaryLines[0], new RegExp(`^rough-ride quick \\| [\\d.]+s \\| run ${stop.runId} \\| stopped$`));
  assert.deepEqual(files(root, stop.runId), ['diff.patch', 'record.json', 'summary.json', 'summary.txt']);
  assertSummaryFiles(root, stop);
  assert.deepEqual(recordShape(root, stop), { added: ['environment'], missing: [], replaced: [] });
  // What the run reported before the stop: the protected comparison and the contract it detected.
  assert.deepEqual(keys(stop), DOCUMENT);
  assert.deepEqual([stop.protected, stop.protectedLines, stop.contract?.status], [[], [], 'missing']);

  // With its summary.json the next tier run doesn't call it unfinished.
  const again = await call(root, ['quick']);
  assert.equal(again.stop.code, 'reset-failed');
  assert.ok(!again.notes.some((n) => n.id === 'unfinished-run'), JSON.stringify(again.notes));

  const tested = findingRepo({ config: reset, tests: { 'save-500-000001': TEST } });
  const regress = await call(tested, ['regress']);
  assert.equal(regress.stop.code, 'reset-failed');
  assert.equal(regress.runId, null);
  assert.match(regress.summaryLines[0], /^rough-ride regress \| [\d.]+s \| stopped$/);
  const made = readdirSync(path.join(tested, '.rough-ride', 'runs'));
  assert.equal(made.length, 1);
  assert.deepEqual(files(tested, made[0]), []);
});

test('outcomes without a run folder: a usage stop and nothing to attack write nothing under runs/', async () => {
  const root = findingRepo();
  const usage = await call(root, ['quick', '--no-such-flag']);
  assert.equal(usage.stop.code, 'usage');
  assert.equal(usage.runId, null);
  assert.deepEqual(keys(usage), DOCUMENT);
  assert.deepEqual([usage.protected, usage.protectedLines, usage.contract], [[], null, null]);
  sh(root, 'checkout', '--', 'src/save.js');
  const nothing = await call(root, ['quick']);
  assert.equal(nothing.status, 'nothing-to-attack');
  assert.equal(nothing.runId, null);
  assert.equal(existsSync(path.join(root, '.rough-ride', 'runs')), false);
});

// ---- The Run output module in this process, against a temp folder.

// A run output for `argv` in a fresh repository with one run folder, its
// streams and exit code captured.
function inProcess(argv, env = LOCAL) {
  const root = gitRepo();
  const run = { id: '20261031-120000-quick-ab12', dir: path.join(root, '.rough-ride', 'runs', '20261031-120000-quick-ab12') };
  mkdirSync(run.dir, { recursive: true });
  const seen = { stdout: '', stderr: '', exitCode: null, drained: 0 };
  const streams = {
    stdout: (t) => (seen.stdout += t),
    stderr: (t) => (seen.stderr += t),
    exitCode: (code) => (seen.exitCode = code),
    drain: async () => void seen.drained++,
  };
  const args = parseArgs(argv);
  const info = runnerInfo(args.pluginData, root, env);
  const output = createRunOutput({ args, info, cwd: root, env, elapsed: () => 1200, streams });
  output.located(root);
  return { root, run, seen, output, info, doc: () => JSON.parse(seen.stdout) };
}
const PROTECTED = { base: null, entries: [], config: null, flows: [], notRun: [], tests: [], accepted: null, notes: [], texts: new Map(), compareLine: null, reviewedHashes: new Map() };
const MISSING = { status: 'missing', file: null, edition: null, current: 1 };

test('a finished run writes summary.txt, record.json and summary.json last, and prints the same document', async () => {
  const { root, run, seen, output, doc } = inProcess(['quick', '--json']);
  output.notes.push({ id: 'root', text: 'root: x' });
  output.finish({ status: 'findings', exitCode: 1, lines: ['rough-ride quick | 1.2s', 'body'], document: { tier: 'quick', extra: 1 }, run, record: { environment: { ci: false } } });
  assert.equal(seen.exitCode, 1);
  assert.equal(seen.stderr, 'rough-ride quick | 1.2s\nbody\n');
  const printed = doc();
  assert.deepEqual([printed.runId, printed.status, printed.extra, printed.notes], [run.id, 'findings', 1, [{ id: 'root', text: 'root: x' }]]);
  assert.deepEqual(files(root, run.id), ['record.json', 'summary.json', 'summary.txt']);
  assertSummaryFiles(root, printed);
  assert.deepEqual(JSON.parse(runFile(root, run.id, 'record.json')), { ...printed, environment: { ci: false } });
  const written = (name) => statSync(path.join(run.dir, name)).mtimeMs;
  assert.ok(written('summary.json') >= Math.max(written('summary.txt'), written('record.json')));
});

test('an outcome with no run folder of its own writes no summary files; under --run its block still lands in adversary/summary.txt', () => {
  const data = scratchDir();
  const { root, run, seen, output } = inProcess(['snapshot', '--run', '20261031-120000-quick-ab12', '--plugin-data', data]);
  output.namedRun(run, false);
  output.finish({ status: 'passed', exitCode: 0, lines: ['rough-ride snapshot | 1.2s | run ' + run.id] });
  assert.equal(seen.stdout, `${BLOCK_START}\nrough-ride snapshot | 1.2s | run ${run.id}\n${BLOCK_END}\n`);
  assert.deepEqual(files(root, run.id), ['adversary']);
  assert.equal(runFile(root, run.id, path.join('adversary', 'summary.txt')), seen.stdout);
});

test('a stop reports what the run reported before it, and names the run it carries', () => {
  const { root, run, output, doc } = inProcess(['quick', '--json']);
  output.protectedFiles(PROTECTED);
  output.contract(MISSING);
  output.stop(makeStop('reset-failed', ['reset failed.']), { run });
  const stopped = doc();
  assert.equal(stopped.summaryLines[0], `rough-ride quick | 1.2s | run ${run.id} | stopped`);
  assert.deepEqual([stopped.status, stopped.exitCode, stopped.stop.code, stopped.runId], ['stopped', 78, 'reset-failed', run.id]);
  assert.deepEqual([stopped.protected, stopped.protectedLines, stopped.contract], [[], [], MISSING]);
  assert.deepEqual(files(root, run.id), ['record.json', 'summary.json', 'summary.txt']);
  assertSummaryFiles(root, stopped);
  const record = JSON.parse(runFile(root, run.id, 'record.json'));
  assert.deepEqual(record, { ...stopped, environment: record.environment });
  assert.equal(record.environment.mode, 'terminal');
});

test("a stop's summary files are the block as printed, markers included, with the reset tail left out", () => {
  const data = scratchDir();
  const { root, run, seen, output } = inProcess(['quick', '--json', '--plugin-data', data]);
  output.stop(makeStop('reset-failed', ['reset failed.', "(last 20 lines of reset's output: printed only)"]), { run, tail: ['secret tail line'] });
  const printed = JSON.parse(seen.stdout);
  assert.equal(printed.summaryLines[0], BLOCK_START);
  assert.ok(seen.stderr.includes('secret tail line\n'));
  assertSummaryFiles(root, printed);
  assert.ok(!runFile(root, run.id, 'summary.txt').includes('secret tail line'));
});

test('a stop on a run named by --run, or with no run, writes no summary files', () => {
  const attack = inProcess(['attack', '--run', '20261031-120000-quick-ab12', '--json']);
  attack.output.namedRun(attack.run, true);
  attack.output.stop(makeStop('reset-failed', ['reset failed.']), { run: attack.run });
  assert.equal(attack.doc().runId, attack.run.id);
  assert.deepEqual(files(attack.root, attack.run.id), []);

  const early = inProcess(['quick', '--json']);
  early.output.stop(makeStop('files-invalid', ['bad.']));
  assert.equal(early.doc().runId, null);
  assert.deepEqual(files(early.root, early.run.id), []);
});

test('a run-id stop never touches the run it refused', () => {
  const data = scratchDir();
  const { root, run, seen, output } = inProcess(['attack', '--run', '20261031-120000-quick-ab12', '--plugin-data', data]);
  output.namedRun(run, true);
  output.stop(makeStop('run-attacked', ['Run was already attacked.']), { run });
  assert.equal(seen.exitCode, 75);
  assert.deepEqual(files(root, run.id), []);
});

test('an interrupt writes summary.txt, report.txt, record.json and summary.json into the run folder it made, prints, drains, and ends the output', async () => {
  const { root, run, seen, output, info, doc } = inProcess(['regress', '--json']);
  output.notes.push({ id: 'root', text: 'root: x' });
  output.madeRun(run);
  await output.interrupt('SIGINT');
  const printed = doc();
  assert.equal(printed.summaryLines[0], `rough-ride regress | 1.2s | run ${run.id} | interrupted`);
  assert.deepEqual([printed.status, printed.exitCode, seen.exitCode, seen.drained, output.interrupted], ['interrupted', 130, 130, 1, true]);
  assert.deepEqual(files(root, run.id), ['record.json', 'report.txt', 'summary.json', 'summary.txt']);
  assertSummaryFiles(root, printed);
  assert.equal(JSON.parse(runFile(root, run.id, 'record.json')).environment.mode, 'terminal');
  assert.equal(runFile(root, run.id, 'report.txt'), text([printed.summaryLines[0], '', 'Notes', 'root: x', '', ...printed.summaryLines.slice(1)]));
  assert.ok(printed.summaryLines.slice(1).every((l, i) => l === runnerBlockOf(info)[i]));

  // Nothing after the first signal writes or prints.
  const before = seen.stdout;
  output.finish({ status: 'passed', exitCode: 0, lines: ['late'], run });
  output.stop(makeStop('reset-failed', ['late']), { run });
  await output.interrupt('SIGTERM');
  assert.equal(seen.stdout, before);
  assert.equal(seen.exitCode, 130);
  assert.equal(JSON.parse(runFile(root, run.id, 'summary.json')).status, 'interrupted');
});

test("an interrupted attack writes into its plan's run; other calls that name a run, or made none, write no files", async () => {
  const attack = inProcess(['attack', '--run', '20261031-120000-quick-ab12', '--json']);
  attack.output.namedRun(attack.run, true);
  await attack.output.interrupt('SIGTERM');
  assert.equal(attack.doc().exitCode, 143);
  assert.deepEqual(files(attack.root, attack.run.id), ['record.json', 'report.txt', 'summary.json', 'summary.txt']);

  const snapshot = inProcess(['snapshot', '--run', '20261031-120000-quick-ab12', '--json']);
  snapshot.output.namedRun(snapshot.run, false);
  await snapshot.output.interrupt('SIGINT');
  assert.equal(snapshot.doc().summaryLines[0], 'rough-ride snapshot | 1.2s | interrupted');
  assert.deepEqual(files(snapshot.root, snapshot.run.id), []);
});
