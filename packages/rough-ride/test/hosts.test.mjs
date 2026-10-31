import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostPolicy, isLoopbackHostname, LOOPBACK_ONLY } from '../dist/hosts.mjs';

// Each row: url, then ownHost, forwardable and writeAllowed.
function check(policy, rows) {
  for (const [url, own, forwardable, write] of rows) {
    assert.deepEqual(
      { own: policy.ownHost(url), forwardable: policy.forwardable(url), write: policy.writeAllowed(url) },
      { own, forwardable, write },
      url,
    );
  }
}

test('loopback hosts are the Target\'s under every policy; other hosts only under allow', () => {
  const loopback = [
    ['http://localhost:3000/x', true, true, true],
    ['http://LOCALHOST/x', true, true, true],
    ['http://app.localhost/x', true, true, true],
    ['http://127.0.0.1:8731/api', true, true, true],
    ['http://127.5.5.5/x', true, true, true],
    ['http://[::1]:3000/x', true, true, true],
  ];
  check(LOOPBACK_ONLY, [
    ...loopback,
    ['https://staging.example.com/api', false, false, false],
    ['http://192.168.1.5/x', false, false, false],
  ]);
  check(hostPolicy({ remoteTarget: 'staging.example.com', remoteWrites: ['abcd.supabase.co'] }), [
    ...loopback,
    ['https://staging.example.com/api', true, true, true],
    ['https://STAGING.example.com/api', true, true, true],
    // A remoteWrites host is own and writable, but the runner never contacts it (resolution 4).
    ['https://abcd.supabase.co/rest', true, false, true],
    ['https://evil.supabase.co/rest', false, false, false],
    ['http://192.168.1.5/x', false, false, false],
    // No host: never own, never contacted, and the guard lets it continue.
    ['not a url', false, false, true],
  ]);
  assert.ok(isLoopbackHostname('[::1]'));
  assert.ok(!isLoopbackHostname('localhost.example.com'));
});

test('an allow host matches without IPv6 brackets or letter case, however config.yaml spells it', () => {
  const policy = hostPolicy({ remoteTarget: '2001:db8::5', remoteWrites: ['[2001:db8::6]', 'Writes.Example.com'] });
  check(policy, [
    ['http://[2001:db8::5]:3000/api', true, true, true],
    ['http://[2001:db8::6]/rest', true, false, true],
    ['https://writes.example.com/rest', true, false, true],
    ['http://[2001:db8::7]/rest', false, false, false],
  ]);
  // The report and summary.json keep the spelling config.yaml has.
  assert.equal(policy.remoteTarget, '2001:db8::5');
  assert.deepEqual(policy.remoteWrites, ['[2001:db8::6]', 'Writes.Example.com']);
});
