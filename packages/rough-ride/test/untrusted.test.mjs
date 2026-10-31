import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { chooseBrowser, installedOnThisMachine, launchBrowser } from '../dist/browser.mjs';
import { runFlow } from '../dist/flowrun.mjs';
import { LOOPBACK_ONLY } from '../dist/hosts.mjs';
import { startUntrustedSite } from './fixtures/untrusted-site.mjs';

let browser;
let site;
before(async () => {
  browser = (await launchBrowser(chooseBrowser(process.env.RP_TEST_BROWSER ?? null, null, installedOnThisMachine()), [])).browser;
  site = await startUntrustedSite();
});
after(async () => {
  await browser?.close();
  site?.close();
});
beforeEach(() => {
  for (const key of Object.keys(site.hits)) delete site.hits[key];
});

const run = (steps, untrusted) =>
  runFlow({ browser, baseURL: site.url, flow: { name: 'f', signedIn: false, steps }, env: () => undefined, ready: { kind: 'load' }, hosts: LOOPBACK_ONLY, untrusted });

const DELETE_42 = [{ goto: '/' }, { click: { role: 'button', name: 'Delete 42' } }, { expect: { text: 'Deleted 42' } }];
const OWN = [{ goto: '/' }, { click: { role: 'button', name: 'Create and delete' } }, { expect: { text: 'Deleted abc123' } }];
const ELSEWHERE = [{ goto: '/' }, { click: { role: 'link', name: 'Elsewhere' } }];

test('an untrusted run aborts a DELETE of a record the flow did not create, and fails at that step', async () => {
  const result = await run(DELETE_42, true);
  assert.equal(result.untrustedStop, 'step 2 sends DELETE /api/items/{} to a record this flow did not create');
  assert.equal(result.passed, false);
  assert.equal(result.failure?.step, 2);
  assert.match(result.failure.message, /to a record this flow did not create/);
  assert.equal(site.hits['DELETE /api/items/42'], undefined);
});

test('an untrusted run lets a flow delete the record it created', async () => {
  const result = await run(OWN, true);
  assert.equal(result.untrustedStop, null);
  assert.equal(result.passed, true, JSON.stringify(result.failure));
  assert.equal(site.hits['POST /api/items'], 1);
  assert.equal(site.hits['DELETE /api/items/abc123'], 1);
});

test('an untrusted run aborts a main-frame navigation to another site', async () => {
  const result = await run(ELSEWHERE, true);
  assert.equal(result.untrustedStop, 'step 2 opens another site: example.invalid');
  assert.equal(result.passed, false);
  assert.equal(result.failure?.step, 2);
  const foreign = result.requests.filter((r) => r.url.startsWith('http://example.invalid'));
  assert.equal(foreign.length, 1);
  assert.match(foreign[0].failure ?? '', /ERR_BLOCKED_BY_CLIENT/);
});

test('with untrusted off the same flows run as before', async () => {
  const deleted = await run(DELETE_42, false);
  assert.equal(deleted.untrustedStop, null);
  assert.equal(deleted.passed, true, JSON.stringify(deleted.failure));
  assert.equal(site.hits['DELETE /api/items/42'], 1);
  const own = await run(OWN, undefined);
  assert.equal(own.untrustedStop, null);
  assert.equal(own.passed, true);
  const elsewhere = await run(ELSEWHERE, false);
  assert.equal(elsewhere.untrustedStop, null);
  assert.equal(elsewhere.failure, null);
});
