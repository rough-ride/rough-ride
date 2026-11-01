import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { computeDiff } from '../dist/diff.mjs';
import { checkRootEntry } from '../dist/folder.mjs';
import { lockPath } from '../dist/lock.mjs';
import { formatDuration } from '../dist/output.mjs';
import { runnerInfo } from '../dist/runner.mjs';
import { hostPolicy, LOOPBACK_ONLY } from '../dist/hosts.mjs';
import { apiOrigins, capSection, inLanes, lanesFor, orderNotes, runTier } from '../dist/tier.mjs';
import { startSite } from './fixtures/test-site.mjs';
import { gitRepo, runAsync as run, sh } from './helpers.mjs';

let site;
before(async () => {
  site = await startSite({ apiDown: 1 });
});
after(() => site?.server.close());

test('lanes follow the CPU count: 1, 2, 4 and 5 CPUs give 1, 2, 3 and 4 lanes', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 16].map(lanesFor), [1, 2, 2, 3, 4, 4]);
});

test('jobs run at most lanes at a time', async () => {
  for (const lanes of [1, 2, 3, 4]) {
    let running = 0;
    let peak = 0;
    const jobs = Array.from({ length: 9 }, () => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
    });
    await inLanes(lanes, jobs);
    assert.equal(peak, lanes);
  }
});

test("API origins are other origins on hosts the runner may contact: loopback and allow.remoteTarget, never a look-alike", () => {
  const target = { url: 'http://localhost:3000/' };
  const xhr = (url) => ({ url, resourceType: 'xhr' });
  const results = [{ requests: [
    xhr('http://localhost:3000/api/own'),
    xhr('http://localhost.attacker.example/api'),
    xhr('http://127.0.0.1.attacker.example/api'),
    xhr('http://app.localhost:4000/api'),
    xhr('http://[::1]:5000/api'),
    xhr('http://API.Example.com/api'),
    { url: 'http://127.0.0.1:6000/page', resourceType: 'document' },
  ] }];
  assert.deepEqual(apiOrigins(target, results, LOOPBACK_ONLY), ['http://[::1]:5000', 'http://app.localhost:4000']);
  assert.deepEqual(apiOrigins(target, results, hostPolicy({ remoteTarget: 'api.example.com' })), ['http://[::1]:5000', 'http://api.example.com', 'http://app.localhost:4000']);
});

test('notes follow the fixed priority; a section over its cap ends with its overflow line', () => {
  const ordered = orderNotes([{ id: 'root', text: 'r' }, { id: 'browser-newer', text: 'b' }, { id: 'automation-detection', text: 'a' }]);
  assert.deepEqual(ordered.map((n) => n.id), ['automation-detection', 'browser-newer', 'root']);
  assert.deepEqual(capSection(['a', 'b', 'c', 'd'], 3, (n) => `+${n} more`), ['a', 'b', '+2 more']);
  assert.deepEqual(capSection(['a', 'b'], 3, (n) => `+${n} more`), ['a', 'b']);
});

