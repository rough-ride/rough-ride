import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';


const MODULE = new URL('../dist/interrupt.mjs', import.meta.url).href;
const posix = { skip: process.platform === 'win32' && 'Windows has no catchable SIGTERM and kills with exit 1' };

// Starts a child whose interrupt handler takes `handlerMs`, waits until it is
// ready, sends `signals` `gapMs` apart, and resolves with its exit code and output.
function interrupted(signals, handlerMs, gapMs = 100) {
  const script = `
    const { onInterrupt } = await import(${JSON.stringify(MODULE)});
    onInterrupt(async (s) => { console.log('handled ' + s); await new Promise((r) => setTimeout(r, ${handlerMs})); });
    setInterval(() => {}, 1000);
    console.log('ready');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  const started = Date.now();
  return new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('ready') && !child.sent) {
        child.sent = true;
        signals.forEach((s, i) => setTimeout(() => child.kill(s), i * gapMs));
      }
    });
    child.on('exit', (code) => resolve({ code, out, ms: Date.now() - started }));
  });
}

test('SIGINT runs the handler and exits 130', posix, async () => {
  const { code, out } = await interrupted(['SIGINT'], 0);
  assert.equal(code, 130);
  assert.match(out, /handled SIGINT/);
});

test('SIGTERM runs the handler and exits 143', posix, async () => {
  const { code, out } = await interrupted(['SIGTERM'], 0);
  assert.equal(code, 143);
  assert.match(out, /handled SIGTERM/);
});

test('a second signal more than 1 s later exits at once', posix, async () => {
  const { code, ms } = await interrupted(['SIGINT', 'SIGINT'], 20_000, 1500);
  assert.equal(code, 130);
  assert.ok(ms < 10_000, `took ${ms} ms`);
});

test('two SIGINTs 200 ms apart are one interrupt: the handler runs once and finishes, exit 130', posix, async () => {
  const { code, out, ms } = await interrupted(['SIGINT', 'SIGINT'], 2000, 200);
  assert.equal(code, 130);
  assert.equal(out.match(/handled SIGINT/g).length, 1);
  assert.ok(ms >= 2000, `exited after ${ms} ms, before the handler finished`);
});

test('a SIGTERM right after a SIGINT still exits at once', posix, async () => {
  const { code, ms } = await interrupted(['SIGINT', 'SIGTERM'], 20_000, 200);
  assert.equal(code, 143);
  assert.ok(ms < 10_000, `took ${ms} ms`);
});

