import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
import { after, before, test } from 'node:test';
import { attackPoints, orderAttacks, ownHostFor, runAttack, nonFinding } from '../dist/attacks.mjs';
import { chooseBrowser, installedOnThisMachine, launchBrowser } from '../dist/browser.mjs';
import { emptyForm, FAULT_KINDS, fixedResponse, holdMsFor, kindsFor, malformedBody, sha256 } from '../dist/faults.mjs';
import { runFlow } from '../dist/flowrun.mjs';
import { credentialStrings, hasCredentialHeader } from '../dist/secrets.mjs';
import { startFaultSite } from './fixtures/fault-site.mjs';

let browser;
let site;
before(async () => {
  browser = (await launchBrowser(chooseBrowser(process.env.RP_TEST_BROWSER ?? null, null, installedOnThisMachine()), [])).browser;
  site = await startFaultSite();
});
after(async () => {
  await browser?.close();
  site?.close();
});

const own = ownHostFor([]);
const base = (extra = {}) => ({ browser, baseURL: site.url, env: () => undefined, ready: { kind: 'load' }, allowedHosts: [], ...extra });
const SEND = [{ click: { role: 'button', name: 'Send' } }];
const probe = (u, query = '') => ({ name: 'f', signedIn: false, steps: [{ goto: `/probe?u=${encodeURIComponent(u)}${query}` }, ...SEND] });
const shown = (o) => o.run.steps.find((s) => s.index === o.step).observation.after.lines.slice(2).join(' ');
const result = (o, id) => o.checks.find((c) => c.id === id)?.result;

async function attack(flow, fault, { sticky, tier = 'standard', baseOptions = {}, before: beforeAttack, template } = {}) {
  const baseline = await runFlow({ ...base(baseOptions), flow });
  assert.ok(baseline.passed, JSON.stringify(baseline.failure));
  const points = attackPoints(flow, baseline, own, new Set(), null, { tier });
  const point = points.find((p) => p.fault === fault && (sticky === undefined || p.sticky === sticky) && (!template || p.template === template));
  assert.ok(point, `no ${fault} point: ${points.map((p) => p.id).join(', ')} | ${(points.skipped ?? []).join('; ')}`);
  beforeAttack?.();
  const hitsBefore = { ...site.hits };
  const o = await runAttack(point, flow, baseline, base(baseOptions), []);
  const delta = (key) => (site.hits[key] ?? 0) - (hitsBefore[key] ?? 0);
  return { o, baseline, delta, points };
}

test('fixed bytes: every fault body is ASCII, names no tool, and carries only its own headers', () => {
  for (const fault of ['500', '400', '401', '429']) {
    for (const cross of [false, true]) {
      const r = fixedResponse(fault, cross);
      assert.match(r.body, /^[\x20-\x7e]*$/);
      assert.doesNotMatch(JSON.stringify(r), /rough|patch|playwright|chaos/i);
      const expected = { '500': ['content-type'], '400': ['content-type'], '401': ['content-type', 'www-authenticate'], '429': ['content-type', 'retry-after', ...(cross ? ['access-control-expose-headers'] : [])] }[fault];
      assert.deepEqual(Object.keys(r.headers), expected, `${fault} ${cross}`);
    }
  }
  assert.equal(fixedResponse('500', false).body, 'Internal Server Error');
  assert.equal(fixedResponse('400', false).body, '{"detail":"Bad Request","message":"Bad Request","error":"Bad Request"}');
  assert.equal(fixedResponse('401', false).body, '{"detail":"Not authenticated","message":"Not authenticated","error":"Not authenticated"}');
  assert.equal(fixedResponse('429', false).headers['retry-after'], '1');
  assert.equal(malformedBody('  [{"id":7}]'), '[{"id":1,"name":"Unterminated');
  assert.equal(malformedBody('{"id":7}').length, 28);
  assert.equal(holdMsFor(10_000), 12_000);
});