// A repository whose config points at the local test site, with flows on it.
function project(flows, config = '') {
  const root = gitRepo();
  sh(root, 'checkout', '-q', '-b', 'main');
  mkdirSync(path.join(root, '.rough-ride', 'flows'), { recursive: true });
  writeFileSync(path.join(root, '.rough-ride', 'config.yaml'), `schema: 0.1.0\ntarget:\n  url: ${site.url}\n${config}`);
  for (const [name, text] of Object.entries(flows)) writeFileSync(path.join(root, '.rough-ride', 'flows', `${name}.yaml`), text);
  writeFileSync(path.join(root, 'app.js'), 'export {}\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'base');
  writeFileSync(path.join(root, 'app.js'), 'export const changed = 1\n');
  return root;
}

const PASSING = 'schema: 0.1.0\nsignedIn: false\nsteps:\n  - goto: /late\n  - expect: {text: Loaded later}\n';
const BROKEN = 'schema: 0.1.0\nsignedIn: false\nsteps:\n  - goto: /\n  - expect: {text: Never shown}\n';
const SIGNED = 'schema: 0.1.0\nsignedIn: true\nsteps:\n  - goto: /\n  - expect: {text: Home}\n';

test('quick runs the baseline runs and ends as nothing attacked, with summary.json written last and equal to --json', async () => {
  const root = project({ home: PASSING, broken: BROKEN, mine: SIGNED });
  const { code, stdout } = await run(['quick', '--json'], { cwd: root });
  assert.equal(code, 0, stdout);
  const doc = JSON.parse(stdout);
  assert.equal(doc.status, 'nothing-attacked');
  assert.match(doc.runId, /^\d{8}-\d{6}-quick-[a-z0-9]{4}$/);
  assert.equal(doc.target.proof, 'config');
  assert.deepEqual(doc.flows.signIn, 'none');
  assert.deepEqual(doc.flows.baselineFailed.map((f) => `${f.flow} ${f.step}`), ['broken 2']);
  const lines = doc.summaryLines;
  assert.match(lines[0], new RegExp(`^rough-ride quick \\| [\\dm.]+s \\| run ${doc.runId} \\| early preview: accuracy not measured yet, treat findings as leads to check$`));
  assert.match(lines[1], /^diff: main [0-9a-f]{7}\.\.working tree \| 1 file$/);
  assert.match(lines[2], new RegExp(`^target: ${site.url.replace(/[.]/g, '\\.')} \\(target\\.url in config\\.yaml\\) \\| (Chrome|Edge|Chromium) [\\d.]+$`));
  assert.ok(lines.includes('Baseline failed: broken at step 2 (expect text "Never shown"): not visible after 10 s. Not attacked until it passes.'));
  assert.match(lines.at(-1), /^Runner: rough-ride /);
  assert.ok(lines.length <= 40 && Buffer.byteLength(lines.join('\n')) <= 8000);

  const dir = path.join(root, '.rough-ride', 'runs', doc.runId);
  assert.deepEqual(readdirSync(dir).sort(), ['baseline', 'diff-map.json', 'diff.patch', 'record.json', 'report.txt', 'summary.json', 'summary.txt']);
  assert.deepEqual(readdirSync(path.join(dir, 'baseline')), ['broken.png']);
  assert.ok(readFileSync(path.join(dir, 'report.txt'), 'utf8').includes('\nEarly preview: how often rough-ride catches real bugs, and how often it raises false alarms, has not been measured yet. Treat findings as leads to check.\n'));
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'summary.json'), 'utf8')), doc);
  assert.equal(readFileSync(path.join(dir, 'summary.txt'), 'utf8'), lines.map((l) => l + '\n').join(''));
});

test('diff.patch is written before the browser starts, so a throw there leaves no browser open and frees the flow lock', async () => {
  const root = project({ home: PASSING });
  // An untracked app file the diff lists but diff.patch can no longer read.
  writeFileSync(path.join(root, 'extra.js'), 'export {}\n');
  const diff = computeDiff({ root, given: null, env: process.env, nuxtRoots: [] });
  rmSync(path.join(root, 'extra.js'));
  let launched = 0;
  let closed = 0;
  const launch = async (name) => {
    launched++;
    return { browser: { close: async () => void closed++ }, name, version: '1', debugPort: null };
  };
  const env = { ...process.env };
  const report = { madeRun() {}, protectedFiles() {}, contract() {} };
  await assert.rejects(
    runTier({ subcommand: 'quick', root, folder: checkRootEntry(root), diff, info: runnerInfo(null, root, env), browserFlag: null, start: false, argv: ['quick'], env, notes: [], report, elapsed: () => 0, progress: () => {}, launch }),
    /ENOENT/,
  );
  assert.deepEqual([launched, closed], [0, 0]);
  assert.equal(existsSync(lockPath(root)), false);
});

test('the text summary is plain ASCII with no ANSI or \\r', async () => {
  const root = project({ home: PASSING });
  const { code, stdout } = await run(['quick'], { cwd: root });
  assert.equal(code, 0);
  assert.ok(!/[\x1b\r]/.test(stdout));
  assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(stdout.replace(/^Runner: .*$/m, '')), stdout);
});

