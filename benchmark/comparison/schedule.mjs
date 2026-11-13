// node benchmark/comparison/schedule.mjs <trials> <lanes>
// Runs every variant x arm x trial (trials numbered from 1) in a fixed
// shuffled order, a few at a time, each on its own lane. Finished trials are
// skipped, so it can be stopped and run again.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ARMS, HERE, RESULTS, trialId, VARIANTS } from './lib.mjs';

// A small seeded generator, so the order is the same on every machine.
function shuffle(items, seed) {
  let s = seed >>> 0;
  const next = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const [trials = '3', lanes = '3'] = process.argv.slice(2);
const jobs = [];
for (let n = 1; n <= Number(trials); n++) for (const v of VARIANTS) for (const arm of ARMS) jobs.push({ v, arm, n });
const order = shuffle(jobs, 20261112);
mkdirSync(RESULTS, { recursive: true });
writeFileSync(path.join(RESULTS, 'schedule.json'), JSON.stringify(order.map((j) => trialId(j.v, j.arm, j.n)), null, 2) + '\n');

const pending = order.filter((j) => !existsSync(path.join(RESULTS, 'trials', trialId(j.v, j.arm, j.n), 'meta.json')));
console.log(`${pending.length} of ${order.length} trials to run on ${lanes} lanes`);

function runOne(job, lane) {
  return new Promise((resolve) => {
    const child = spawn('node', [path.join(HERE, 'trial.mjs'), job.v.feature, job.v.bug, job.arm, String(job.n), String(lane)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      console.log(`[lane ${lane}] ${new Date().toISOString()} ${out.trim().split('\n').slice(-3).join(' / ')} (exit ${code})`);
      resolve();
    });
  });
}

let next = 0;
await Promise.all(Array.from({ length: Number(lanes) }, async (_, lane) => {
  while (next < pending.length) {
    const job = pending[next++];
    await runOne(job, lane);
  }
}));
console.log('schedule done');
