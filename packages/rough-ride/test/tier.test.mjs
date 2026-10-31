import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { capSection, inLanes, lanesFor, orderNotes } from '../dist/tier.mjs';
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
  assert.match(lines[0], new RegExp(`^rough-ride quick \\| [\\dm.]+s \\| run ${doc.runId} \\| 0\\.x pre-release: detection and false-alarm rates not measured yet$`));
  assert.match(lines[1], /^diff: main [0-9a-f]{7}\.\.working tree \| 1 file$/);
  assert.match(lines[2], new RegExp(`^target: ${site.url.replace(/[.]/g, '\\.')} \\(target\\.url in config\\.yaml\\) \\| (Chrome|Edge|Chromium) [\\d.]+$`));
  assert.ok(lines.includes('Baseline failed: broken at step 2 (expect text "Never shown"): not visible after 10 s. Not attacked until it passes.'));
  assert.match(lines.at(-1), /^Runner: rough-ride /);
  assert.ok(lines.length <= 40 && Buffer.byteLength(lines.join('\n')) <= 8000);

  const dir = path.join(root, '.rough-ride', 'runs', doc.runId);
  assert.deepEqual(readdirSync(dir).sort(), ['baseline', 'diff-map.json', 'diff.patch', 'record.json', 'report.txt', 'summary.json', 'summary.txt']);
  assert.deepEqual(readdirSync(path.join(dir, 'baseline')), ['broken.png']);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'summary.json'), 'utf8')), doc);
  assert.equal(readFileSync(path.join(dir, 'summary.txt'), 'utf8'), lines.map((l) => l + '\n').join(''));
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
  const attacked = await run(['attack', '--run', planned.runId, '--plan', '-', '--json'], { cwd: root, input: 'attacks:\n  - {flow: home, because: the open test runs on it, viewport: 375}\n' });
  const doc = JSON.parse(attacked.stdout);
  assert.ok(!doc.summaryLines.some((l) => l.startsWith('Rejected plan entry')), doc.summaryLines.join('\n'));
  const plan = JSON.parse(readFileSync(path.join(root, '.rough-ride', 'runs', planned.runId, 'plan.json'), 'utf8'));
  assert.deepEqual(plan.entries.map((e) => [e.path, e.status, e.attackIds]), [['attacks[0]', 'kept', ['home/viewport-375']]]);
});
