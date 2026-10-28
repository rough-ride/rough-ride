import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chooseBrowser, installedOnThisMachine, launchBrowser } from '../dist/browser.mjs';
import { parseCommitted } from '../dist/committed.mjs';
import { StopError } from '../dist/exit.mjs';
import { checkRootEntry, ensureFolder } from '../dist/folder.mjs';
import { describeLocator, describeStep, matchesExclude, newUnique, normalisedPath, runFlow } from '../dist/flowrun.mjs';
import { loadSchema } from '../dist/schema.mjs';
import { addSecret, clearSecrets, redactSecrets } from '../dist/secrets.mjs';
import { checkEnv, envReader, parseDotenv, refusedStop, runnableFlows, runReset, signIn } from '../dist/session.mjs';
import { createRunFolder } from '../dist/runs.mjs';
import { writeAtomic } from '../dist/write.mjs';
import { startSite } from './fixtures/test-site.mjs';
import { gitRepo } from './helpers.mjs';

const SAMPLE = 'http://localhost:3731';
const sampleUp = await fetch(`${SAMPLE}/login`).then((r) => r.ok).catch(() => false);
const needsSample = { skip: !sampleUp && 'the sample app is not running (BUGS=none npm run dev in .scratch/chaos-v1/prototypes/sample-app)' };
const DEMO = { DEMO_EMAIL: 'demo@example.com', DEMO_PASSWORD: 'demo-password' };
const env = (name) => DEMO[name];

let browser;
let site;
before(async () => {
  browser = (await launchBrowser(chooseBrowser(process.env.RP_TEST_BROWSER ?? null, null, installedOnThisMachine()), [])).browser;
  site = await startSite({ apiDown: await closedPort() });
});
after(async () => {
  await browser?.close();
  site?.server.close();
});

function closedPort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const flow = (steps, extra = {}) => ({ name: 'f', signedIn: false, steps, ...extra });
const onSite = (steps, options = {}) => runFlow({ browser, baseURL: site.url, flow: flow(steps), env, ready: { kind: 'load' }, ...options });

const SIGN_IN = flow([
  { goto: '/login' },
  { fill: { label: 'Email' }, value: '${env.DEMO_EMAIL}' },
  { fill: { label: 'Password' }, value: '${env.DEMO_PASSWORD}' },
  { click: { role: 'button', name: 'Sign in' } },
  { expect: { role: 'heading', name: 'Notes' } },
], { name: 'sign-in' });

test('locators and steps print in the runner\'s own words', () => {
  assert.equal(describeLocator({ role: 'button', name: 'Save' }), 'button "Save"');
  assert.equal(describeLocator({ role: 'alert' }), 'role "alert"');
  assert.equal(describeStep({ fill: { label: 'Title' }, value: 'x' }), 'fill label "Title"');
  assert.equal(describeStep({ expect: { testId: 'save' } }), 'expect testId "save"');
  assert.equal(describeStep({ goto: '/notes' }), 'goto /notes');
});

test('${unique} is 8 lowercase letters and digits, fresh for every flow run', () => {
  const tokens = Array.from({ length: 50 }, newUnique);
  for (const t of tokens) assert.match(t, /^[a-z0-9]{8}$/);
  assert.equal(new Set(tokens).size, 50);
});

test('exclude patterns match the normalised main-frame path', () => {
  assert.ok(matchesExclude('/admin/**', '/admin'));
  assert.ok(matchesExclude('/admin/**', '/admin/users/4'));
  assert.ok(matchesExclude('/notes/*', '/notes/12'));
  assert.ok(!matchesExclude('/notes/*', '/notes/12/edit'));
  assert.ok(!matchesExclude('/Admin/**', '/admin'));
  assert.equal(normalisedPath('http://x/a%20b?q=1#/notes/3'), '/a b#/notes/3');
});

