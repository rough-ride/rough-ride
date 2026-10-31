import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { chooseBrowser, installedOnThisMachine, launchBrowser, makeLauncher } from '../dist/browser.mjs';
import { runFlow } from '../dist/flowrun.mjs';
import { allowedSuffix, LocalhostGuard, writeAllowed } from '../dist/guard.mjs';

// A stand-in remote server: Chrome maps remote.test and allowed.test to it, so
// nothing leaves the machine. It records every request and allows CORS.
function echo() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.headers.host.split(':')[0]} ${req.url}`);
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', '*');
    res.setHeader('access-control-allow-headers', '*');
    res.end('ok');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

let remote;
let api;
let site;
let launched;
let guard;
const policy = { remoteTarget: null, remoteWrites: [] };

before(async () => {
  remote = await echo();
  api = await echo();
  const call = (host, method, path) => `fetch('http://${host}:${remote.port}${path}', { method: '${method}' }).then(() => '${method} ${host} sent', (e) => '${method} ${host} ' + e)`;
  const pages = {
    '/remote': `<p id="out"></p><script>Promise.all([${call('remote.test', 'GET', '/read')}, ${call('remote.test', 'POST', '/write')}, ${call('allowed.test', 'POST', '/allowed')}, ${call('target.test', 'POST', '/target')}])
      .then((r) => { document.getElementById('out').textContent = r.join(' | '); });</script>`,
    '/preflight': `<p id="out"></p><script>fetch('http://localhost:${api.port}/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(() => { document.getElementById('out').textContent = 'preflight done'; });</script>`,
    '/popup': `<p id="out">opened</p><script>window.open('/popup-child');</script>`,
    '/popup-child': `<script>fetch('http://remote.test:${remote.port}/from-popup', { method: 'POST' }).catch(() => {});</script>`,
    '/iframe': `<p id="out">framed</p><iframe src="http://localhost:PORT/frame-child"></iframe>`,
    '/frame-child': `<script>fetch('http://remote.test:${remote.port}/from-iframe', { method: 'POST' }).catch(() => {});</script>`,
    '/worker': `<p id="out">working</p><script>new Worker('/worker.js');</script>`,
    '/broken': `<button onclick="fetch('http://remote.test:${remote.port}/checkout', { method: 'POST' }).then(() => document.body.insertAdjacentHTML('beforeend', '<p>Paid</p>'))">Pay</button>`,
  };
  site = createServer((req, res) => {
    if (req.url === '/worker.js') {
      res.setHeader('content-type', 'text/javascript');
      return res.end(`fetch('http://remote.test:${remote.port}/from-worker', { method: 'POST' }).catch(() => {});`);
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><body>${(pages[req.url] ?? 'nf').replace('PORT', site.address().port)}</body>`);
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  const launcher = makeLauncher(['--host-resolver-rules=MAP remote.test 127.0.0.1, MAP allowed.test 127.0.0.1, MAP target.test 127.0.0.1']);
  launched = await launchBrowser(chooseBrowser(process.env.RP_TEST_BROWSER ?? null, null, installedOnThisMachine()), [], launcher);
  guard = await LocalhostGuard.connect(launched.debugPort, policy);
});

after(async () => {
  guard?.close();
  await launched?.browser.close();
  for (const s of [remote?.server, api?.server, site]) s?.close();
});

const baseURL = () => `http://127.0.0.1:${site.address().port}`;
const go = (steps, extra = {}) =>
  runFlow({ browser: launched.browser, baseURL: baseURL(), flow: { name: 'f', signedIn: false, steps }, env: () => undefined, ready: { kind: 'load' }, guard, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('writes are allowed only to loopback, the remote target and listed remote writes', () => {
  const p = { remoteTarget: 'staging.example.com', remoteWrites: ['abcd.supabase.co'] };
  assert.ok(writeAllowed('http://localhost:3000/x', p));
  assert.ok(writeAllowed('http://[::1]:3000/x', p));
  assert.ok(writeAllowed('https://staging.example.com/api', p));
  assert.ok(writeAllowed('https://abcd.supabase.co/rest', p));
  assert.ok(!writeAllowed('https://evil.supabase.co/rest', p));
  assert.ok(!writeAllowed('http://192.168.1.5/x', p));
  assert.equal(allowedSuffix(p), ' | allowed by config.yaml: remote target staging.example.com, remote writes abcd.supabase.co');
  assert.equal(allowedSuffix({ remoteTarget: null, remoteWrites: [] }), '');
});

test('a remote GET passes, a remote POST fails in the page and never reaches the server, allowed hosts get theirs', async () => {
  Object.assign(policy, { remoteTarget: 'target.test', remoteWrites: ['allowed.test'] });
  remote.seen.length = 0;
  const result = await go([{ goto: '/remote' }, { expect: { text: 'GET remote.test sent | POST remote.test TypeError: Failed to fetch | POST allowed.test sent | POST target.test sent' } }]);
  assert.equal(result.passed, true, JSON.stringify(result.failure));
  assert.deepEqual(remote.seen.sort(), ['GET remote.test /read', 'POST allowed.test /allowed', 'POST target.test /target']);
  assert.deepEqual(result.aborted.map((w) => `${w.method} ${w.host} ${w.path} ${w.count}`), ['POST remote.test /write 1']);
  Object.assign(policy, { remoteTarget: null, remoteWrites: [] });
});

test('with the guard on, a CORS preflight to the loopback API reaches the API server', async () => {
  api.seen.length = 0;
  const result = await go([{ goto: '/preflight' }, { expect: { text: 'preflight done' } }]);
  assert.equal(result.passed, true);
  assert.deepEqual(api.seen, ['OPTIONS localhost /api/login', 'POST localhost /api/login']);
});

test('a popup, a cross-origin iframe and a worker are guarded from their first request', async () => {
  remote.seen.length = 0;
  for (const [path, text] of [['/popup', 'opened'], ['/iframe', 'framed'], ['/worker', 'working']]) {
    const result = await go([{ goto: path }, { expect: { text } }]);
    assert.equal(result.passed, true, path);
  }
  await sleep(500);
  assert.deepEqual(remote.seen, []);
  const paths = [...guard.aborted.values()].map((w) => w.path);
  for (const p of ['/from-popup', '/from-iframe', '/from-worker']) assert.ok(paths.includes(p), `${p} not aborted: ${paths}`);
});

test('a popup resumed by another connection before the guard attaches is still guarded, and its abort keeps its context', async () => {
  // Playwright's own connection resumes popups; on a slow machine that beats
  // the guard's per-target Fetch.enable (seen on GitHub's Windows runner).
  const attach = guard.attach;
  guard.attach = async function (params) {
    await sleep(400);
    return attach.call(this, params);
  };
  try {
    remote.seen.length = 0;
    guard.aborted.delete('POST remote.test /from-popup');
    const result = await go([{ goto: '/popup' }, { expect: { text: 'opened' } }]);
    assert.equal(result.passed, true);
    await sleep(800);
    assert.deepEqual(remote.seen, []);
    const write = guard.aborted.get('POST remote.test /from-popup');
    assert.ok(write, 'the popup write was aborted');
    // Tied to the popup's browser context, so abortedIn() finds it for its run.
    assert.equal(write.contexts.size, 1);
  } finally {
    guard.attach = attach;
  }
});

test('a baseline run broken by an abort names the host and the setting that allows it', async () => {
  const result = await go([{ goto: '/broken' }, { click: { role: 'button', name: 'Pay' } }, { expect: { text: 'Paid' } }], { timeouts: { S: 1500 } });
  assert.equal(
    result.failure.message,
    'expect text "Paid": not visible after 1.5 s (rough-ride aborted browser writes to remote.test; to allow them, add it to allow.remoteWrites in .rough-ride/config.yaml)',
  );
});

test('the guard keeps the aborted-writes note and the run record\'s writes', () => {
  const note = guard.note();
  assert.equal(note.id, 'aborted-writes');
  assert.match(note.text, /^Aborted \d+ browser writes to remote\.test: not allowed by allow\.remoteWrites in config\.yaml\.$/);
  const record = guard.writesRecord();
  assert.ok(record.aborted.some((w) => w.host === 'remote.test' && w.method === 'POST' && w.path === '/write'));
  assert.ok(record.perHost['allowed.test'] >= 1);
});
