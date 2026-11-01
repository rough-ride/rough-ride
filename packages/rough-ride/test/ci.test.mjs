import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { contractLine } from '../dist/contract.mjs';
import { checkRootEntry } from '../dist/folder.mjs';
import { ciMode, environmentRecord, isCi, runnerInfo } from '../dist/runner.mjs';
import { pullRequestLine } from '../dist/session.mjs';
import { runSnapshot } from '../dist/snapshot.mjs';
import { PAGE as LATE_PAGE } from './fixtures/late-api.mjs';
import { SAVE_JS, startCiSite } from './fixtures/ci-site.mjs';
import { canonical, CLI, fixture, gitRepo, runAsync, scratchDir, sh } from './helpers.mjs';

const posix = { skip: process.platform === 'win32' && 'Windows has no catchable SIGTERM and kills with exit 1' };
// Every run sets both variables, so the machine running the tests can't put it in CI mode.
const LOCAL = { CI: undefined, GITHUB_ACTIONS: undefined, GITHUB_EVENT_NAME: undefined };
const IN_CI = { ...LOCAL, CI: 'true' };

let site;
let onModule = () => {};
// Another save.js for the nth load, or null for SAVE_JS.
let saveScript = () => null;
before(async () => {
  site = await startCiSite({ onModule: (n) => onModule(n), script: (n) => saveScript(n) ?? SAVE_JS });
});
after(() => site?.server.close());

const SAVE_FLOW = 'schema: 0.1.0\nsignedIn: false\nsteps:\n  - goto: /\n  - click: {role: button, name: Save}\n  - expect: {text: Saved}\n';

// A repository whose save flow reaches the changed src/save.js on the fixture
// site, so quick finds a missing error message.
function findingRepo(config = '') {
  const root = gitRepo();
  sh(root, 'checkout', '-q', '-b', 'main');
  mkdirSync(path.join(root, '.rough-ride', 'flows'), { recursive: true });
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, '.rough-ride', 'config.yaml'), `schema: 0.1.0\ntarget:\n  url: ${site.url}\n${config}`);
  writeFileSync(path.join(root, '.rough-ride', 'flows', 'save.yaml'), SAVE_FLOW);
  writeFileSync(path.join(root, 'src', 'save.js'), SAVE_JS);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'base');
  writeFileSync(path.join(root, 'src', 'save.js'), SAVE_JS + '// changed\n');
  return root;
}

const runFile = (root, id, name) => readFileSync(path.join(root, '.rough-ride', 'runs', id, name), 'utf8');

test('CI mode: GITHUB_ACTIONS=true, or CI set to anything but false or 0, with no plugin data folder', () => {
  const plain = { pluginData: null };
  const session = { pluginData: { path: '/d', verified: true } };
  assert.deepEqual([{ GITHUB_ACTIONS: 'true' }, { CI: 'true' }, { CI: '1' }, { CI: 'yes' }].map((env) => ciMode(env, plain)), [true, true, true, true]);
  assert.deepEqual([{}, { CI: '0' }, { CI: 'false' }, { GITHUB_ACTIONS: 'false' }].map((env) => ciMode(env, plain)), [false, false, false, false]);
  assert.equal(isCi({ CI: 'true' }), true);
  assert.equal(ciMode({ CI: 'true' }, session), false);
  assert.equal(environmentRecord({ CI: 'true' }, plain).mode, 'ci');
  assert.equal(environmentRecord({ CI: 'true' }, session).mode, 'session');
  assert.equal(environmentRecord({ CI: '0' }, plain).mode, 'terminal');
});

test('in CI mode an older contract line ends with the tag URL and has no (also at', () => {
  const older = { status: 'older', file: 'CLAUDE.md', edition: 1, current: 2 };
  const line = contractLine(older, { version: '0.1.0', ci: true, summary: null });
  assert.ok(line.endsWith('the text at https://github.com/rough-ride/rough-ride/blob/v0.1.0/docs/resilience-contract.md#the-text; agents leave instruction files alone.'), line);
  assert.ok(!line.includes('(also at'));
  assert.ok(contractLine(older, { version: '0.1.0', ci: false, summary: null }).includes('(also at'));
});

