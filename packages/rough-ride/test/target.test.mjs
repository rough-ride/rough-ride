import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { StopError } from '../dist/exit.mjs';
import { findTarget, isLoopbackHost, lockUrlPath, nuxtCandidates, proveLock, readLock } from '../dist/target.mjs';
import { canonical, gitRepo, scratchDir } from './helpers.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-nuxt.mjs', import.meta.url));
const TREE = fileURLToPath(new URL('./fixtures/tree.mjs', import.meta.url));
const SAMPLE = fileURLToPath(new URL('../../../.scratch/chaos-v1/prototypes/sample-app/', import.meta.url));
const posix = { skip: process.platform === 'win32' && 'process groups are POSIX; Windows uses taskkill' };
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Under load a killed process can take a moment to be reaped. A zombie counts
// as gone: it is dead, and only waits for whoever is PID 1 to reap it (in a
// container whose PID 1 is node, nobody does).
function zombie(pid) {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').startsWith('Z');
  } catch {
    return false;
  }
}

async function assertGone(pid, label) {
  for (let i = 0; i < 60; i++) {
    try {
      process.kill(pid, 0);
      if (zombie(pid)) return;
    } catch (error) {
      if (error.code === 'ESRCH') return;
    }
    await sleep(50);
  }
  assert.fail(`${label}: pid ${pid} still running`);
}

function nuxtApp(root, rel, { dev = 'nuxt dev' } = {}) {
  const dir = path.join(root, ...rel.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'nuxt.config.ts'), 'export default {}\n');
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev }, dependencies: { nuxt: '^4.6.2' } }));
  return dir;
}

async function fakeNuxt(dir, host = '::1', port = 0) {
  const child = spawn(process.execPath, [FAKE, dir, host, String(port)], { stdio: 'ignore' });
  children.push(child);
  for (let i = 0; i < 100 && !readLock({ dir })?.port; i++) await sleep(50);
  return child;
}

function stopFakes() {
  while (children.length) children.pop().kill();
}

function serve(port, host = '127.0.0.1', status = 200) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.statusCode = status;
      res.end('impostor');
    });
    server.listen(port, host, () => resolve(server));
  });
}

async function stopOf(promise) {
  try {
    const target = await promise;
    target.children?.stop();
    return { target };
  } catch (error) {
    if (error instanceof StopError) return { stop: error.stop, tail: error.tail };
    throw error;
  }
}

const options = (root, extra = {}) => ({
  root,
  config: null,
  configSchema: null,
  start: false,
  pluginData: null,
  againCommand: '/rough-ride:quick',
  notes: [],
  attachWaitMs: 300,
  ...extra,
});

function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test('the listing finds frontend/nuxt.config.ts and drops non-Nuxt, dropped and .rough-ride folders', () => {
  const root = gitRepo();
  nuxtApp(root, 'frontend');
  nuxtApp(root, 'node_modules/some-lib');
  nuxtApp(root, '.rough-ride/x');
  nuxtApp(root, 'apps/web/.output');
  mkdirSync(path.join(root, 'tools'));
  writeFileSync(path.join(root, 'tools', 'nuxt.config.ts'), '');
  writeFileSync(path.join(root, 'tools', 'package.json'), '{"dependencies":{"vue":"3"}}');
  assert.deepEqual(nuxtCandidates(root).map((c) => c.rel), ['frontend/']);
});

test('the lock URL uses the lock\'s own cwd spelling, with a slash before a drive letter', () => {
  assert.equal(lockUrlPath('/Users/me/app/frontend'), '/_nuxt/@fs/Users/me/app/frontend/.nuxt/nuxt.lock');
  assert.equal(lockUrlPath('C:\\Users\\me\\app'), '/_nuxt/@fs/C:/Users/me/app/.nuxt/nuxt.lock');
});

test('loopback means resolving only to loopback addresses', async () => {
  for (const host of ['localhost', 'app.localhost', '127.0.0.2', '::1', '[::1]']) assert.equal(await isLoopbackHost(host), true, host);
  for (const host of ['192.168.1.5', '10.0.0.1', '0.0.0.0', 'remote.invalid']) assert.equal(await isLoopbackHost(host), false, host);
});