test('section 20.14: the empty-200 rows', () => {
  assert.deepEqual(emptyForm([{ id: 7, title: 'a' }], 'GET /api/notes', null, null), { kind: '[]', body: '[]' });
  assert.deepEqual(emptyForm({ items: [{ id: 7 }], total: 1 }, 'GET /api/notes', null, null), { kind: 'arrays-emptied', body: '{"items":[],"total":1}' });
  assert.equal(emptyForm({ id: 7, tags: [{ id: 1 }] }, 'GET /api/notes/{id}', { type: 'object' }, null), null);
  assert.deepEqual(emptyForm({ id: 7, tags: [{ id: 1 }] }, 'GET /api/notes/{id}', { type: 'object', nullable: true }, null), { kind: 'null', body: 'null' });
  // Schema minItems and tuples keep their arrays; nested arrays are never descended.
  assert.equal(emptyForm([{ id: 1 }], 'GET /api/x', { type: 'array', minItems: 1 }, null), null);
  const doc = { origin: '', url: '', doc: { openapi: '3.1.0', components: { schemas: { Page: { type: 'object', properties: { items: { type: 'array', minItems: 1 }, more: { type: 'array' } } }, N: { anyOf: [{ type: 'object' }, { type: 'null' }] } } } } };
  assert.deepEqual(emptyForm({ items: [{ id: 1 }], more: [{ id: 2 }], deep: [[{ id: 3 }]] }, 'GET /api/x', { $ref: '#/components/schemas/Page' }, doc), { kind: 'arrays-emptied', body: '{"items":[{"id":1}],"more":[],"deep":[[{"id":3}]]}' });
  assert.deepEqual(emptyForm({ id: 1 }, 'GET /api/x/{id}', { $ref: '#/components/schemas/N' }, doc), { kind: 'null', body: 'null' });
  assert.equal(emptyForm({ id: 1, tags: [{ id: 1 }] }, 'GET /api/x/{}.json', null, null), null, 'a {}.<ext> segment is not literal');
});

test('fault kinds: section 20.12 exactly; quick runs band 1 only', () => {
  assert.deepEqual(FAULT_KINDS.map((k) => `${k.band}/${k.rank} ${k.sticky ? 'sticky' : 'one-shot'} ${k.fault} ${k.appliesTo}`), [
    '1/1 sticky 500 writes', '1/4 sticky 500 reads', '1/5 sticky empty-200 empty-form-gets', '1/6 sticky reset writes',
    '2/9 sticky 400 every', '2/10 sticky reset reads', '2/12 sticky 401 credentialed', '2/13 sticky 429 every',
    '3/16 sticky malformed-json json-gets', '3/17 one-shot 500 reads', '3/18 one-shot delay-3s every', '3/20 sticky hang every',
  ]);
  assert.deepEqual(kindsFor('quick').map((k) => k.rank), [1, 4, 5, 6]);
  assert.equal(kindsFor('standard').length, 12);
});