test('flows validate against flow.schema.json; a flow failing only step 5 is listed and not run', () => {
  const schema = loadSchema('flow.schema.json');
  const check = (text, name = 'x') => ({ ...parseCommitted(text, `.rough-patch/flows/${name}.yaml`, 'flow', schema), shown: `.rough-patch/flows/${name}.yaml` });
  const example = 'schema: 0.1.0\nsignedIn: true\nsteps:\n  - goto: /notes/new\n  - fill: {label: Title}\n    value: "Note ${unique}"\n  - click: {role: button, name: Save}\n  - expect: {text: "Note ${unique}"}\n';
  assert.deepEqual(check(example).step5, []);
  const bad = {
    'no-signed-in': 'schema: 0.1.0\nsteps:\n  - goto: /\n',
    'kind': 'schema: 0.1.0\nsignedIn: false\nsteps:\n  - hover: {label: X}\n',
    'two-kinds': 'schema: 0.1.0\nsignedIn: false\nsteps:\n  - click: {label: X}\n    expect: {label: X}\n',
    'click-value': 'schema: 0.1.0\nsignedIn: false\nsteps:\n  - click: {label: X}\n    value: y\n',
    'two-locators': 'schema: 0.1.0\nsignedIn: false\nsteps:\n  - click: {label: X, text: Y}\n',
    'top-level': 'schema: 0.1.0\nsignedIn: false\nsteps: []\nretries: 2\n',
  };
  const files = Object.entries(bad).map(([name, text]) => check(text, name));
  for (const file of files) assert.ok(file.step5.length > 0, file.shown);
  const { flows, notRun } = runnableFlows([...files, check(example, 'create-note')]);
  assert.deepEqual(flows.map((f) => f.name), ['create-note']);
  assert.deepEqual(notRun.sort(), Object.keys(bad).sort());
});

test('a locator that matches two elements fails its step with the runner\'s message', async () => {
  const result = await onSite([{ goto: '/' }, { click: { role: 'button', name: 'Go' } }], { timeouts: { S: 1500 } });
  assert.deepEqual(result.failure, { step: 2, label: 'click button "Go"', message: 'click button "Go": matches 2 elements' });
});

test('a missing element fails within S with the runner\'s message', async () => {
  const result = await onSite([{ goto: '/' }, { expect: { text: 'Saved' } }], { timeouts: { S: 1000 } });
  assert.equal(result.failure.message, 'expect text "Saved": not visible after 1 s');
});

test('outside Nuxt the ready wait is the load event then 500 ms with no new requests', async () => {
  const result = await onSite([{ goto: '/late' }, { expect: { text: 'Loaded later' } }]);
  assert.equal(result.passed, true);
});

test('target.ready replaces the ready wait', async () => {
  const result = await onSite([{ goto: '/ready' }, { fill: { label: 'Name' }, value: 'x' }], { ready: { kind: 'expression', expression: 'window.appReady === true' }, timeouts: { S: 200 } });
  assert.equal(result.passed, true, JSON.stringify(result.failure));
});

test('service workers get no controller, and a repeated GET reaches the server every time', async () => {
  const sw = await onSite([{ goto: '/sw' }, { expect: { text: 'controller: none' } }]);
  assert.equal(sw.passed, true, JSON.stringify(sw.failure));
  const before = site.hits();
  const twice = await onSite([{ goto: '/twice' }, { expect: { text: 'done' } }]);
  assert.equal(twice.passed, true);
  assert.equal(site.hits() - before, 2);
});

test('navigator.webdriver is true and the page reports the machine\'s own time zone and locale', async () => {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const result = await onSite([{ goto: '/info' }, { expect: { text: `webdriver true | tz ${tz} | lang` } }]);
  assert.equal(result.passed, true, JSON.stringify(result.failure));
});

test('a flow run that navigates under an exclude pattern is stopped', async () => {
  const result = await onSite([{ goto: '/' }, { click: { role: 'link', name: 'Admin' } }, { expect: { text: 'Users' } }], { exclude: ['/admin/**'] });
  assert.deepEqual([result.passed, result.excluded], [false, '/admin/users']);
  assert.equal(result.steps.length, 1);
});

test('dialogs are recorded and dismissed', async () => {
  const result = await onSite([{ goto: '/' }, { click: { role: 'button', name: 'Alert' } }, { expect: { text: 'after alert' } }]);
  assert.equal(result.passed, true);
  assert.deepEqual(result.dialogs, ['alert: hi']);
});

test('with the API down the invocation stops with nothing-at-api', async () => {
  const result = await onSite([{ goto: '/api-down' }, { expect: { text: 'Down' } }]);
  assert.match(result.refused, /^http:\/\/127\.0\.0\.1:\d+$/);
  try {
    refusedStop(result, site.url);
    assert.fail('expected a stop');
  } catch (error) {
    assert.ok(error instanceof StopError);
    assert.deepEqual([error.stop.code, error.stop.lines], ['nothing-at-api', [`Nothing answers at ${result.refused}. Start the API or set target.start.`]]);
  }
});

