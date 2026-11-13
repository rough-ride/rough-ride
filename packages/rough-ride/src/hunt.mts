// /rough-ride:hunt (experimental): the model reads the change, forms
// hypotheses and tests them with probe scripts; the runner keeps the scripts,
// runs them in a loopback-only browser and, at the end, re-runs every claimed
// finding from scratch so only reproducible ones are reported.
//   node dist/hunt.mjs start
//   node dist/hunt.mjs probe --run <id> --name <name>   (script on stdin)
//   node dist/hunt.mjs finish --run <id>                (findings JSON on stdin)
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { chooseBrowser, installedOnThisMachine } from './browser.mjs';
import { answers, nuxtCandidates, proveLock } from './target.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = /^\d{8}-\d{6}-hunt-[a-z0-9]{4}$/;
const PROBE_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const BUDGET_MS = 12 * 60 * 1000;
const START = '--- rough-ride hunt (copy this block unchanged) ---';
const END = '--- end of rough-ride hunt ---';

interface Context {
  runId: string;
  root: string;
  target: string;
  browser: string;
  base: string;
  startedAt: number;
  deadline: number;
}

interface Finding {
  title: string;
  severity?: string;
  probe: string;
  check: string;
  where?: string;
  expected?: string;
  actual?: string;
}

