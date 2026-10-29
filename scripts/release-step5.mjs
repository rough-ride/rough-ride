// test-tarball step 5 (spec part 1 section 4; resolution 1): the most the build
// can do against the committed dev-split Nuxt 4 + FastAPI app. Before attacks
// ship, that is the target proof through nuxt.lock and the sign-in flow's
// baseline run.
// Usage: node scripts/release-step5.mjs [<path of the runner's cli.mjs>] [--work-dir <dir>]
import { spawnSync } from 'node:child_process';
import { appendFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP = 'garden-log';
const args = process.argv.slice(2);
const workIndex = args.indexOf('--work-dir');
const workDir = workIndex === -1 ? tmpdir() : args.splice(workIndex, 2)[1];
const cli = path.resolve(args[0] ?? path.join(ROOT, 'packages', 'rough-ride', 'dist', 'cli.mjs'));

// 1. The base, committed as materialize's step 2 does, then installed.
const made = spawnSync(process.execPath, [path.join(ROOT, 'benchmark', 'bench', 'cli.mts'), 'materialize-base', APP, '--work-dir', workDir], {
  cwd: ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
if (made.status !== 0) {
  console.error('step 5: materialize-base failed');
  process.exit(1);
}
const repo = made.stdout.trim().split('\n').at(-1);
console.log(`step 5: app at ${repo}`);

// 2. A throwaway uncommitted change to one page file, so the diff isn't empty.
const pages = path.join(repo, 'frontend', 'app', 'pages');
const page = path.join(pages, readdirSync(pages).find((f) => f.endsWith('.vue')));
appendFileSync(page, '\n<!-- step 5 -->\n');

// 3. quick with --start, signing in with the app's public demo credentials.
const env = { ...process.env, DEMO_EMAIL: 'demo@example.com', DEMO_PASSWORD: 'demo-password' };
const quick = spawnSync(process.execPath, [cli, 'quick', '--start', '--json'], { cwd: repo, env, encoding: 'utf8', timeout: 600_000 });
process.stderr.write(quick.stderr);
let doc;
try {
  doc = JSON.parse(quick.stdout);
} catch {
  console.error(`step 5: quick printed no JSON (exit ${quick.status})\n${quick.stdout}`);
  process.exit(1);
}
const problems = [];
if (doc.status !== 'nothing-attacked' && doc.status !== 'passed' && doc.status !== 'findings') problems.push(`status ${doc.status}: ${(doc.stop?.lines ?? []).join(' / ')}`);
if (doc.target?.proof !== 'nuxt-lock') problems.push(`target proof ${doc.target?.proof}, expected nuxt-lock`);
if (doc.flows?.signIn !== 'passed') problems.push(`sign-in flow ${doc.flows?.signIn}`);
for (const p of problems) console.error(`step 5: ${p}`);
if (problems.length > 0) process.exit(1);
console.log(`step 5: ${doc.summaryLines.slice(0, 4).join('\n        ')}`);
console.log('step 5: target proven through nuxt.lock and the sign-in flow passed');