test('with Nuxt on ::1 and another process on 127.0.0.1:<port>, the runner proves and uses Nuxt', async (t) => {
  const root = gitRepo();
  const dir = nuxtApp(root, 'frontend');
  await fakeNuxt(dir, '::1');
  t.after(stopFakes);
  const port = readLock({ dir }).port;
  const impostor = await serve(port, '127.0.0.1');
  t.after(() => impostor.close());
  const { target } = await stopOf(findTarget(options(root)));
  assert.deepEqual([target.url, target.proof, target.nuxtRoot.rel], [`http://localhost:${port}`, 'nuxt-lock', 'frontend/']);
});

test('a lock that names another folder, or bytes that differ, leave the target unproven', async (t) => {
  const root = gitRepo();
  const dir = nuxtApp(root, 'frontend');
  await fakeNuxt(dir);
  t.after(stopFakes);
  const lock = JSON.parse(readFileSync(path.join(dir, '.nuxt', 'nuxt.lock'), 'utf8'));
  writeFileSync(path.join(dir, '.nuxt', 'nuxt.lock'), JSON.stringify({ ...lock, cwd: scratchDir() }));
  assert.equal(await proveLock({ dir, rel: 'frontend/' }), null);
  const { stop } = await stopOf(findTarget(options(root)));
  assert.equal(stop.code, 'target-unproven');
});

test('no lock and no --start stops with nothing-running and the detected start command', async () => {
  const root = gitRepo();
  nuxtApp(root, 'frontend', { dev: 'nuxt dev --port 3731' });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'node scripts/dev.mjs' } }));
  writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
  let { stop } = await stopOf(findTarget(options(root)));
  assert.deepEqual([stop.code, stop.lines], [
    'nothing-running',
    [`Nothing answers at http://localhost:3731. Start the app (pnpm run dev in ${canonical(root)}), or run again with --start.`],
  ]);
  ({ stop } = await stopOf(findTarget(options(root, { pluginData: '/data' }))));
  assert.deepEqual(stop.lines, [
    `Nothing answers at http://localhost:3731. Start the app in a background shell (pnpm run dev in ${canonical(root)}), then run /rough-ride:quick again.`,
  ]);
});

test('without a root dev script, the Nuxt folder\'s own runs there with its package manager', async () => {
  const root = gitRepo();
  const dir = nuxtApp(root, 'frontend');
  writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  const { stop } = await stopOf(findTarget(options(root)));
  assert.equal(stop.lines[0], `Nothing answers at http://localhost:3000. Start the app (npm run dev in ${canonical(dir)}), or run again with --start.`);
});

