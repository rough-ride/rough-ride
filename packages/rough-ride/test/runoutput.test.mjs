import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
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

  // regress writes record.json itself: its document and the environment only.
  const regress = await call(root, ['regress']);
  assert.equal(regress.status, 'findings');
  assert.deepEqual(files(root, regress.runId), ['record.json', 'report.txt', 'summary.json', 'summary.txt']);
  assertSummaryFiles(root, regress);
  assert.deepEqual(recordShape(root, regress), {
    added: ['environment'],
    missing: ['command', 'contract', 'cwd', 'diff', 'exitCode', 'formats', 'notes', 'phase', 'preRelease', 'root', 'runner', 'scope', 'spec', 'status', 'stop', 'summaryLines', 'tier', 'versionSkew'],
    replaced: [],
  });

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

test('stops: a tier stop names the run it made but writes no run files; regress names none', async () => {
  const reset = 'reset: node -e "process.exit(1)"\n';
  const root = findingRepo({ config: reset });
  const stop = await call(root, ['quick']);
  assert.equal(stop.stop.code, 'reset-failed');
  assert.equal(stop.status, 'stopped');
  assert.match(stop.runId, /-quick-/);
  assert.match(stop.summaryLines[0], new RegExp(`^rough-ride quick \\| [\\d.]+s \\| run ${stop.runId} \\| stopped$`));
  assert.deepEqual(files(root, stop.runId), ['diff.patch']);
  // What the run reported before the stop: the protected comparison and the contract it detected.
  assert.deepEqual(keys(stop), DOCUMENT);
  assert.deepEqual([stop.protected, stop.protectedLines, stop.contract?.status], [[], [], 'missing']);

  // Without summary.json the next tier run calls it unfinished.
  const again = await call(root, ['quick']);
  assert.ok(again.notes.some((n) => n.id === 'unfinished-run' && n.text.includes(stop.runId)), JSON.stringify(again.notes));

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
