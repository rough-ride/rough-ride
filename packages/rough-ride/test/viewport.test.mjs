import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { attackLink, findingLines, orderAttacks, runAttack, severityOf, viewportAttack } from '../dist/attacks.mjs';
import { chooseBrowser, installedOnThisMachine, launchBrowser } from '../dist/browser.mjs';
import { runFlow } from '../dist/flowrun.mjs';
import { LOOPBACK_ONLY } from '../dist/hosts.mjs';

let browser;
let server;
let url;
before(async () => {
  browser = (await launchBrowser(chooseBrowser(process.env.RP_TEST_BROWSER ?? null, null, installedOnThisMachine()), [])).browser;
  server = createServer((req, res) => {
    const width = { '/wide2': 'width: 377px', '/wide1': 'width: 376px', '/fixed': 'width: 600px', '/fluid': 'max-width: 600px; width: 100%' }[new URL(req.url, 'http://x').pathname];
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><html><head><style>body { margin: 0 } #box { ${width ?? ''}; height: 20px; background: #ccc }</style></head>
      <body><h1>Page</h1><div id="box"></div><button onclick="document.getElementById('o').textContent = innerWidth + ' ' + navigator.userAgent">Show</button><p id="o"></p></body></html>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await browser?.close();
  server?.close();
});

const base = () => ({ browser, baseURL: url, env: () => undefined, ready: { kind: 'load' }, hosts: LOOPBACK_ONLY });
const flowAt = (path) => ({ name: 'f', signedIn: false, steps: [{ goto: path }, { click: { role: 'button', name: 'Show' } }] });

async function viewportOn(path) {
  const flow = flowAt(path);
  const baseline = await runFlow({ ...base(), flow });
  return { o: await runAttack(viewportAttack(flow, true), flow, baseline, base(), []), baseline };
}

test('the viewport attack runs every step at a plain 375 x 800 with the baseline browser and user agent', async () => {
  const { o, baseline } = await viewportOn('/fluid');
  const shown = (r) => r.steps.at(-1).observation.after.lines.at(-1);
  const [width, ...ua] = shown(o.run).split(' ');
  assert.equal(width, '375');
  assert.equal(ua.join(' '), shown(baseline).split(' ').slice(1).join(' '));
  assert.deepEqual(o.run.steps.map((s) => s.innerWidth), [375, 375]);
  assert.equal(o.verdict, 'passed');
  assert.deepEqual(o.checks.map((c) => c.id), ['no-uncaught-error', 'settles', 'no-broken-text', 'no-overflow-375']);
});

test('no-overflow-375: 2 px fails at LOW, 1 px passes; a fixed-width element fails and a fluid layout passes', async () => {
  const two = (await viewportOn('/wide2')).o;
  assert.equal(two.checks.find((c) => c.id === 'no-overflow-375').result, 'fail');
  assert.equal(severityOf(two), 'low');
  assert.equal(two.step, 1, 'the first step after which overflow was measured');
  assert.equal(two.page, '/wide2');
  assert.deepEqual(findingLines(two), ['LOW   /wide2 scrolls sideways at 375px', '      /wide2 | viewport 375 | fails: no-overflow-375']);
  assert.equal((await viewportOn('/wide1')).o.verdict, 'passed');
  assert.equal((await viewportOn('/fixed')).o.verdict, 'failed');
  assert.equal((await viewportOn('/fluid')).o.verdict, 'passed');
});

test('closeness and accounting: 2 by module or page rule, 3 otherwise; counts files, never endpoints', () => {
  const flow = flowAt('/fluid');
  assert.equal(viewportAttack(flow, true).closeness, 2);
  assert.equal(viewportAttack(flow, false).closeness, 3);
  assert.equal(viewportAttack(flow, false).id, 'f/viewport-375');
  // Ordered by closeness, then rank: rank 7 sits between reset! on writes (6) and 400 (9).
  const fault = (id, rank) => ({ id, rank, closeness: 2, step: 2 });
  assert.deepEqual(orderAttacks([fault('a/400!', 9), viewportAttack(flow, true), fault('a/reset!', 6)]).map((a) => a.id), ['a/reset!', 'f/viewport-375', 'a/400!']);
  const link = attackLink({ ...viewportAttack(flow, true), verdict: 'passed', page: '/fluid', checks: [] }, ['app/pages/fluid.vue']);
  assert.deepEqual([link.kind, link.endpoints], ['viewport', []]);
});
