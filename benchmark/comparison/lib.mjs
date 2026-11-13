// Shared pieces of the comparison benchmark: variants, arms, the app's
// lifecycle, seeding, the claude call and transcript accounting.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
// BENCH_RESULTS keeps a later experiment's runs apart from the first comparison.
export const RESULTS = process.env.BENCH_RESULTS ? path.resolve(process.env.BENCH_RESULTS) : path.join(HERE, 'results');
export const MODEL = 'claude-opus-5-5';
export const MINUTES = 30; // stated to every arm
export const HARD_LIMIT_MS = 45 * 60 * 1000; // every arm is killed after this
export const PLAYWRIGHT_MCP = '0.0.83';
export const DEMO = { DEMO_EMAIL: 'demo@example.com', DEMO_PASSWORD: 'demo-password' };

export const FEATURES = ['harvest-stats', 'plant-journal', 'watering-log'];
export const BUGS = {
  'harvest-stats': ['error-shown-as-empty', 'to-date-excluded'],
  'plant-journal': ['search-quote-crash', 'failed-save-clears-text'],
  'watering-log': ['water-now-twice', 'negative-litres'],
};
// BENCH_SET=heldout uses the sealed held-out bugs (ids hx1..hx6) instead.
const FEATURES_DIR = path.join(REPO, 'benchmark/apps/garden-log/features');
export const HELDOUT = Object.fromEntries(FEATURES.map((f) => [f, existsSync(path.join(FEATURES_DIR, f, 'bugs')) ? readdirSync(path.join(FEATURES_DIR, f, 'bugs')).filter((b) => /^hx\d+$/.test(b)).sort() : []]));
export const SET = process.env.BENCH_SET === 'heldout' ? HELDOUT : BUGS;
export const VARIANTS = FEATURES.flatMap((f) => [...SET[f], 'clean'].map((bug) => ({ feature: f, bug })));
export const ALL_ARMS = ['baseline', 'playwright', 'rough-ride', 'hunt'];
// BENCH_ARMS picks which arms a schedule and its analysis cover.
export const ARMS = process.env.BENCH_ARMS ? process.env.BENCH_ARMS.split(',') : ['baseline', 'playwright', 'rough-ride'];

export const lanePorts = (lane) => ({ web: 3790 + lane, api: 8790 + lane });
export const trialId = (v, arm, n) => `${v.feature}__${v.bug}__${arm}__t${n}`;

// Committed result files name temporary folders as $TMPDIR/... and the home
// folder as ~, never this machine's absolute paths.
export function scrubPaths(text) {
  return String(text)
    .replace(/(?:\/private)?\/var\/folders\/[^/"\s]+\/[^/"\s]+\/T\/+/g, '$TMPDIR/')
    .split(homedir()).join('~');
}

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return r;
}

export function materializeVariant(v, lane, workDir) {
  mkdirSync(workDir, { recursive: true });
  const { web, api } = lanePorts(lane);
  const args = ['benchmark/bench/cli.mts', 'materialize', 'garden-log', v.feature];
  if (v.bug !== 'clean') args.push(v.bug);
  args.push('--work-dir', workDir, '--ports', `${web},${api}`);
  const r = sh('node', args, { cwd: REPO });
  return r.stdout.trim().split('\n').pop();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.status < 500) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

// Starts `npm run dev` in its own process group; returns a stop function.
export async function startApp(dir, lane, logFile) {
  const { web, api } = lanePorts(lane);
  sh('npm', ['run', 'reset'], { cwd: dir });
  const out = [];
  const child = spawn('npm', ['run', 'dev'], { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => out.push(d));
  child.stderr.on('data', (d) => out.push(d));
  const stop = async () => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await sleep(1500);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    writeFileSync(logFile, Buffer.concat(out));
  };
  const ok = (await waitFor(`http://127.0.0.1:${api}/api/auth/me`, 120000)) && (await waitFor(`http://localhost:${web}/login`, 240000));
  if (!ok) { await stop(); throw new Error(`app did not start on lane ${lane}; see ${logFile}`); }
  // Nuxt dev compiles each page on first visit; warm them so no arm pays for it.
  for (const p of ['/login', '/', '/plants', '/beds', '/stats', '/journal', '/waterings', '/harvests/new', '/tasks']) {
    await fetch(`http://localhost:${web}${p}`, { signal: AbortSignal.timeout(120000) }).catch(() => {});
  }
  return stop;
}