test('a schema or config stop comes before any browser launch or reset', async () => {
  const root = project({ home: PASSING }, 'reset: node -e "require(\'fs\').writeFileSync(\'reset-ran\', \'\')"\nretries: 3\n');
  const { code, stdout } = await run(['quick', '--json'], { cwd: root });
  assert.equal(code, 78);
  assert.equal(JSON.parse(stdout).stop.code, 'files-invalid');
  assert.equal(existsSync(path.join(root, 'reset-ran')), false);
  assert.equal(existsSync(path.join(root, '.rough-ride', 'runs')), false);
});

test('a flow added in the diff gets two baseline runs and passes only when both do', async () => {
  const root = project({ home: PASSING });
  writeFileSync(path.join(root, '.rough-ride', 'flows', 'fresh.yaml'), PASSING);
  const { stdout } = await run(['quick', '--json'], { cwd: root });
  const doc = JSON.parse(stdout);
  assert.equal(doc.status, 'nothing-attacked');
  assert.deepEqual(doc.flows.baselineFailed, []);
  const map = JSON.parse(readFileSync(path.join(doc.runDir, 'diff-map.json'), 'utf8'));
  assert.deepEqual(Object.fromEntries(map.flows.map((f) => [f.name, f.baselineRuns])), { home: 1, fresh: 2 });
});

test('only a new flow file changed: two baseline runs and the Flows checked line', async () => {
  const root = project({ home: PASSING });
  // Undo the app change project() makes, so only the flow differs.
  sh(root, 'checkout', '-q', '--', 'app.js');
  writeFileSync(path.join(root, '.rough-ride', 'flows', 'fresh.yaml'), PASSING);
  writeFileSync(path.join(root, '.rough-ride', 'flows', 'shaky.yaml'), BROKEN);
  const doc = JSON.parse((await run(['quick', '--json'], { cwd: root })).stdout);
  assert.equal(doc.status, 'nothing-attacked');
  assert.equal(doc.exitCode, 0);
  assert.equal(
    doc.summaryLines.find((l) => l.startsWith('Nothing attacked')),
    'Nothing attacked: the diff changes no app code. Flows checked: fresh (new, passed twice), shaky (new, failed at step 2).',
  );
  assert.ok(doc.summaryLines.some((l) => l.startsWith('Baseline failed: shaky at step 2')));
});

// 47.1 and 47.3: reset and attack setup are timed, not budgeted; attack's limit is B - P.
test('the time line and meta.budget: quick and plan budget against B with reset apart, attack against B - P after its setup', async () => {
  const root = project({ home: PASSING }, 'reset: node -e "setTimeout(() => {}, 300)"\n');
  const reportOf = (doc) => readFileSync(path.join(doc.runDir, 'report.txt'), 'utf8');
  const esc = (ms) => formatDuration(ms).replace('.', '\\.');
  const fields = (doc) => {
    const { budgetedMs, lanes, cpus, nominalPlanMs, windowMs, ...rest } = doc.meta.budget;
    assert.ok(budgetedMs > 0 && budgetedMs <= doc.meta.durationMs, `budgetedMs ${budgetedMs} of ${doc.meta.durationMs}`);
    return rest;
  };

  const quick = JSON.parse((await run(['quick', '--json'], { cwd: root })).stdout);
  const q = fields(quick);
  assert.ok(q.resetMs >= 300, `resetMs ${q.resetMs}`);
  assert.deepEqual(q, { tier: 'quick', budgetMs: 120_000, overMs: 0, planMs: null, adversaryCallsMs: 0, attackSetupMs: 0, resetMs: q.resetMs, startMs: 0 });
  assert.equal(quick.meta.budgetMs, 120_000);
  assert.match(reportOf(quick), new RegExp(`^time: runner [\\dm.]+s = budgeted [\\dm.]+s of 2m00s \\+ reset ${esc(q.resetMs)} \\| app start 0\\.0s$`, 'm'));

  const planned = JSON.parse((await run(['plan', 'quick', '--json'], { cwd: root })).stdout);
  const p = fields(planned);
  const P = JSON.parse(readFileSync(path.join(planned.runDir, 'diff-map.json'), 'utf8')).meta.planMs;
  assert.ok(P > 0 && P <= planned.meta.budget.budgetedMs, `planMs ${P}`);
  assert.deepEqual(p, { tier: 'quick', budgetMs: 120_000, overMs: 0, planMs: P, adversaryCallsMs: 0, attackSetupMs: 0, resetMs: p.resetMs, startMs: 0 });
  assert.match(reportOf(planned), /^time: runner [\dm.]+s = budgeted [\dm.]+s of 2m00s \+ reset [\d.]+s \| app start 0\.0s$/m);

  const attacked = JSON.parse((await run(['attack', '--run', planned.runId, '--json'], { cwd: root })).stdout);
  const a = fields(attacked);
  assert.ok(a.attackSetupMs >= a.resetMs && a.resetMs >= 300, `setup ${a.attackSetupMs}, reset ${a.resetMs}`);
  assert.deepEqual(a, { tier: 'quick', budgetMs: 120_000, overMs: 0, planMs: P, adversaryCallsMs: 0, attackSetupMs: a.attackSetupMs, resetMs: a.resetMs, startMs: 0 });
  assert.match(reportOf(attacked), new RegExp(`^time: runner [\\dm.]+s = attack setup ${esc(a.attackSetupMs)} \\(timed, not budgeted\\) \\+ budgeted [\\dm.]+s of ${esc(120_000 - P)} \\(the quick budget less plan ${esc(P)}\\); adversary calls 0\\.0s \\(timed, not budgeted\\) \\| app start 0\\.0s$`, 'm'));
});

