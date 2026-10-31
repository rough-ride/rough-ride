import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { checkRootEntry } from '../dist/folder.mjs';
import { runRepro } from '../dist/repro.mjs';
import { runnerInfo } from '../dist/runner.mjs';
import { SAVE_JS, startCiSite } from './fixtures/ci-site.mjs';
import { gitRepo, runAsync, scratchDir, sh } from './helpers.mjs';

let site;
before(async () => {
  site = await startCiSite();
});
after(() => site?.server.close());

const LOCAL = { CI: undefined, GITHUB_ACTIONS: undefined, GITHUB_EVENT_NAME: undefined };
const SAVE_FLOW = 'schema: 0.1.0\nsignedIn: false\nsteps:\n  - goto: /\n  - click: {role: button, name: Save}\n  - expect: {text: Saved}\n';

// A repository whose save flow reaches the changed src/save.js, and the repro id of quick's finding there.
async function finding() {
  const root = gitRepo();
  sh(root, 'checkout', '-q', '-b', 'main');
  mkdirSync(path.join(root, '.rough-ride', 'flows'), { recursive: true });
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, '.rough-ride', 'config.yaml'), `schema: 0.1.0\ntarget:\n  url: ${site.url}\n`);
  writeFileSync(path.join(root, '.rough-ride', 'flows', 'save.yaml'), SAVE_FLOW);
  writeFileSync(path.join(root, 'src', 'save.js'), SAVE_JS);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'base');
  writeFileSync(path.join(root, 'src', 'save.js'), SAVE_JS + '// changed\n');
  const { stdout } = await runAsync(['quick', '--json'], { cwd: root, env: LOCAL });
  const quick = JSON.parse(stdout);
  assert.equal(quick.status, 'findings', stdout);
  return { root, id: `${quick.runId}/${quick.findings[0].representative.repro}` };
}

function repro(root, id, elapsedMs) {
  const env = { ...process.env, ...LOCAL };
  const info = { ...runnerInfo(null, root, env), pluginData: { path: scratchDir(), verified: true } };
  const report = { madeRun() {}, protectedFiles() {}, contract() {} };
  return runRepro({ root, folder: checkRootEntry(root), info, id, keepOpen: false, browserFlag: null, start: false, argv: ['repro', id], env, notes: [], report, elapsed: () => elapsedMs, progress: () => {} });
}

test('with a plugin data folder repro keeps the Bash limits: no flow run starts after 500 s (50.4)', async () => {
  const { root, id } = await finding();
  const early = await repro(root, id, 1_000);
  assert.deepEqual([early.lines[3], early.exitCode], ['reproduced', 1]);
  const late = await repro(root, id, 501_000);
  assert.deepEqual([late.lines[3], late.exitCode, late.status], ['could not apply: stopped by the Bash time limit', 2, 'incomplete']);
});