// The same sample data for every arm of a feature.
export async function seed(lane, feature) {
  const { api } = lanePorts(lane);
  const base = `http://127.0.0.1:${api}/api`;
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: DEMO.DEMO_EMAIL, password: DEMO.DEMO_PASSWORD }),
  });
  if (!login.ok) throw new Error(`seed login failed: ${login.status}`);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = async (p, body) => {
    const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`seed POST ${p} failed: ${res.status} ${await res.text()}`);
    return res.json();
  };
  const north = await post('/beds', { name: 'North bed', sunlight: 'full_sun', notes: '' });
  const shade = await post('/beds', { name: 'Shade corner', sunlight: 'shade', notes: '' });
  const tomato = await post('/plants', { name: 'Tomato', variety: 'Sungold', bed_id: north.id, planted_on: '2026-04-10' });
  const courgette = await post('/plants', { name: 'Courgette', variety: '', bed_id: north.id, planted_on: '2026-05-02' });
  const lettuce = await post('/plants', { name: 'Lettuce', variety: 'Little Gem', bed_id: shade.id, planted_on: '2026-03-20' });
  for (const [plant, grams, on] of [
    [tomato, 300, '2025-08-10'], [tomato, 450, '2026-07-15'], [tomato, 600, '2026-08-03'],
    [courgette, 1200, '2026-07-20'], [lettuce, 200, '2026-06-05'], [lettuce, 150, '2026-09-30'],
  ]) await post('/harvests', { plant_id: plant.id, weight_grams: grams, harvested_on: on });
  if (feature === 'plant-journal') {
    await post('/journal', { plant_id: tomato.id, entry_on: '2026-06-01', body: 'First flowers opened; watered deeply.' });
    await post('/journal', { plant_id: tomato.id, entry_on: '2026-07-02', body: 'Tied the stems to canes.' });
    await post('/journal', { plant_id: lettuce.id, entry_on: '2026-05-14', body: 'Thinned the seedlings.' });
  }
  if (feature === 'watering-log') {
    await post('/waterings', { bed_id: north.id, watered_on: '2026-11-01', litres: 10 });
    await post('/waterings', { bed_id: shade.id, watered_on: '2026-11-05', litres: 4 });
  }
}

export function checklist() {
  const text = readFileSync(path.join(REPO, 'packages/rough-ride/templates/resilience-contract.md'), 'utf8');
  return text.split('\n').filter((l) => /^\d+\. /.test(l)).join('\n');
}

export function prompt(arm, vars) {
  if (arm === 'rough-ride') return readFileSync(path.join(HERE, 'prompts/rough-ride.md'), 'utf8').trim();
  if (arm === 'hunt') return '/rough-ride:hunt';
  const tools = readFileSync(path.join(HERE, `prompts/tools-${arm}.md`), 'utf8').trim();
  let text = readFileSync(path.join(HERE, 'prompts/common.md'), 'utf8');
  for (const [k, v] of Object.entries({ ...vars, TOOLS: tools, CHECKLIST: checklist(), MINUTES: String(MINUTES) })) text = text.replaceAll(`{{${k}}}`, v);
  if (/\{\{/.test(text)) throw new Error('unfilled prompt variable');
  return text.trim();
}

export function mcpConfig(file, outDir) {
  const cli = path.join(process.env.PW_MCP_DIR, 'node_modules/@playwright/mcp/cli.js');
  writeFileSync(file, JSON.stringify({ mcpServers: { playwright: {
    command: 'node',
    args: [cli, '--headless', '--isolated', '--browser', 'chrome', '--caps', 'network,storage', '--output-dir', outDir],
  } } }, null, 2));
}

// Runs one headless claude session; resolves with timing and exit details.
export function runClaude({ cwd, arm, text, sessionId, outDir, mcpFile }) {
  const args = ['-p', text, '--model', MODEL, '--setting-sources', 'project', '--strict-mcp-config',
    '--permission-mode', 'bypassPermissions', '--output-format', 'json', '--session-id', sessionId, '--add-dir', outDir];
  if (arm === 'playwright') args.push('--mcp-config', mcpFile);
  if (arm === 'rough-ride' || arm === 'hunt') args.push('--plugin-dir', path.join(REPO, 'packages/rough-ride'));
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('claude', args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...DEMO } });
    const out = []; const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, HARD_LIMIT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, killed, ms: Date.now() - started, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() });
    });
  });
}

export function projectDirFor(cwd) {
  return path.join(homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

// Copies the session transcript and its subagents' transcripts.
export function copyTranscripts(cwd, sessionId, dest) {
  const src = projectDirFor(cwd);
  mkdirSync(dest, { recursive: true });
  const files = [];
  if (existsSync(path.join(src, `${sessionId}.jsonl`))) { cpSync(path.join(src, `${sessionId}.jsonl`), path.join(dest, 'main.jsonl')); files.push('main.jsonl'); }
  const sub = path.join(src, sessionId, 'subagents');
  if (existsSync(sub)) for (const f of readdirSync(sub)) { cpSync(path.join(sub, f), path.join(dest, f)); files.push(f); }
  return files;
}

// Token totals over every transcript, one count per API request.
export function transcriptUsage(dir) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, toolCalls: {} };
  if (!existsSync(dir)) return totals;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    // Each content block of a response is its own line; the last one of a
    // request carries its final usage.
    const byRequest = new Map();
    for (const line of readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== 'assistant' || !o.message) continue;
      for (const c of o.message.content ?? []) if (c.type === 'tool_use') totals.toolCalls[c.name] = (totals.toolCalls[c.name] ?? 0) + 1;
      if (o.message.usage) byRequest.set(o.requestId ?? o.message.id, o.message.usage);
    }
    for (const u of byRequest.values()) {
      totals.input += u.input_tokens ?? 0; totals.output += u.output_tokens ?? 0;
      totals.cacheRead += u.cache_read_input_tokens ?? 0; totals.cacheWrite += u.cache_creation_input_tokens ?? 0;
      totals.requests += 1;
    }
  }
  return totals;
}

export const newSessionId = () => randomUUID();