test('CI=true, run from frontend/: the candidate stays in run output, the lines point into the job output, no Fix, Investigate or Next line', async () => {
  const root = findingRepo();
  const { code, stdout, stderr } = await runAsync(['quick', '--json'], { cwd: path.join(root, 'frontend'), env: IN_CI });
  assert.equal(code, 1, stderr);
  const doc = JSON.parse(stdout);
  const id = doc.runId;
  const lines = doc.summaryLines;
  assert.equal(doc.status, 'findings');
  assert.equal(existsSync(path.join(root, '.rough-ride', 'tests')), false, 'nothing under .rough-ride/tests/');
  assert.equal(readdirSync(path.join(root, '.rough-ride', 'runs', id, 'tests')).length > 0, true);
  assert.ok(lines.includes(`Regression test candidates are in the job's uploaded run output (${id}/tests/). Copy one to .rough-ride/tests/ and commit it to keep it.`), lines.join('\n'));
  assert.ok(!lines.some((l) => /^(Fix, then run:|Investigate|Next:|New regression test)/.test(l)), lines.join('\n'));
  assert.ok(lines.includes(`Full report: ${id}/report.txt in the job's uploaded run output`));
  assert.equal(JSON.parse(runFile(root, id, 'record.json')).environment.mode, 'ci');
  // No contract here: the summary leaves the missing line out, report.txt keeps it.
  assert.ok(!lines.some((l) => l.startsWith('Resilience contract: not in')));
  assert.ok(runFile(root, id, 'report.txt').split('\n').some((l) => l.startsWith('Resilience contract: not in')));
  // The root note still prints in CI mode (resolution 121), in the runner's
  // canonical spelling: forward slashes and long names on Windows.
  assert.ok(lines.includes(`root: ${canonical(root)}`), lines.join('\n'));
  assert.equal(runFile(root, id, 'summary.txt'), lines.map((l) => l + '\n').join(''));
});