test('env: the process wins over .rough-patch/.env, and the app\'s own .env is never read', () => {
  const root = gitRepo();
  const folder = ensureFolder(checkRootEntry(root));
  writeFileSync(path.join(root, '.env'), 'ONLY_APP=1234\n');
  writeFileSync(path.join(folder.dir, '.env'), '# demo\nBOTH=from-file\nONLY_FILE="quoted value"\n');
  const read = envReader(folder, { BOTH: 'from-process' });
  assert.equal(read('BOTH'), 'from-process');
  assert.equal(read('ONLY_FILE'), 'quoted value');
  assert.equal(read('ONLY_APP'), undefined);
  assert.deepEqual(parseDotenv('export A=1\nB = two # note\nC=\'x y\'\n'), { A: '1', B: 'two', C: 'x y' });
});

test('a missing variable stops before the sign-in flow, naming both spellings of the .env path', () => {
  const root = gitRepo();
  const folder = ensureFolder(checkRootEntry(root));
  const abs = path.join(folder.dir, '.env').split(path.sep).join('/');
  for (const [extraEnv, fork] of [[{}, false], [{ GITHUB_EVENT_NAME: 'pull_request' }, true]]) {
    try {
      checkEnv(SIGN_IN, envReader(folder, {}), folder, extraEnv);
      assert.fail('expected a stop');
    } catch (error) {
      assert.equal(error.stop.code, 'env-missing');
      assert.equal(error.stop.lines[0], `The sign-in flow uses DEMO_EMAIL and DEMO_PASSWORD, which aren't set. Set them in the environment, or set them in .rough-patch/.env (${abs}).`);
      assert.equal(error.stop.lines.length, fork ? 2 : 1);
      if (fork) assert.equal(error.stop.lines[1], "Pull requests from forks get no secrets, so the sign-in flow can't run here.");
    }
  }
});

test('reset runs only when configured, in the git root, and a failure stops with its tail printed only', async () => {
  const root = gitRepo();
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'db:reset': 'node -e "require(\'fs\').writeFileSync(\'guessed\', \'\')"' } }));
  assert.deepEqual((await runReset(null, root)).ran, false);
  assert.deepEqual((await runReset({ schema: '0.1.0' }, root)).ran, false);
  const sub = path.join(root, 'frontend');
  const ran = await runReset({ schema: '0.1.0', reset: 'node -e "require(\'fs\').writeFileSync(\'reset-cwd\', process.cwd())"' }, root);
  assert.equal(ran.ran, true);
  assert.equal(readFileSync(path.join(root, 'reset-cwd'), 'utf8'), root);
  assert.ok(sub);

  addSecret('hunter2-secret', '${env.DB_PASSWORD}');
  try {
    await runReset({ schema: '0.1.0', reset: 'node -e "for (let i = 0; i < 25; i++) console.log(\'r\' + i); console.error(\'pw hunter2-secret\'); process.exit(2)"' }, root);
    assert.fail('expected a stop');
  } catch (error) {
    assert.ok(error instanceof StopError);
    assert.deepEqual(error.stop.lines, ['reset failed: node -e "for (let i = 0; i < 25; i++) console.log(\'r\' + i); console.error(\'pw hunter2-secret\'); process.exit(2)" exited with code 2.', "(last 20 lines of reset's output: printed only)"]);
    assert.equal(error.tail.length, 21);
    assert.equal(error.tail.at(-1), '  pw ${env.DB_PASSWORD}');
  } finally {
    clearSecrets();
  }
});

test('secrets never reach a run-output file, raw or JSON-escaped', () => {
  clearSecrets();
  addSecret('p@ss"word-1', '${env.DEMO_PASSWORD}');
  addSecret('sess-cookie-value', '<session>');
  addSecret('abc', '${env.SHORT}');
  const folder = ensureFolder(checkRootEntry(gitRepo()));
  const run = createRunFolder(folder, 'quick');
  writeAtomic(folder, ['runs', run.id, 'report.txt'], 'typed p@ss"word-1 with cookie sess-cookie-value and abc');
  writeAtomic(folder, ['runs', run.id, 'record.json'], JSON.stringify({ v: 'p@ss"word-1', c: 'sess-cookie-value' }));
  const report = readFileSync(path.join(run.dir, 'report.txt'), 'utf8');
  const record = readFileSync(path.join(run.dir, 'record.json'), 'utf8');
  assert.equal(report, 'typed ${env.DEMO_PASSWORD} with cookie <session> and abc');
  assert.equal(record, '{"v":"${env.DEMO_PASSWORD}","c":"<session>"}');
  assert.equal(redactSecrets('stdout: p@ss"word-1'), 'stdout: ${env.DEMO_PASSWORD}');
  clearSecrets();
});