function git(args: string[], cwd: string): string | null {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function fail(message: string): never {
  process.stdout.write(`${START}\nrough-ride hunt | stopped\n${message}\n${END}\n`);
  process.exit(1);
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const runsDir = (root: string) => path.join(root, '.rough-ride', 'runs');

function loadRun(args: string[]): { ctx: Context; dir: string } {
  const root = git(['rev-parse', '--show-toplevel'], process.cwd());
  if (!root) fail('Not inside a git repository.');
  const id = flag(args, '--run');
  if (!id || !RUN_ID.test(id)) fail('Give the run id from `start` with --run.');
  const dir = path.join(runsDir(root), id);
  if (!existsSync(path.join(dir, 'context.json'))) fail(`No hunt run ${id}.`);
  return { ctx: JSON.parse(readFileSync(path.join(dir, 'context.json'), 'utf8')) as Context, dir };
}

const remaining = (ctx: Context) => Math.max(0, Math.round((ctx.deadline - Date.now()) / 1000));

async function findTargetUrl(root: string): Promise<string | null> {
  const configFile = path.join(root, '.rough-ride', 'config.yaml');
  if (existsSync(configFile)) {
    const url = (parse(readFileSync(configFile, 'utf8')) as { target?: { url?: string } } | null)?.target?.url;
    if (url) return url;
  }
  for (const candidate of nuxtCandidates(root)) {
    const proof = await proveLock(candidate);
    if (proof) return proof.url;
  }
  return null;
}

function baseRef(root: string): string {
  for (const ref of ['origin/main', 'main', 'origin/master', 'master']) {
    const mb = git(['merge-base', 'HEAD', ref], root);
    if (mb) return mb;
  }
  return 'HEAD';
}

async function start(): Promise<void> {
  const root = git(['rev-parse', '--show-toplevel'], process.cwd());
  if (!root) fail('Not inside a git repository.');
  const target = await findTargetUrl(root);
  if (!target) fail('No running app found. Start your dev server, or set target.url in .rough-ride/config.yaml.');
  if ((await answers(target)) === null) fail(`Nothing answers at ${target}. Start your dev server first.`);
  const configFile = path.join(root, '.rough-ride', 'config.yaml');
  const configBrowser = existsSync(configFile) ? ((parse(readFileSync(configFile, 'utf8')) as { browser?: 'chrome' | 'msedge' | 'chromium' } | null)?.browser ?? null) : null;
  const browser = chooseBrowser(null, configBrowser, installedOnThisMachine()).name;

  const runId = `${stamp()}-hunt-${randomBytes(3).toString('hex').slice(0, 4)}`;
  const dir = path.join(runsDir(root), runId);
  mkdirSync(path.join(dir, 'probes'), { recursive: true });
  const gitignore = path.join(root, '.rough-ride', '.gitignore');
  if (!existsSync(gitignore)) writeFileSync(gitignore, '/.env\n/.env.*\n/runs/\n');

  const base = baseRef(root);
  const changed = (git(['diff', '--name-status', base], root) ?? '').split('\n').filter(Boolean);
  const untracked = (git(['ls-files', '--others', '--exclude-standard'], root) ?? '').split('\n').filter((f) => f && !f.startsWith('.rough-ride/'));
  const specs = existsSync(path.join(root, '.rough-ride', 'specs')) ? readdirSync(path.join(root, '.rough-ride', 'specs')).filter((f) => f.endsWith('.txt')) : [];
  const credentialNames = Object.keys(process.env).filter((k) => /(EMAIL|USER(NAME)?|LOGIN|PASSWORD|PASS)$/.test(k) && !/^(npm_|HOMEBREW|LOGNAME$|USER$)/.test(k));
  const now = Date.now();
  const ctx: Context = { runId, root, target, browser, base, startedAt: now, deadline: now + BUDGET_MS };
  writeFileSync(path.join(dir, 'context.json'), JSON.stringify(ctx, null, 2) + '\n');

  const lines = [
    START,
    `rough-ride hunt | run ${runId}`,
    `target: ${target} | browser: ${browser} | budget: ${BUDGET_MS / 60000} min`,
    `diff base: ${base.slice(0, 12)} (compare with: git diff ${base.slice(0, 12)})`,
    'changed files:',
    ...changed.map((l) => `  ${l}`),
    ...untracked.map((f) => `  A (untracked)\t${f}`),
    `specs: ${specs.length ? specs.map((s) => `.rough-ride/specs/${s}`).join(', ') : 'none'}`,
    `sign-in variables set in the environment (names only): ${credentialNames.length ? credentialNames.join(', ') : 'none'}`,
    END,
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

function runProbe(ctx: Context, dir: string, name: string): Record<string, unknown> {
  const file = path.join(dir, 'probes', `${name}.mjs`);
  const r = spawnSync(process.execPath, [path.join(HERE, 'probe-host.mjs'), dir, file], { encoding: 'utf8', timeout: 130_000, maxBuffer: 32 * 1024 * 1024 });
  const last = (r.stdout ?? '').trim().split('\n').pop() ?? '';
  try {
    return JSON.parse(last) as Record<string, unknown>;
  } catch {
    return { checks: [], notes: [], error: `probe host gave no result (exit ${r.status ?? r.signal}): ${(r.stderr ?? '').slice(-400)}`, final: null };
  }
}

function probe(args: string[]): void {
  const { ctx, dir } = loadRun(args);
  const name = flag(args, '--name');
  if (!name || !PROBE_NAME.test(name)) fail('Give the probe a --name of lowercase letters, digits and dashes.');
  const script = readStdin();
  if (!/export\s+default/.test(script)) fail('The probe script on stdin needs `export default async function (rr) { ... }`.');
  writeFileSync(path.join(dir, 'probes', `${name}.mjs`), script);
  const result = runProbe(ctx, dir, name);
  const out = { probe: name, remainingSeconds: remaining(ctx), ...result };
  process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
}

function finish(args: string[]): void {
  const { ctx, dir } = loadRun(args);
  let input: { findings?: Finding[] };
  try {
    input = JSON.parse(readStdin()) as { findings?: Finding[] };
  } catch (e) {
    fail(`The findings on stdin are not JSON: ${(e as Error).message}`);
  }
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const confirmed: (Finding & { runs: string[] })[] = [];
  const dropped: (Finding & { why: string })[] = [];
  for (const f of findings) {
    if (!f || typeof f.probe !== 'string' || typeof f.check !== 'string' || !existsSync(path.join(dir, 'probes', `${f.probe}.mjs`))) {
      dropped.push({ ...f, why: 'no probe of that name' });
      continue;
    }
    // Two fresh runs; the named expectation must fail in both.
    const runs: string[] = [];
    let ok = true;
    for (let i = 0; i < 2 && ok; i++) {
      const r = runProbe(ctx, dir, f.probe) as { checks?: { name: string; pass: boolean; detail: string }[]; error?: string | null };
      const c = r.checks?.find((x) => x.name === f.check);
      if (!c) { ok = false; dropped.push({ ...f, why: `expectation "${f.check}" not reached${r.error ? `: ${r.error}` : ''}` }); break; }
      if (c.pass) { ok = false; dropped.push({ ...f, why: `expectation "${f.check}" held on re-run ${i + 1}` }); break; }
      runs.push(c.detail);
    }
    if (ok) confirmed.push({ ...f, runs });
  }
  const sev = (s?: string) => (s ?? 'medium').toLowerCase();
  const order = { high: 0, medium: 1, low: 2 } as Record<string, number>;
  confirmed.sort((a, b) => (order[sev(a.severity)] ?? 1) - (order[sev(b.severity)] ?? 1));
  writeFileSync(path.join(dir, 'findings.json'), JSON.stringify({ confirmed, dropped }, null, 2) + '\n');
  const elapsed = Math.round((Date.now() - ctx.startedAt) / 1000);
  const lines = [
    START,
    `rough-ride hunt | ${Math.floor(elapsed / 60)}m${String(elapsed % 60).padStart(2, '0')}s | run ${ctx.runId} | ${confirmed.length} confirmed, ${dropped.length} dropped on re-run`,
    `target: ${ctx.target}`,
    ...(confirmed.length ? ['', 'Findings (each reproduced twice from scratch)'] : ['', 'No finding reproduced.']),
    ...confirmed.flatMap((f, i) => [
      `${i + 1}. ${sev(f.severity).toUpperCase().padEnd(6)} ${f.title}`,
      ...(f.where ? [`   where: ${f.where}`] : []),
      ...(f.expected ? [`   expected: ${f.expected}`] : []),
      `   saw: ${f.runs[0] ?? f.actual ?? ''}`,
      `   repro: .rough-ride/runs/${ctx.runId}/probes/${f.probe}.mjs (expectation "${f.check}")`,
    ]),
    ...(dropped.length ? ['', 'Dropped (did not reproduce):', ...dropped.map((f) => `- ${f.title ?? '(untitled)'}: ${f.why}`)] : []),
    END,
  ];
  writeFileSync(path.join(dir, 'report.txt'), lines.slice(1, -1).join('\n') + '\n');
  process.stdout.write(lines.join('\n') + '\n');
}

const [sub, ...rest] = process.argv.slice(2);
if (sub === 'start') await start();
else if (sub === 'probe') probe(rest);
else if (sub === 'finish') finish(rest);
else fail('Usage: hunt.mjs start | probe --run <id> --name <name> | finish --run <id>');