test('CI=false and CI=true with a plugin data folder are not CI mode: the test is written and none of the CI-mode lines print; regress in CI mode prints no Fix line and records mode ci', async () => {
  for (const [env, extra] of [[{ ...LOCAL, CI: 'false' }, []], [IN_CI, ['--plugin-data', scratchDir()]]]) {
    const root = findingRepo();
    const { code, stdout, stderr } = await runAsync(['quick', '--json', ...extra], { cwd: root, env: { ...env, AI_AGENT: '' } });
    assert.equal(code, 1, stderr);
    const doc = JSON.parse(stdout);
    const text = doc.summaryLines.join('\n');
    assert.equal(readdirSync(path.join(root, '.rough-ride', 'tests')).length, 1, text);
    assert.doesNotMatch(text, /job's uploaded run output|in the job log/);
    assert.match(text, /^Fix, then run: /m);
    assert.notEqual(JSON.parse(runFile(root, doc.runId, 'record.json')).environment.mode, 'ci');
    if (extra.length > 0) continue;
    // regress runs the test it wrote: it fails, and CI mode prints no Fix line (51.12).
    for (const [mode, fix] of [[IN_CI, false], [LOCAL, true]]) {
      const regress = await runAsync(['regress', '--json'], { cwd: root, env: mode });
      assert.equal(regress.code, 1, regress.stderr);
      const r = JSON.parse(regress.stdout);
      assert.equal(r.summaryLines.some((l) => l.startsWith('Fix, then run: ')), fix, r.summaryLines.join('\n'));
      assert.equal(r.summaryLines.includes(`Full report: ${r.runId}/report.txt in the job's uploaded run output`), !fix);
      // record.json carries the environment; summary.json does not (38, 52.1).
      assert.equal(JSON.parse(runFile(root, r.runId, 'record.json')).environment.mode, fix ? 'terminal' : 'ci');
      assert.equal('environment' in JSON.parse(runFile(root, r.runId, 'summary.json')), false);
    }
  }
});

// A save.js that shows a message when the save fails.
const FIXED_JS = SAVE_JS.replace('.catch(() => {});', ".catch(() => { document.getElementById('out').textContent = 'Could not save'; });");

test('CI mode, a finding not confirmed when run again alone: no candidates line, though the candidate is in run output (52.2)', async () => {
  // A first run counts the page's module loads; the last one is the confirmation run.
  const before = site.served();
  const first = JSON.parse((await runAsync(['quick', '--json'], { cwd: findingRepo(), env: IN_CI })).stdout);
  assert.equal(first.status, 'findings');
  const loads = site.served() - before;
  const base = site.served();
  saveScript = (n) => (n - base >= loads ? FIXED_JS : null);
  try {
    const root = findingRepo();
    const { stdout } = await runAsync(['quick', '--json'], { cwd: root, env: IN_CI });
    const doc = JSON.parse(stdout);
    const lines = doc.summaryLines;
    assert.ok(lines.includes('Not shown: 0 more finding groups, 1 not confirmed when run again alone (report.txt)'), lines.join('\n'));
    assert.ok(!lines.some((l) => l.startsWith('Regression test candidates are in')), lines.join('\n'));
    assert.equal(readdirSync(path.join(root, '.rough-ride', 'runs', doc.runId, 'tests')).length > 0, true);
  } finally {
    saveScript = () => null;
  }
});

test('quick in CI mode with more regression tests than the quick cap and no attack cut prints the More attacks line (52.2)', async () => {
  const root = gitRepo();
  sh(root, 'checkout', '-q', '-b', 'main');
  for (const dir of ['flows', 'tests']) mkdirSync(path.join(root, '.rough-ride', dir), { recursive: true });
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, '.rough-ride', 'config.yaml'), `schema: 0.1.0\ntarget:\n  url: ${site.url}\n`);
  writeFileSync(path.join(root, '.rough-ride', 'flows', 'save.yaml'), SAVE_FLOW);
  // Seven tests on the save flow, which the diff reaches; quick runs 6.
  for (let i = 1; i <= 7; i++) {
    writeFileSync(
      path.join(root, '.rough-ride', 'tests', `save-500-00000${i}.yaml`),
      'schema: 0.1.0\nflow: save\nattack: {fault: "500", sticky: true, request: "POST /api/save #1", page: /}\nchecks: [no-uncaught-error]\ncontext: {timezone: UTC, locale: en-US}\nfound: {finding: x, run: 20261028-101010-quick-ab12, runner: 0.1.0, date: 2026-10-28}\n',
    );
  }
  writeFileSync(path.join(root, 'src', 'save.js'), SAVE_JS);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'base');
  writeFileSync(path.join(root, 'src', 'save.js'), SAVE_JS + '// changed\n');
  const { stdout, stderr } = await runAsync(['quick', '--json'], { cwd: root, env: IN_CI });
  const lines = JSON.parse(stdout).summaryLines;
  assert.ok(lines.includes('Regression tests: 6 passed | 1 over the quick budget'), lines.join('\n') + stderr);
  assert.ok(!lines.find((l) => l.startsWith('Attacks: ')).includes('over the quick budget'), 'no attack was cut');
  assert.ok(lines.some((l) => /^More attacks: .* standard$/.test(l)), lines.join('\n'));
});

test('a reset that prints 50 lines and exits 1, with --json: stdout is one document, stderr has the last 20 lines, CI mode points at the job log', async () => {
  const reset = `reset: node -e "for (let i = 1; i <= 50; i++) console.log('reset line ' + i); process.exit(1)"\n`;
  for (const [env, placeholder] of [[IN_CI, "(last 20 lines of reset's output: in the job log)"], [LOCAL, "(last 20 lines of reset's output: printed only)"]]) {
    const root = findingRepo(reset);
    const { code, stdout, stderr } = await runAsync(['quick', '--json'], { cwd: root, env });
    assert.equal(code, 78);
    const doc = JSON.parse(stdout);
    assert.equal(doc.stop.code, 'reset-failed');
    assert.ok(doc.summaryLines.includes(placeholder), doc.summaryLines.join('\n'));
    assert.ok(!/reset line \d/.test(stdout), 'no output of reset on stdout');
    for (let i = 31; i <= 50; i++) assert.ok(stderr.includes(`  reset line ${i}\n`), `line ${i}`);
    assert.ok(!stderr.includes('reset line 30\n'));
  }
});