test('attack points: quick and standard kinds, ids, skip reasons for body faults and 401', () => {
  const rec = (over) => ({ step: 2, method: 'GET', url: `${site.url}/api/list`, key: 'GET /api/list #1', resourceType: 'fetch', offsetMs: 0, navigation: false, status: 200, failure: null, mediaType: 'application/json', emptyBody: false, streaming: false, jsonRoot: 'array', credentialed: false, postData: null, oversize: false, servedByFault: false, body: [{ id: 7 }], ...over });
  const run = { requests: [
    rec({}),
    rec({ method: 'POST', key: 'POST /api/list #1', url: `${site.url}/api/list`, body: undefined }),
    rec({ key: 'GET /api/text #1', url: `${site.url}/api/text`, mediaType: 'text/plain', body: undefined }),
    rec({ key: 'GET /api/blank #1', url: `${site.url}/api/blank`, emptyBody: true, body: undefined }),
    rec({ key: 'GET /api/stream #1', url: `${site.url}/api/stream`, streaming: true }),
    rec({ key: 'GET /api/big #1', url: `${site.url}/api/big`, oversize: true, body: undefined }),
    rec({ key: 'GET /api/remote #1', url: 'https://writes.example/api/remote' }),
  ] };
  const flow = { name: 'f', signedIn: true, steps: [{ goto: '/' }, { click: { text: 'x' } }] };
  const ownAll = ownHostFor(['writes.example']);
  const quick = attackPoints(flow, run, ownAll, new Set(), null, { tier: 'quick' });
  assert.deepEqual(quick.filter((p) => p.key === 'GET /api/list #1').map((p) => p.id), ['f/GET /api/list #1/500!', 'f/GET /api/list #1/empty-200!']);
  assert.deepEqual(quick.filter((p) => p.key === 'POST /api/list #1').map((p) => p.id), ['f/POST /api/list #1/500!', 'f/POST /api/list #1/reset!']);
  assert.ok(!quick.some((p) => ['hang', '400', '401', '429', 'malformed-json', 'delay-3s'].includes(p.fault) || !p.sticky || (p.fault === 'reset' && p.key.startsWith('GET'))));
  for (const line of [
    'Skipped: empty-200 on POST /api/list #1 (not a GET)',
    'Skipped: empty-200 on GET /api/text #1 (response was 200 text/plain)',
    'Skipped: empty-200 on GET /api/blank #1 (empty body)',
    'Skipped: empty-200 on GET /api/stream #1 (still streaming)',
    'Skipped: empty-200 on GET /api/big #1 (body over 5 MiB)',
    'Skipped: empty-200 on GET /api/remote #1 (the runner forwards only to loopback and allow.remoteTarget)',
  ]) assert.ok(quick.skipped.includes(line), line);
  const standard = attackPoints(flow, run, ownAll, new Set(), null, { tier: 'standard' });
  assert.deepEqual(orderAttacks(standard.filter((p) => p.key === 'GET /api/list #1')).map((p) => p.id), [
    'f/GET /api/list #1/500!', 'f/GET /api/list #1/empty-200!', 'f/GET /api/list #1/400!', 'f/GET /api/list #1/reset!', 'f/GET /api/list #1/429!',
    'f/GET /api/list #1/malformed-json!', 'f/GET /api/list #1/500', 'f/GET /api/list #1/delay-3s', 'f/GET /api/list #1/hang!',
  ]);
  assert.ok(standard.skipped.includes('Skipped: 401 on GET /api/list #1 (not credentialed)'));
  const credentialed = { requests: [rec({ credentialed: true })] };
  assert.ok(attackPoints(flow, credentialed, own, new Set(), null, { tier: 'standard' }).some((p) => p.id === 'f/GET /api/list #1/401!'));
  const signIn = attackPoints({ ...flow, name: 'sign-in' }, credentialed, own, new Set(), null, { tier: 'standard', signInFlow: true });
  assert.ok(!signIn.some((p) => p.fault === '401'));
  assert.ok(signIn.skipped.includes('Skipped: 401 on GET /api/list #1 (sign-in flow)'));
  assert.deepEqual(attackPoints({ ...flow, name: 'sign-in' }, credentialed, own, new Set(), null, { tier: 'quick', signInFlow: true }).map((p) => p.rank), [4, 5]);
});

test('400, 401 envelope, 429 and 500 send exact bytes same-origin and cross-origin; the server sees no faulted request', async () => {
  for (const fault of ['500', '400', '429']) {
    for (const cross of [false, true]) {
      const flow = probe('/api/list', cross ? '&cross=1' : '');
      const { o, delta } = await attack(flow, fault, { sticky: true });
      const fixed = fixedResponse(fault, cross);
      assert.equal(shown(o), `${fixed.status}|${fixed.headers['content-type']}|${fixed.body}`, `${fault} cross=${cross}`);
      assert.equal(delta(`${cross ? 'cross ' : ''}GET /api/list`), 1, 'only the recovery click reached the server');
      assert.deepEqual(o.served, { status: fixed.status, headers: fixed.headers, body: fixed.body });
    }
  }
});

test('malformed-json and empty-200 forward exactly once and rewrite the body; headers lose content-encoding; set-cookie is redacted in the record', async () => {
  const m = await attack(probe('/api/list'), 'malformed-json');
  assert.equal(shown(m.o), '200|application/json|[{"id":1,"name":"Unterminated');
  assert.equal(m.delta('GET /api/list'), 1);
  assert.equal(m.o.served.headers['set-cookie'], '<redacted>');
  assert.equal(m.o.served.sha256, sha256('[{"id":1,"name":"Unterminated'));
  assert.equal(result(m.o, 'visible-error-message'), 'not-evaluated');
  const obj = await attack(probe('/api/me'), 'malformed-json');
  assert.equal(shown(obj.o), '200|application/json|{"id":1,"name":"Unterminated');
  const gz = await attack(probe('/api/gz'), 'malformed-json');
  assert.ok(!('content-encoding' in gz.o.served.headers) && !('content-length' in gz.o.served.headers));
  assert.equal(gz.o.served.headers['x-real'], 'kept');
  const e = await attack(probe('/api/page'), 'empty-200');
  assert.equal(shown(e.o), '200|application/json|{"items":[],"total":1}');
  assert.equal(e.delta('GET /api/page'), 1);
  assert.equal(e.o.served.bodyKind, 'arrays-emptied');
  const arr = await attack(probe('/api/list', '&cross=1'), 'empty-200');
  assert.equal(shown(arr.o), '200|application/json|[]');
  assert.equal(arr.delta('cross GET /api/list'), 1);
});