// 45.5: a flow above the cut has a selected attack or a test inside the cut.
test('attack: a flow whose only claim to the tier is an open regression test takes planned attacks', async () => {
  const root = project({ home: PASSING });
  mkdirSync(path.join(root, '.rough-ride', 'tests'), { recursive: true });
  writeFileSync(path.join(root, '.rough-ride', 'tests', 'home-viewport-000001.yaml'), 'schema: 0.1.0\nflow: home\nattack: {viewport: 375}\nchecks: [no-uncaught-error]\ncontext: {timezone: UTC, locale: en-US}\nfound: {finding: x, run: 20261028-101010-quick-ab12, runner: 0.1.0, date: 2026-10-28}\n');
  sh(root, 'add', '.rough-ride/tests');
  sh(root, 'commit', '-q', '-m', 'test');
  // The test failed last time, so it is open and the tier runs it whether or not the diff reaches home.
  const gitDir = sh(root, 'rev-parse', '--absolute-git-dir').trim();
  mkdirSync(path.join(gitDir, '.rough-ride'), { recursive: true });
  writeFileSync(path.join(gitDir, '.rough-ride', 'manifest.json'), JSON.stringify({ version: 1, saved: [], runs: {}, tests: { 'home-viewport-000001': { outcome: 'fail', run: 'x', at: '2026-10-28T00:00:00.000Z' } } }));
  const planned = JSON.parse((await run(['plan', 'quick', '--json'], { cwd: root })).stdout);
  assert.equal(planned.status, 'planned', planned.summaryLines?.join('\n'));
  const plan = 'attacks:\n  - {flow: home, because: the open test runs on it, viewport: 375}\n';
  // --check resolves against the catalogue plan recorded, and agrees with attack.
  const checked = await run(['attack', '--run', planned.runId, '--plan', '-', '--check', '--json'], { cwd: root, input: plan });
  assert.equal(checked.code, 0, checked.stdout);
  assert.ok(JSON.parse(checked.stdout).summaryLines.includes('Plan check: 1 entry valid, 1 planned attack'), checked.stdout);
  const attacked = await run(['attack', '--run', planned.runId, '--plan', '-', '--json'], { cwd: root, input: plan });
  const doc = JSON.parse(attacked.stdout);
  assert.ok(!doc.summaryLines.some((l) => l.startsWith('Rejected plan entry')), doc.summaryLines.join('\n'));
  const planFile = JSON.parse(readFileSync(path.join(root, '.rough-ride', 'runs', planned.runId, 'plan.json'), 'utf8'));
  assert.deepEqual(planFile.entries.map((e) => [e.path, e.status, e.attackIds]), [['attacks[0]', 'kept', ['home/viewport-375']]]);
});