// ---- The missing-variable check (51.8, 52.5).

const SIGN_IN = 'schema: 0.1.0\nsignedIn: false\nsteps:\n  - goto: /\n  - fill: {label: Password}\n    value: "${env.DEMO_PASSWORD}"\n';

function signInRepo() {
  const root = gitRepo();
  sh(root, 'checkout', '-q', '-b', 'main');
  mkdirSync(path.join(root, '.rough-ride', 'flows'), { recursive: true });
  const mark = (name) => `node -e "require('fs').writeFileSync('${name}', '')"`;
  writeFileSync(path.join(root, '.rough-ride', 'config.yaml'), `schema: 0.1.0\ntarget:\n  url: http://127.0.0.1:1\n  start: ${mark('started')}\nreset: ${mark('reset-ran')}\n`);
  writeFileSync(path.join(root, '.rough-ride', 'flows', 'sign-in.yaml'), SIGN_IN);
  writeFileSync(path.join(root, 'app.js'), 'export {}\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'base');
  writeFileSync(path.join(root, 'app.js'), 'export const changed = 1\n');
  return root;
}

test('DEMO_PASSWORD="" stops quick --start with 78 before the start command, reset or a browser, in CI mode and outside it', async () => {
  for (const env of [IN_CI, LOCAL]) {
    const root = signInRepo();
    const { code, stdout } = await runAsync(['quick', '--start', '--json'], { cwd: root, env: { ...env, DEMO_PASSWORD: '' } });
    assert.equal(code, 78, stdout);
    const doc = JSON.parse(stdout);
    assert.equal(doc.stop.code, 'env-missing');
    assert.match(doc.stop.lines[0], /^The sign-in flow uses DEMO_PASSWORD, which isn't set\./);
    assert.equal(doc.stop.lines.length, 1, 'no pull request line outside a pull_request event');
    assert.equal(existsSync(path.join(root, 'started')), false, 'the start command never ran');
    assert.equal(existsSync(path.join(root, 'reset-ran')), false, 'reset never ran');
    assert.equal(existsSync(path.join(root, '.rough-ride', 'runs')), false, 'no run folder, so no browser');
  }
});

test('flow save --start with a committed sign-in flow and DEMO_PASSWORD="" stops with 78 before the start command, reset or a browser', async () => {
  const root = signInRepo();
  const input = 'signedIn: false\nsteps:\n  - goto: /\n';
  const { code, stdout } = await runAsync(['flow', 'save', 'home', '--start', '--json'], { cwd: root, env: { ...LOCAL, DEMO_PASSWORD: '' }, input });
  assert.equal(code, 78, stdout);
  const doc = JSON.parse(stdout);
  assert.equal(doc.stop.code, 'env-missing');
  assert.match(doc.stop.lines[0], /^The sign-in flow uses DEMO_PASSWORD, which isn't set\./);
  assert.equal(existsSync(path.join(root, 'started')), false, 'the start command never ran');
  assert.equal(existsSync(path.join(root, 'reset-ran')), false, 'reset never ran');
  assert.equal(existsSync(path.join(root, '.rough-ride', 'runs')), false, 'no run folder, so no browser');
  assert.equal(existsSync(path.join(root, '.rough-ride', 'flows', 'home.yaml')), false);
});

// Calls snapshot in this process, with a launch that counts and throws.
async function snapshotCall(root, runId, stdin) {
  const env = { ...process.env, ...LOCAL, DEMO_PASSWORD: '' };
  let launches = 0;
  const launch = async () => {
    launches++;
    throw new Error('launched');
  };
  const ctx = { root, folder: checkRootEntry(root), info: runnerInfo(null, root, env), runId, stdin, browserFlag: null, argv: ['snapshot', '--run', runId], env, notes: [], report: { madeRun() {}, namedRun() {}, protectedFiles() {}, contract() {} }, elapsed: () => 0, launch };
  try {
    await runSnapshot(ctx);
    return { launches, error: null };
  } catch (error) {
    return { launches, error };
  }
}

test('snapshot with a signed-in document and DEMO_PASSWORD="" stops before the browser; with none signed in it still runs', async () => {
  const root = findingRepo();
  const plan = JSON.parse((await runAsync(['plan', 'quick', '--json'], { cwd: root, env: LOCAL })).stdout);
  assert.equal(plan.status, 'planned', JSON.stringify(plan.stop));
  writeFileSync(path.join(root, '.rough-ride', 'flows', 'sign-in.yaml'), SIGN_IN);
  sh(root, 'add', path.join('.rough-ride', 'flows', 'sign-in.yaml'));
  sh(root, 'commit', '-qm', 'sign-in');

  const stopped = await snapshotCall(root, plan.runId, 'signedIn: true\nsteps:\n  - goto: /\n');
  assert.equal(stopped.error?.stop?.code, 'env-missing', String(stopped.error));
  assert.match(stopped.error.stop.lines[0], /^The sign-in flow uses DEMO_PASSWORD, which isn't set\./);
  assert.equal(stopped.launches, 0);
  // No document signed in: the sign-in flow never runs, so its variable doesn't matter.
  const ran = await snapshotCall(root, plan.runId, 'signedIn: false\nsteps:\n  - goto: /\n');
  assert.equal(ran.error?.message, 'launched', String(ran.error));
  assert.equal(ran.launches, 1);
});

test('in a pull_request event the stop adds the fork, Dependabot or same-repository line', async () => {
  const event = (fullName) => {
    const file = path.join(scratchDir(), 'event.json');
    writeFileSync(file, JSON.stringify({ pull_request: { head: { repo: fullName === null ? null : { full_name: fullName } } } }));
    return file;
  };
  const pr = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'owner/app' };
  const fork = "Pull requests from forks get no secrets, so the sign-in flow can't run here.";
  assert.equal(pullRequestLine('DEMO_PASSWORD', 1, { ...pr, GITHUB_EVENT_PATH: event('someone/app') }), fork);
  assert.equal(pullRequestLine('DEMO_PASSWORD', 1, { ...pr, GITHUB_EVENT_PATH: event(null) }), fork);
  assert.equal(
    pullRequestLine('DEMO_PASSWORD', 1, { ...pr, GITHUB_EVENT_PATH: event('owner/app'), GITHUB_ACTOR: 'dependabot[bot]' }),
    'Dependabot pull requests get only Dependabot secrets: add DEMO_PASSWORD under Settings > Secrets and variables > Dependabot.',
  );
  const same = "This run got no value for DEMO_PASSWORD: add it as a repository secret and map it in the workflow step's env, or use CI-only values (https://github.com/rough-ride/rough-ride/blob/main/docs/github-actions.md).";
  assert.equal(pullRequestLine('DEMO_PASSWORD', 1, { ...pr, GITHUB_EVENT_PATH: event('owner/app'), GITHUB_ACTOR: 'someone' }), same);
  assert.equal(pullRequestLine('DEMO_PASSWORD', 1, { ...pr, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event('someone/app') }), null);

  // Through the CLI, unset and empty alike.
  const root = signInRepo();
  for (const [extra, line] of [[{ GITHUB_EVENT_PATH: event('someone/app') }, fork], [{ GITHUB_EVENT_PATH: event('owner/app'), GITHUB_ACTOR: 'dependabot[bot]', DEMO_PASSWORD: '' }, /^Dependabot pull requests/], [{ GITHUB_EVENT_PATH: event('owner/app'), GITHUB_ACTOR: 'someone' }, same]]) {
    const { code, stdout } = await runAsync(['quick', '--start', '--json'], { cwd: root, env: { ...IN_CI, DEMO_PASSWORD: undefined, ...pr, ...extra } });
    assert.equal(code, 78);
    const lines = JSON.parse(stdout).stop.lines;
    assert.equal(lines.length, 2);
    if (typeof line === 'string') assert.equal(lines[1], line);
    else assert.match(lines[1], line);
  }
  assert.equal(existsSync(path.join(root, 'started')), false);
});

// ---- regress with no test (51.12).

test('regress --start with no test anywhere prints the no-tests line and the runner line, exits 0, and starts nothing', async () => {
  for (const env of [IN_CI, LOCAL]) {
    const root = signInRepo();
    const { code, stdout } = await runAsync(['regress', '--start'], { cwd: root, env: { ...env, DEMO_PASSWORD: '' } });
    assert.equal(code, 0, stdout);
    const lines = stdout.trimEnd().split('\n');
    assert.match(lines[0], /^rough-ride regress \| [0-9.ms]+$/);
    assert.equal(lines[1], 'No regression tests in .rough-ride/tests/.');
    assert.match(lines[2], /^Runner: /);
    for (const name of ['started', 'reset-ran']) assert.equal(existsSync(path.join(root, name)), false, name);
    assert.equal(existsSync(path.join(root, '.rough-ride', 'runs')), false);
  }
});

// ---- --start waits for a slow API (51.6, resolution 133).

function freePort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function lateRepo(delayMs, startTimeout, { start = true } = {}) {
  const [web, api] = [await freePort(), await freePort()];
  const root = gitRepo();
  sh(root, 'checkout', '-q', '-b', 'main');
  mkdirSync(path.join(root, '.rough-ride', 'flows'), { recursive: true });
  const startLine = start ? `  start: node "${fixture('late-api.mjs')}" ${web} ${api} ${delayMs}\n  startTimeout: ${startTimeout}\n` : '';
  writeFileSync(path.join(root, '.rough-ride', 'config.yaml'), `schema: 0.1.0\ntarget:\n  url: http://127.0.0.1:${web}\n${startLine}`);
  writeFileSync(path.join(root, '.rough-ride', 'flows', 'sign-in.yaml'), 'schema: 0.1.0\nsignedIn: false\nsteps:\n  - goto: /\n  - expect: {text: Ready}\n');
  writeFileSync(path.join(root, 'app.js'), 'export {}\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'base');
  writeFileSync(path.join(root, 'app.js'), 'export const changed = 1\n');
  return { root, web, api };
}

test('--start with an API that listens 20 s after the start command: the retried sign-in runs are app start, not budgeted time', async () => {
  const { root, api } = await lateRepo(20_000, 60);
  const { code, stdout, stderr } = await runAsync(['quick', '--start', '--json'], { cwd: root, env: LOCAL });
  assert.equal(code, 0, stderr);
  const doc = JSON.parse(stdout);
  assert.equal(doc.flows.signIn, 'passed');
  const { startMs, budgetedMs } = doc.meta.budget;
  // App start leaves out the runner's own reset and browser launch between
  // the web answering and the first sign-in run: about 2 s on Windows runners.
  // Without the retried runs it would be under 2 s.
  assert.ok(startMs >= 15_000, `startMs ${startMs}`);
  assert.ok(budgetedMs < 15_000, `budgetedMs ${budgetedMs}`);
  assert.ok(doc.summaryLines[2].includes(`API http://127.0.0.1:${api}`), doc.summaryLines[2]);
  assert.match(runFile(root, doc.runId, 'report.txt'), /\| app start (1[5-9]|2\d)(\.\d)?s\n/);
});

test('--start with an API that never listens stops with Nothing answers once target.startTimeout has passed', async () => {
  const { root, api } = await lateRepo(-1, 6);
  const started = Date.now();
  const { code, stdout } = await runAsync(['quick', '--start', '--json'], { cwd: root, env: LOCAL });
  const ms = Date.now() - started;
  assert.equal(code, 78);
  const doc = JSON.parse(stdout);
  assert.equal(doc.stop.code, 'nothing-at-api');
  assert.equal(doc.stop.lines[0], `Nothing answers at http://127.0.0.1:${api}. Start the API or set target.start.`);
  assert.ok(ms >= 6000, `stopped after ${ms} ms, before target.startTimeout`);
});

test('attached, with the API down, the first refused sign-in run stops with no retry', async () => {
  const { root, web, api } = await lateRepo(0, 60, { start: false });
  let hits = 0;
  // findTarget's own probe doesn't count: only the browser's requests.
  const server = createServer((req, res) => {
    if (req.url === '/' && /Chrome/.test(req.headers['user-agent'] ?? '')) hits++;
    res.setHeader('content-type', 'text/html');
    res.end(LATE_PAGE(api));
  });
  await new Promise((resolve) => server.listen(web, '127.0.0.1', resolve));
  try {
    const { code, stdout } = await runAsync(['quick', '--json'], { cwd: root, env: LOCAL });
    assert.equal(code, 78);
    assert.equal(JSON.parse(stdout).stop.code, 'nothing-at-api');
    assert.equal(hits, 1);
  } finally {
    server.close();
  }
});

// ---- Signals during attacks (51.13).

// Runs quick --json and sends SIGINT `count` times, 200 ms apart, once the
// first attack run has loaded the page's module.
function interruptedQuick(root, count) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'quick', '--json'], { cwd: root, env: { ...process.env, AI_AGENT: '', CLAUDE_CODE_EXECPATH: '', CI: 'true', GITHUB_ACTIONS: '' } });
    let stdout = '';
    let signalledAt = 0;
    const base = site.served();
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.resume();
    onModule = (n) => {
      if (n - base !== 2 || signalledAt) return;
      setTimeout(() => {
        signalledAt = Date.now();
        for (let i = 0; i < count; i++) setTimeout(() => child.kill('SIGINT'), i * 200);
      }, 300);
    };
    child.on('close', (code) => {
      onModule = () => {};
      resolve({ code, stdout, ms: Date.now() - signalledAt });
    });
  });
}