test('sample app: sign-in runs once, its session stays in memory and signs in every signedIn flow', needsSample, async () => {
  clearSecrets();
  const root = gitRepo();
  const folder = ensureFolder(checkRootEntry(root));
  writeFileSync(path.join(folder.dir, '.env'), 'DEMO_EMAIL=demo@example.com\nDEMO_PASSWORD=demo-password\n');
  const read = envReader(folder, {});
  const create = flow([{ goto: '/notes/new' }, { fill: { label: 'Title' }, value: 'Note ${unique}' }, { click: { role: 'button', name: 'Save' } }, { expect: { text: 'Note ${unique}' } }], { name: 'create-note', signedIn: true });
  const outcome = await signIn({ browser, baseURL: SAMPLE, flows: [SIGN_IN, create], read, folder, ready: { kind: 'nuxt' } });
  assert.deepEqual([outcome.ran, outcome.passed, outcome.line], [true, true, null]);
  assert.ok(outcome.storageState.cookies.length + outcome.storageState.origins.length > 0);

  // A fill right after goto keeps its value with no wait step; Save's late GET belongs to Save.
  const result = await runFlow({ browser, baseURL: SAMPLE, flow: create, env: read, ready: { kind: 'nuxt' }, storageState: outcome.storageState });
  assert.equal(result.passed, true, JSON.stringify(result.failure));
  const api = result.requests.filter((r) => r.url.includes(':8731/api/notes'));
  assert.deepEqual(api.map((r) => `${r.step} ${r.key}`), ['3 POST /api/notes #1', '3 GET /api/notes #1']);
  assert.ok(!result.requests.some((r) => r.step === 4), 'an expect never owns a request');

  // Nothing written to disk holds the session or a credential.
  const values = [...outcome.storageState.cookies.map((c) => c.value), 'demo-password'].filter((v) => v.length >= 4);
  assert.equal(redactSecrets(values.join(' ')).includes('demo-password'), false);
  clearSecrets();
});

test('sample app: a failing sign-in gives the Sign-in failed line; no sign-in flow runs nothing', needsSample, async () => {
  const folder = ensureFolder(checkRootEntry(gitRepo()));
  const wrong = (name) => ({ DEMO_EMAIL: 'demo@example.com', DEMO_PASSWORD: 'wrong-password' })[name];
  const failing = flow(SIGN_IN.steps, { name: 'sign-in' });
  const outcome = await signIn({ browser, baseURL: SAMPLE, flows: [failing, { ...SIGN_IN, name: 'notes', signedIn: true }], read: wrong, folder, ready: { kind: 'nuxt' } });
  assert.equal(outcome.passed, false);
  assert.equal(outcome.storageState, null);
  assert.equal(outcome.line, 'Sign-in failed at step 5 (expect heading "Notes"): not visible after 10 s. 1 signed-in flows not attacked.');
  const none = await signIn({ browser, baseURL: SAMPLE, flows: [], read: wrong, folder, ready: { kind: 'nuxt' } });
  assert.equal(none.ran, false);
});

test('sample app: screenshots mask the fields filled from ${env...}', needsSample, async () => {
  let masks = 0;
  let differ = false;
  await runFlow({
    browser, baseURL: SAMPLE, ready: { kind: 'nuxt' },
    env: (n) => ({ DEMO_EMAIL: 'demo@example.com', DEMO_PASSWORD: 'nope-nope' })[n],
    flow: flow([...SIGN_IN.steps.slice(0, 3), { expect: { text: 'never there' } }]),
    timeouts: { S: 500 },
    onFailure: async (page, locators) => {
      masks = locators.length;
      const plain = await page.screenshot();
      const masked = await page.screenshot({ mask: locators });
      differ = !plain.equals(masked);
    },
  });
  assert.equal(masks, 2);
  assert.ok(differ);
});