test('body faults: a live 302 or an already-empty body reads Not applied; a forwarding error aborts the request', async () => {
  try {
    const r = await attack(probe('/api/list'), 'malformed-json', { before: () => (site.state.list = 'redirect') });
    assert.equal(r.o.verdict, 'not-applied');
    assert.equal(nonFinding(r.o, 12_000).text, 'Not applied: f/GET /api/list #1/malformed-json! (the real response was 302 text/plain)');
    site.state.list = 'normal';
    const empty = await attack(probe('/api/list'), 'empty-200', { before: () => (site.state.list = 'empty') });
    assert.equal(nonFinding(empty.o, 12_000).text, 'Not applied: f/GET /api/list #1/empty-200! (response already empty)');
    assert.equal(shown(empty.o), '200|application/json|[]');
    site.state.list = 'normal';
    const broken = await attack(probe('/api/list'), 'malformed-json', { before: () => (site.state.list = 'destroy') });
    assert.equal(broken.o.verdict, 'not-applied');
    assert.match(broken.o.notApplied, /^forwarding failed: /);
    assert.match(shown(broken.o), /^error TypeError/);
  } finally {
    site.state.list = 'normal';
  }
});

test('reset aborts with a connection reset; one-shot 500 is absorbed by an immediate retry', async () => {
  const r = await attack(probe('/api/list', '&m=POST'), 'reset');
  assert.equal(shown(r.o), 'error TypeError');
  assert.equal(r.delta('POST /api/list'), 1, 'only the recovery click reached the server');
  const one = await attack(probe('/api/list', '&mode=retry'), '500', { sticky: false });
  assert.equal(one.o.id, 'f/GET /api/list #1/500');
  assert.match(shown(one.o), /^200\|application\/json\|\[\{"id":7/);
  assert.equal(one.delta('GET /api/list'), 1, 'the retry reached the server');
  assert.equal(one.o.run.fault.absorbed, true);
  assert.equal(result(one.o, 'visible-error-message'), 'not-evaluated');
  const sticky = await attack(probe('/api/list', '&mode=retry'), '500', { sticky: true });
  assert.equal(sticky.delta('GET /api/list'), 1, 'only the recovery click reached the server');
  assert.equal(sticky.o.events.filter((e) => e.event === 'served 500').length, 2);
});

test('401: cookies cleared, credentialed requests get the 401, others reach the server without cookies', async () => {
  const tok = 'tok-0123456789abcdef';
  const storageState = {
    cookies: [{ name: 'sid', value: 'sid-0123456789abcdef', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
    origins: [{ origin: site.url, localStorage: [{ name: 'tok', value: tok }] }],
  };
  const credentials = credentialStrings(storageState);
  assert.deepEqual(credentials.sort(), ['sid-0123456789abcdef', tok].sort());
  assert.equal(hasCredentialHeader({ 'x-token': `x ${tok}` }, credentials), true);
  assert.equal(hasCredentialHeader({ cookie: `sid=${credentials[0]}` }, credentials), false);
  const flow = { ...probe('/api/me', '&mode=auth'), signedIn: true };
  const { o } = await attack(flow, '401', { baseOptions: { storageState, credentials }, template: 'GET /api/me' });
  const env = fixedResponse('401', false);
  assert.equal(shown(o), `401|application/json|${env.body} || public 200 || 401|application/json|${env.body}`);
  const pub = site.log.filter((l) => l.key === 'GET /api/public').at(-1);
  assert.equal(pub.cookie, null, 'cookies were deleted before the next request');
  assert.equal(o.events.filter((e) => e.event === 'served 401').length, 2);
});

test('hang: Pending at H with two checks judged; a page that gives up gets fast-failed retries', async () => {
  const S = 2000;
  const pending = await attack(probe('/api/list'), 'hang', { baseOptions: { timeouts: { S } } });
  assert.equal(pending.o.verdict, 'pending');
  assert.equal(nonFinding(pending.o, holdMsFor(S)).text, 'Pending: f/GET /api/list #1/hang! (no response for 4 s and the page did not give up)');
  assert.deepEqual(pending.o.checks.map((c) => `${c.id}=${c.result}`), ['no-uncaught-error=pass', 'settles=not-evaluated', 'visible-error-message=not-evaluated', 'values-survive=not-evaluated', 'no-broken-text=pass', 'retry-recovers=not-evaluated']);
  assert.deepEqual(pending.o.events.map((e) => e.event), ['held', 'pending at 4 s', 'aborted after checks']);
  assert.ok(pending.o.events[1].offsetMs >= holdMsFor(S) - 50);
  assert.equal(pending.delta('GET /api/list'), 0);
  const gave = await attack(probe('/api/list', '&mode=abort1s'), 'hang', { baseOptions: { timeouts: { S } } });
  assert.equal(shown(gave.o), 'gave up AbortError then error TypeError');
  assert.deepEqual(gave.o.events.map((e) => e.event), ['held', 'given up by the page', 'fast-failed', 'cleared']);
  assert.match(gave.o.events[1].detail, /ERR_ABORTED/);
  assert.equal(gave.o.verdict, 'passed');
  assert.equal(gave.delta('GET /api/list'), 1, 'only the recovery click reached the server');
});

test('delay-3s: the server gets the unchanged request at least 3,000 ms after the route event; timeouts grow by 3 s', async () => {
  const { o } = await attack(probe('/api/list'), 'delay-3s');
  const received = site.log.filter((l) => l.key === 'GET /api/list').at(-1);
  assert.ok(received.at - o.run.fault.firedAt >= 3000, `${received.at - o.run.fault.firedAt}`);
  assert.match(shown(o), /^200\|application\/json\|\[\{"id":7/);
  assert.deepEqual(o.events.map((e) => e.event), ['released after 3000 ms', 'cleared']);
  assert.equal(result(o, 'visible-error-message'), 'not-evaluated');
  const missing = await runFlow({
    ...base({ timeouts: { S: 1500 } }),
    flow: { name: 'f', signedIn: false, steps: [{ goto: '/probe?u=/api/list' }, { click: { role: 'button', name: 'Nope' } }] },
    attack: { fault: 'delay-3s', sticky: false, template: 'GET /api/list', k: 1, step: 2 },
  });
  assert.match(missing.failure.message, /not found after 4\.5 s/);
});

test('a service worker and a cacheable GET give the same requests and #n in two baselines and the attack', async () => {
  const flow = { name: 'f', signedIn: false, steps: [{ goto: '/sw' }, ...SEND, { expect: { text: 'got' } }] };
  const keys = (r) => r.requests.filter((q) => q.resourceType === 'fetch').map((q) => `${q.step} ${q.key}`);
  const a = await runFlow({ ...base(), flow });
  const b = await runFlow({ ...base(), flow });
  assert.deepEqual(keys(a), keys(b));
  assert.deepEqual(keys(a), ['1 GET /api/cacheable #1', '1 GET /api/cacheable #2', '2 GET /api/cacheable #3']);
  const point = attackPoints(flow, a, own, new Set(), null, { tier: 'quick' }).find((p) => p.key === 'GET /api/cacheable #3' && p.fault === '500');
  const o = await runAttack(point, flow, a, base(), []);
  assert.deepEqual(keys(o.run).slice(0, 3), keys(a), 'the recovery click adds #4 after the window');
});

test('no config field and no CLI flag accepts a payload, duration or sticky value', async () => {
  const { loadSchema, validate } = await import('../dist/schema.mjs');
  const schema = loadSchema('config.schema.json');
  for (const extra of [{ faults: { '500': { body: 'x' } } }, { delayMs: 5000 }, { sticky: false }, { holdMs: 1 }]) {
    assert.ok(validate(schema, { schema: 1, ...extra }).length > 0, JSON.stringify(extra));
  }
  for (const flag of ['--delay=5000', '--sticky', '--payload=x', '--hold=1']) {
    const r = spawnSync(process.execPath, [cli, 'quick', flag], { encoding: 'utf8' });
    assert.equal(r.status, 64, flag);
  }
});