test('two candidates: attach to the one running; ask when none or both run, or when there is none', async (t) => {
  t.after(stopFakes);
  const root = gitRepo();
  nuxtApp(root, 'apps/admin');
  const web = nuxtApp(root, 'apps/web');
  let { stop } = await stopOf(findTarget(options(root, { configSchema: '0.0.9' })));
  assert.equal(stop.code, 'ask');
  assert.equal(stop.lines[0], "Found 2 Nuxt apps (apps/admin/, apps/web/) and none of them is running, so rough-ride can't tell which one to attack.");
  assert.match(stop.lines[2], /^# yaml-language-server: \$schema=https:\/\/raw\.githubusercontent\.com\/rough-ride\/rough-ride\/v0\.1\.0\//);
  assert.equal(stop.lines[3], 'schema: 0.1.0');
  assert.equal(stop.lines[4], '# Also change schema: 0.0.9 at the top of .rough-ride/config.yaml to schema: 0.1.0.');
  assert.deepEqual(stop.lines.slice(5), ['target:', '  url: http://localhost:3000', '  start: npm run dev']);

  await fakeNuxt(web);
  const { target } = await stopOf(findTarget(options(root)));
  assert.equal(target.nuxtRoot.rel, 'apps/web/');

  await fakeNuxt(path.join(root, 'apps', 'admin'));
  ({ stop } = await stopOf(findTarget(options(root))));
  assert.match(stop.lines[0], /and 2 of them are running/);

  ({ stop } = await stopOf(findTarget(options(gitRepo()))));
  assert.deepEqual([stop.code, stop.lines[0]], ['ask', 'No Nuxt app found in this repository and no target.url in .rough-ride/config.yaml.']);
});

test('with target.url set the runner uses it, never asks, and notes page tracing', async (t) => {
  const root = gitRepo();
  nuxtApp(root, 'apps/admin');
  nuxtApp(root, 'apps/web');
  const port = await freePort();
  const server = await serve(port);
  t.after(() => server.close());
  const notes = [];
  const { target } = await stopOf(findTarget(options(root, { config: { schema: '0.1.0', target: { url: `http://127.0.0.1:${port}` } }, notes })));
  assert.deepEqual([target.url, target.proof, target.started], [`http://127.0.0.1:${port}`, 'config', false]);
  assert.deepEqual(notes, [{ id: 'tracing', text: 'Page tracing: unavailable (no proven Nuxt root for target.url)' }]);
});

test('a non-loopback target.url is refused unless allow.remoteTarget names its host', async () => {
  const root = gitRepo();
  const { stop } = await stopOf(findTarget(options(root, { config: { schema: '0.1.0', target: { url: 'http://192.168.1.5:3000' } } })));
  assert.equal(stop.code, 'target-not-loopback');
  assert.match(stop.lines[0], /^target\.url http:\/\/192\.168\.1\.5:3000 is not on this machine/);
  const allowed = await stopOf(findTarget(options(root, {
    config: { schema: '0.1.0', target: { url: 'http://remote.invalid:3000' }, allow: { remoteTarget: 'remote.invalid' } },
  })));
  assert.equal(allowed.stop.code, 'nothing-running');
});

test('--start with anything answering at the config URL refuses to start', async (t) => {
  const port = await freePort();
  const server = await serve(port, '127.0.0.1', 401);
  t.after(() => server.close());
  const { stop } = await stopOf(findTarget(options(gitRepo(), { start: true, config: { schema: '0.1.0', target: { url: `http://127.0.0.1:${port}`, start: 'node -e 1' } } })));
  assert.equal(stop.code, 'start-conflict');
});

test('--start with a proven running Nuxt app starts no second server', async (t) => {
  const root = gitRepo();
  const dir = nuxtApp(root, 'frontend', { dev: 'node -e "require(\'fs\').writeFileSync(\'started\', \'\')"' });
  await fakeNuxt(dir);
  t.after(stopFakes);
  const { target } = await stopOf(findTarget(options(root, { start: true })));
  assert.deepEqual([target.started, target.children], [false, null]);
  await sleep(300);
  assert.equal(existsSync(path.join(dir, 'started')), false);
});

test('--start runs a target.start list side by side in the git root, passes the environment through and ends every process', posix, async () => {
  const root = gitRepo();
  const [p1, p2] = [await freePort(), await freePort()];
  const out = (n) => path.join(root, `tree-${n}.json`);
  const names = { HTTP_PROXY: 'http://proxy:1', https_proxy: 'http://proxy:2', NO_PROXY: 'localhost', NODE_USE_ENV_PROXY: '1', NUXT_PUBLIC_X: 'y' };
  Object.assign(process.env, names);
  try {
    const config = {
      schema: '0.1.0',
      target: { url: `http://127.0.0.1:${p1}`, start: [`node "${TREE}" "${out(1)}" ${p1}`, `node "${TREE}" "${out(2)}" ${p2}`] },
    };
    const target = await findTarget(options(root, { start: true, config }));
    assert.equal(target.started, true);
    for (const n of [1, 2]) for (let i = 0; i < 200 && !existsSync(out(n)); i++) await sleep(50);
    const trees = [1, 2].map((n) => JSON.parse(readFileSync(out(n), 'utf8')));
    for (const tree of trees) {
      assert.equal(tree.cwd, root);
      for (const [k, v] of Object.entries(names)) assert.equal(tree.env[k], v, k);
      for (const k of Object.keys(tree.env)) assert.equal(tree.env[k], process.env[k], k);
    }
    target.children.stop();
    for (const tree of trees) for (const pid of [tree.pid, tree.grandchild]) await assertGone(pid, 'stop()');
  } finally {
    for (const k of Object.keys(names)) delete process.env[k];
  }
});

test('a failing --start stops with start-failed and its redacted tail; a slow one with start-timeout', async () => {
  const root = gitRepo();
  const port = await freePort();
  const failing = {
    schema: '0.1.0',
    target: { url: `http://127.0.0.1:${port}`, start: 'node -e "for (let i = 0; i < 30; i++) console.log(\'line \' + i); console.log(\'token s3cr3t-value\'); process.exit(3)"' },
  };
  let { stop, tail } = await stopOf(findTarget(options(root, { start: true, config: failing, secrets: ['s3cr3t-value'] })));
  assert.equal(stop.code, 'start-failed');
  assert.match(stop.lines[0], /exited with code 3 before the app answered/);
  assert.equal(stop.lines[1], "(last 20 lines of --start's output: printed only)");
  assert.equal(tail.length, 21);
  assert.equal(tail.at(-1), '  token <redacted>');
  assert.equal(tail[1], '  line 11');

  const slow = { schema: '0.1.0', target: { url: `http://127.0.0.1:${port}`, start: 'node -e "setTimeout(() => {}, 30000)"', startTimeout: 1 } };
  ({ stop } = await stopOf(findTarget(options(root, { start: true, config: slow }))));
  assert.deepEqual([stop.code, stop.lines[0]], ['start-timeout', `--start timed out: http://127.0.0.1:${port} did not answer within 1 s.`]);
});

test('--start of a detected Nuxt app waits for the new lock and uses the port written there', async () => {
  const root = gitRepo();
  const dir = nuxtApp(root, 'frontend', { dev: `node "${FAKE}" "${'.'}" 127.0.0.1 0` });
  // The fake writes its lock under the folder it is started in, as Nuxt does.
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: `node "${FAKE}" "${dir}" ::1 0` }, dependencies: { nuxt: '4' } }));
  const target = await findTarget(options(root, { start: true }));
  try {
    const port = readLock({ dir }).port;
    assert.notEqual(port, 3000);
    assert.deepEqual([target.url, target.proof, target.started], [`http://localhost:${port}`, 'nuxt-lock', true]);
  } finally {
    target.children.stop();
  }
});

