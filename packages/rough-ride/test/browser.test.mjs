import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bundledChromium, chooseBrowser, installedOnThisMachine, launchBrowser, playwrightCacheDir, playwrightCoreDir } from '../dist/browser.mjs';
import { StopError } from '../dist/exit.mjs';
import { run, scratchDir } from './helpers.mjs';

const only = (...names) => (name) => names.includes(name);

async function stopOf(fn) {
  try {
    return { value: await fn() };
  } catch (error) {
    if (error instanceof StopError) return { stop: error.stop };
    throw error;
  }
}

test('the order is Chrome, then Edge, then the downloaded Playwright Chromium', () => {
  assert.equal(chooseBrowser(null, null, only('chrome', 'msedge', 'chromium')).name, 'chrome');
  assert.equal(chooseBrowser(null, null, only('msedge', 'chromium')).name, 'msedge');
  assert.equal(chooseBrowser(null, null, only('chromium')).name, 'chromium');
  assert.equal(bundledChromium().version, '156.0.8078.4');
});

test('--browser beats browser:, which beats the order', () => {
  assert.deepEqual(chooseBrowser('msedge', 'chrome', only('chrome', 'msedge')), { name: 'msedge', pinnedBy: '--browser' });
  assert.deepEqual(chooseBrowser(null, 'msedge', only('chrome', 'msedge')), { name: 'msedge', pinnedBy: 'config' });
});

test('on Windows a copy of the environment finds Program Files and LocalAppData in any letter case', () => {
  const root = scratchDir();
  mkdirSync(path.join(root, 'Google', 'Chrome', 'Application'), { recursive: true });
  writeFileSync(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), '');
  // { ...process.env } on Windows keeps the system's spelling and compares case.
  assert.equal(installedOnThisMachine({ ProgramFiles: root }, 'win32')('chrome'), true);
  assert.equal(installedOnThisMachine({ 'ProgramFiles(x86)': root }, 'win32')('chrome'), true);
  assert.equal(installedOnThisMachine({ ProgramFiles: root }, 'win32')('msedge'), false);
  assert.equal(playwrightCacheDir({ LocalAppData: root }, 'win32'), path.join(root, 'ms-playwright'));
});

test('with no usable browser the runner stops with the No browser found block and leaves the cache alone', async () => {
  const cache = playwrightCacheDir();
  const before = existsSync(cache) ? readdirSync(cache) : null;
  const { stop } = await stopOf(() => chooseBrowser(null, null, only()));
  assert.deepEqual([stop.kind, stop.code], ['environment', 'no-browser']);
  assert.deepEqual(stop.lines, [
    'No browser found: no Google Chrome, no Microsoft Edge, no Playwright Chromium 156.0.8078.4.',
    `To download Chromium for rough-ride (about 195 to 207 MB) into ${cache}, run:`,
    `  node "${path.join(playwrightCoreDir(), 'cli.js')}" install --no-shell --no-remove chromium`,
    "Behind a proxy, set HTTPS_PROXY (npm's proxy setting does not reach this download) and allow cdn.playwright.dev and storage.googleapis.com. Set PLAYWRIGHT_DOWNLOAD_HOST for a mirror and NODE_EXTRA_CA_CERTS for a TLS-inspecting proxy.",
  ]);
  assert.deepEqual(existsSync(cache) ? readdirSync(cache) : null, before);
});

test('a pinned browser that is not installed is never replaced', async () => {
  let { stop } = await stopOf(() => chooseBrowser(null, 'chrome', only('msedge')));
  assert.deepEqual(stop.lines, [
    "No browser found: browser: chrome in .rough-ride/config.yaml names Google Chrome, which isn't installed. rough-ride doesn't switch browsers on its own: install it, or change browser:.",
  ]);
  ({ stop } = await stopOf(() => chooseBrowser('chrome', null, only('msedge'))));
  assert.match(stop.lines[0], /^No browser found: --browser chrome names Google Chrome, which isn't installed\. .* or change --browser\.$/);
  ({ stop } = await stopOf(() => chooseBrowser(null, 'chromium', only('chrome'))));
  assert.match(stop.lines[0], /names Playwright Chromium 156\.0\.8078\.4, which isn't installed/);
  assert.equal(stop.lines.length, 4);
});

test('--browser firefox is a usage stop', () => {
  const { code } = run(['quick', '--browser', 'firefox']);
  assert.equal(code, 64);
});

test('a launch that hangs past the timeout is a policy stop and no second browser is launched', async () => {
  let calls = 0;
  const { stop } = await stopOf(() => launchBrowser({ name: 'chrome', pinnedBy: null }, [], () => {
    calls++;
    return new Promise(() => {});
  }, 200));
  assert.deepEqual([stop.code, stop.lines], [
    'browser-launch-failed',
    ["Couldn't start Google Chrome with remote debugging. Your organisation's browser policy may turn it off (RemoteDebuggingAllowed). rough-ride doesn't switch browsers on its own; set browser: in .rough-ride/config.yaml only if your organisation allows it."],
  ]);
  assert.equal(calls, 1);
  const failed = await stopOf(() => launchBrowser({ name: 'msedge', pinnedBy: null }, [], async () => { throw new Error('boom'); }, 200));
  assert.match(failed.stop.lines[0], /^Couldn't start Microsoft Edge with remote debugging/);
});

test('a browser newer than Playwright\'s Chromium gets the browser-newer note and is still used', async () => {
  const notes = [];
  const fake = { version: () => '157.0.8100.2', close: async () => {} };
  const { value } = await stopOf(() => launchBrowser({ name: 'chrome', pinnedBy: null }, notes, async () => ({ browser: fake, debugPort: null }), 200));
  assert.equal(value.browser, fake);
  assert.deepEqual(notes, [{
    id: 'browser-newer',
    text: 'Browser newer than Playwright: Chrome 157.0.8100.2 is newer than Chromium 156, which Playwright 1.64.1 was released with. rough-ride still uses it; results may differ until rough-ride updates Playwright.',
  }]);
});

test('this machine launches the first browser in the order', { skip: !installedOnThisMachine()('chrome') && !installedOnThisMachine()('msedge') && 'no Chrome or Edge here' }, async () => {
  const choice = chooseBrowser(process.env.RP_TEST_BROWSER ?? null, null, installedOnThisMachine());
  const launched = await launchBrowser(choice, []);
  try {
    assert.match(launched.version, /^\d+\.\d+\.\d+\.\d+$/);
  } finally {
    await launched.browser.close();
  }
});