for (const count of [1, 2]) {
  test(`${count === 1 ? 'SIGINT' : 'two SIGINTs 200 ms apart'} during attacks: one interrupt, exit 130, the run's files and the stdout document complete within 5 s`, posix, async () => {
    const root = findingRepo();
    const before = site.served();
    const { code, stdout, ms } = await interruptedQuick(root, count);
    assert.ok(site.served() - before >= 2, 'the signal came during attacks');
    assert.equal(code, 130);
    assert.ok(ms < 5000, `exited ${ms} ms after the signal`);
    const doc = JSON.parse(stdout);
    assert.equal(doc.status, 'interrupted');
    assert.equal(doc.exitCode, 130);
    assert.match(doc.runId, /^\d{8}-\d{6}-quick-[a-z0-9]{4}$/);
    assert.match(doc.summaryLines[0], new RegExp(`^rough-ride quick \\| [\\dm.]+s \\| run ${doc.runId} \\| interrupted$`));
    assert.match(doc.summaryLines.at(-1), /^Runner: /);
    assert.deepEqual(JSON.parse(runFile(root, doc.runId, 'summary.json')), doc);
    const record = JSON.parse(runFile(root, doc.runId, 'record.json'));
    assert.equal(record.status, 'interrupted');
    assert.equal(record.environment.mode, 'ci');
    const report = runFile(root, doc.runId, 'report.txt');
    assert.ok(report.startsWith(doc.summaryLines[0] + '\n') && report.endsWith(doc.summaryLines.at(-1) + '\n'), report);
    assert.equal(runFile(root, doc.runId, 'summary.txt'), doc.summaryLines.map((l) => l + '\n').join(''));
  });
}