test('an interrupted invocation ends every process --start launched (SIGINT 130, SIGTERM 143)', posix, async () => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const root = gitRepo();
    const port = await freePort();
    const out = path.join(root, 'tree.json');
    const script = `
      const { onInterrupt } = await import(${JSON.stringify(new URL('../dist/interrupt.mjs', import.meta.url).href)});
      const { startCommands } = await import(${JSON.stringify(new URL('../dist/start.mjs', import.meta.url).href)});
      onInterrupt(() => {});
      await startCommands({ commands: [${JSON.stringify(`node "${TREE}" "${out}" ${port}`)}], cwd: ${JSON.stringify(root)}, timeoutMs: 10000,
        ready: async () => (await import('node:fs')).existsSync(${JSON.stringify(out)}), describe: 'x', secrets: [] });
      console.log('ready');
      setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve) => child.stdout.on('data', (d) => String(d).includes('ready') && resolve()));
    const tree = JSON.parse(readFileSync(out, 'utf8'));
    const exited = new Promise((resolve) => child.on('exit', resolve));
    child.kill(signal);
    assert.equal(await exited, code);
    for (const pid of [tree.pid, tree.grandchild]) await assertGone(pid, signal);
  }
});

test('the running sample app serves its own lock file and counts as proven', async (t) => {
  const dir = path.join(SAMPLE, 'frontend');
  if (!readLock({ dir })?.port) {
    t.skip('the sample app is not running (npm run dev:web in .scratch/chaos-v1/prototypes/sample-app)');
    return;
  }
  const proof = await proveLock({ dir, rel: 'frontend/' });
  assert.ok(proof, 'not proven');
  assert.equal(proof.url, `http://localhost:${proof.lock.port}`);
});
