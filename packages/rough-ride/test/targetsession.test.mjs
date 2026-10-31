import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chooseBrowser, installedOnThisMachine, launchBrowser } from '../dist/browser.mjs';
import { makeStop, StopError } from '../dist/exit.mjs';
import { checkCommittedFiles } from '../dist/files.mjs';
import { checkRootEntry, ensureFolder } from '../dist/folder.mjs';
import { lockPath } from '../dist/lock.mjs';
import { runnerInfo } from '../dist/runner.mjs';
import { openTargetSession } from '../dist/targetsession.mjs';
import { gitRepo, scratchDir, sh } from './helpers.mjs';

// Every visit signs in afresh: a new session cookie, long enough to count as a credential.
let site;
let visits = 0;
before(async () => {
  site = createServer((req, res) => {
    visits++;
    res.setHeader('set-cookie', `sid=session-cookie-${String(visits).padStart(4, '0')}; Path=/`);
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><h1>Signed in</h1>');
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
});
after(() => site?.close());

const SIGN_IN = { name: 'sign-in', signedIn: false, steps: [{ goto: '/' }, { expect: { text: 'Signed in' } }] };
const SIGNED_IN = { name: 'notes', signedIn: true, steps: [] };
const SIGNED_OUT = { name: 'home', signedIn: false, steps: [] };
const cookie = (defaults) => defaults.storageState?.cookies.find((c) => c.name === 'sid')?.value;
// A launch that never starts a browser: for rules that need none.
const noBrowser = async (name) => ({ browser: { close: async () => {} }, name, version: '1', debugPort: null });

function options(over = {}) {
  const root = gitRepo();
  mkdirSync(path.join(root, '.rough-ride'), { recursive: true });
  const url = `http://127.0.0.1:${site.address().port}`;
  writeFileSync(path.join(root, '.rough-ride', 'config.yaml'), `schema: 0.1.0\ntarget:\n  url: ${url}\n`);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'config');
  const folder = ensureFolder(checkRootEntry(root));
  const env = { ...process.env };
  const info = runnerInfo(null, root, env);
  const files = checkCommittedFiles(folder, { info, subcommand: 'quick', argv: ['quick'], env });
  const config = {
    schema: '0.1.0',
    target: { url },
    reset: 'node -e "require(\'fs\').writeFileSync(\'reset-ran\', \'\')"',
    allow: { remoteWrites: ['writes.example'] },
  };
  return {
    root, folder, files, info, argv: ['quick'], env, notes: [], config, flows: [SIGN_IN],
    start: false, againCommand: '/rough-ride:quick', browserFlag: null, elapsed: () => 0,
    run: { create: 'quick' }, reset: true, ...over,
  };
}

test('the session opens the target, the flow lock and the run folder before the browser, runs reset before sign-in, and closes once', async () => {
  const o = options();
  const seen = [];
  o.launch = async () => {
    seen.push({ lock: existsSync(lockPath(o.root)), runs: readdirSync(path.join(o.folder.dir, 'runs')) });
    return launchBrowser(chooseBrowser(process.env.RP_TEST_BROWSER ?? null, null, installedOnThisMachine()), []);
  };
  const session = await openTargetSession(o);
  try {
    assert.deepEqual(seen, [{ lock: true, runs: [session.run.id] }]);
    assert.equal(session.target.url, o.config.target.url);
    // The guard enforces the same host rules every flow run gets.
    assert.equal(session.guard.policy, session.hosts);
    assert.ok(session.hosts.ownHost('https://writes.example/api'));

    await assert.rejects(session.signIn(), /only after reset/);
    assert.equal(existsSync(path.join(o.root, 'reset-ran')), false);
    await session.reset();
    assert.equal(existsSync(path.join(o.root, 'reset-ran')), true);

    const outcome = await session.signIn();
    assert.equal(outcome.passed, true);
    const first = cookie(outcome);
    const defaults = session.defaults(SIGNED_IN);
    assert.equal(cookie(defaults), first);
    assert.equal(defaults.hosts, session.hosts);
    assert.equal(defaults.guard, session.guard);
    assert.equal(defaults.baseURL, session.target.url);
    // No plugin data folder: no Bash deadline.
    assert.equal(defaults.deadline, Infinity);
    assert.ok(defaults.credentials.includes(first));
    assert.equal(session.defaults(SIGNED_OUT).storageState, undefined);

    // Another sign-in run leaves the kept session alone; a refresh replaces it.
    const again = await session.signInAgain();
    assert.notEqual(cookie(again), first);
    assert.equal(cookie(session.defaults(SIGNED_IN)), first);
    assert.equal(await session.refreshSignIn(), true);
    const refreshed = cookie(session.defaults(SIGNED_IN));
    assert.notEqual(refreshed, first);
    assert.deepEqual(session.credentials.filter((c) => c.startsWith('session-cookie-')), [refreshed]);
  } finally {
    await session.close();
  }
  assert.equal(existsSync(lockPath(o.root)), false);
  assert.equal(session.launched.browser.isConnected(), false);
  await session.close();
});

test('a browser that fails to launch releases the flow lock, and the run folder stays', async () => {
  const o = options({ launch: async () => { throw new Error('no browser'); } });
  await assert.rejects(openTargetSession(o), /no browser/);
  assert.equal(existsSync(lockPath(o.root)), false);
  assert.equal(readdirSync(path.join(o.folder.dir, 'runs')).length, 1);
});

test('a stop after the run folder exists names the run; other errors and named stops pass unchanged', async () => {
  const session = await openTargetSession(options({ launch: noBrowser }));
  try {
    const stop = new StopError(makeStop('nothing-running', ['Nothing answers.']), null, ['tail']);
    const named = session.withRun(stop);
    assert.deepEqual(named.run, { id: session.run.id, dir: session.run.dir });
    assert.deepEqual([named.stop, named.tail], [stop.stop, ['tail']]);
    const other = new StopError(makeStop('nothing-running', ['Nothing answers.']), { id: 'x', dir: 'y' });
    assert.equal(session.withRun(other), other);
    const error = new Error('plain');
    assert.equal(session.withRun(error), error);
  } finally {
    await session.close();
  }
});

test('with no run folder and no reset (snapshot), sign-in needs no reset and stops name no run', async () => {
  const o = options({ launch: noBrowser, run: null, reset: false, flows: [] });
  const session = await openTargetSession(o);
  try {
    assert.equal(session.run, null);
    assert.equal(readdirSync(o.folder.dir).includes('runs'), false);
    assert.equal((await session.signIn()).ran, false);
    const stop = new StopError(makeStop('nothing-running', ['Nothing answers.']));
    assert.equal(session.withRun(stop), stop);
  } finally {
    await session.close();
  }
});

test('with a plugin data folder the Bash limits bound every flow run, unless the session has none', async () => {
  const late = { elapsed: () => 501_000, launch: noBrowser };
  for (const [over, limited] of [[{}, true], [{ bashLimits: false }, false]]) {
    const o = options({ ...late, ...over });
    o.info = { ...o.info, pluginData: { path: scratchDir() } };
    const before = Date.now();
    const session = await openTargetSession(o);
    try {
      assert.equal(session.bashBlocks(), limited);
      if (limited) assert.ok(session.bashStop >= before + 49_000 && session.bashStop <= Date.now() + 49_000, String(session.bashStop - before));
      else assert.equal(session.bashStop, Infinity);
      assert.equal(session.defaults(SIGNED_OUT).deadline, session.bashStop);
    } finally {
      await session.close();
    }
  }
});
