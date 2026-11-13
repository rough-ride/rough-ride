// One trial: node benchmark/comparison/trial.mjs <feature> <bug|clean> <arm> <n> <lane>
// Builds a fresh variant on the lane's ports, starts and seeds the app, runs
// one arm headless, then keeps everything the run left behind.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import path from 'node:path';
import {
  ALL_ARMS, copyTranscripts, lanePorts, materializeVariant, mcpConfig, MODEL, newSessionId, prompt, RESULTS,
  runClaude, scrubPaths, seed, sh, startApp, transcriptUsage, trialId, VARIANTS,
} from './lib.mjs';

// Every finding a rough-ride run lists in report.txt, shown or not (capped,
// unchecked, ...), in the shape the other arms report. `tool.state` keeps the
// bracketed state, so a shown-only score can be computed too.
export const roughRideFindings = (repo) => findingsInRuns(path.join(repo, '.rough-ride', 'runs'));

export function findingsInRuns(runs) {
  if (!existsSync(runs)) return [];
  const out = [];
  for (const run of readdirSync(runs).sort()) {
    const reportFile = path.join(runs, run, 'report.txt');
    if (!existsSync(reportFile)) continue;
    const section = readFileSync(reportFile, 'utf8').split('\nFindings\n')[1];
    if (!section) continue;
    for (const block of section.split(/\n(?=\d+\. \[)/)) {
      const head = /^\d+\. \[([\w-]+)\]\n(\S+)\s+(.+?)(?: \| (\d+) attacks)?(?: \| repro (r\d+))?\n\s+(.+)\n/.exec(block);
      if (!head) continue;
      const [, state, severity, title, , repro, summaryLine] = head;
      const detail = block.split('\n').filter((l) => /^\s{4}\S/.test(l) && !/screenshot:/.test(l)).map((l) => l.trim()).slice(0, 8).join(' | ');
      out.push({
        title, where: summaryLine.split(' | ')[0], steps: `In the browser: ${summaryLine}`,
        expected: '', actual: detail || title, evidence: detail, status: 'observed', severity: severity.toLowerCase(),
        tool: { run, state, repro: repro ?? null },
      });
    }
  }
  return out;
}

// /rough-ride:hunt reports only findings that reproduced twice; dropped ones are
// kept apart in its findings.json and not scored.
export function huntFindings(repo) {
  const runs = path.join(repo, '.rough-ride', 'runs');
  if (!existsSync(runs)) return [];
  const out = [];
  for (const run of readdirSync(runs).filter((r) => r.includes('-hunt-')).sort()) {
    const file = path.join(runs, run, 'findings.json');
    if (!existsSync(file)) continue;
    for (const f of JSON.parse(readFileSync(file, 'utf8')).confirmed ?? []) {
      out.push({ title: f.title, where: f.where ?? '', steps: `Probe ${f.probe}, expectation ${f.check}`, expected: f.expected ?? '', actual: f.actual ?? '', evidence: (f.runs ?? []).join(' | '), status: 'observed', severity: f.severity ?? null, tool: { run, probe: f.probe, state: 'confirmed' } });
    }
  }
  return out;
}

async function main([feature, bug, arm, n, laneText]) {
  const v = VARIANTS.find((x) => x.feature === feature && x.bug === bug);
  if (!v || !ALL_ARMS.includes(arm) || !/^\d+$/.test(n) || !/^\d$/.test(laneText)) {
    console.error('usage: trial.mjs <feature> <bug|clean> <arm> <n> <lane>');
    return 64;
  }
  const lane = Number(laneText);
  const id = trialId(v, arm, n);
  const dest = path.join(RESULTS, 'trials', id);
  if (existsSync(path.join(dest, 'meta.json'))) { console.log(`${id}: already done`); return 0; }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const work = path.join(process.env.BENCH_WORK, id);
  const scratch = path.join(work, 'scratch');
  const outDir = path.join(work, 'out');
  mkdirSync(scratch, { recursive: true }); mkdirSync(outDir, { recursive: true });

  const meta = { id, ...v, arm, trial: Number(n), lane, ports: lanePorts(lane), model: MODEL, startedAt: new Date().toISOString() };
  const t0 = Date.now();
  const repo = materializeVariant(v, lane, path.join(work, 'variant'));
  meta.materializeMs = Date.now() - t0;
  meta.repo = repo;
  const stopApp = await startApp(repo, lane, path.join(dest, 'app.log'));
  try {
    await seed(lane, v.feature);
    meta.diffBefore = sh('git', ['status', '--porcelain'], { cwd: repo }).stdout;
    const sessionId = newSessionId();
    const { web, api } = lanePorts(lane);
    const text = prompt(arm, {
      WEB: `http://localhost:${web}`, API: `http://localhost:${api}/api`, SCRATCH: scratch, OUT: path.join(outDir, 'findings.json'),
    });
    writeFileSync(path.join(dest, 'prompt.txt'), scrubPaths(text) + '\n');
    const mcpFile = path.join(work, 'mcp.json');
    if (arm === 'playwright') mcpConfig(mcpFile, path.join(scratch, 'playwright'));
    meta.sessionId = sessionId;
    meta.loadBefore = loadavg();
    const result = await runClaude({ cwd: repo, arm, text, sessionId, outDir, mcpFile });
    meta.loadAfter = loadavg();
    meta.claudeExit = result.code;
    meta.killedAtLimit = result.killed;
    meta.wallMs = result.ms;
    writeFileSync(path.join(dest, 'claude.json'), result.stdout);
    writeFileSync(path.join(dest, 'claude.stderr'), result.stderr);
    try {
      const j = JSON.parse(result.stdout);
      meta.reportedCostUsd = j.total_cost_usd; meta.modelUsage = j.modelUsage; meta.numTurns = j.num_turns;
      meta.permissionDenials = (j.permission_denials ?? []).length; meta.isError = j.is_error; meta.resultText = j.result;
    } catch { meta.claudeJsonUnreadable = true; }
    meta.transcripts = copyTranscripts(repo, sessionId, path.join(dest, 'transcripts'));
    meta.usage = transcriptUsage(path.join(dest, 'transcripts'));

    let findings = [];
    if (arm === 'hunt') {
      findings = huntFindings(repo);
      // No finished hunt run (for example the skill is missing) is not the same as no findings.
      const runsDir = path.join(repo, '.rough-ride', 'runs');
      meta.findingsFile = existsSync(runsDir) && readdirSync(runsDir).some((r) => r.includes('-hunt-') && existsSync(path.join(runsDir, r, 'findings.json'))) ? 'ok' : 'missing';
      if (existsSync(path.join(repo, '.rough-ride'))) cpSync(path.join(repo, '.rough-ride'), path.join(dest, 'rough-ride'), { recursive: true });
    } else if (arm === 'rough-ride') {
      findings = roughRideFindings(repo);
      if (existsSync(path.join(repo, '.rough-ride'))) cpSync(path.join(repo, '.rough-ride'), path.join(dest, 'rough-ride'), { recursive: true });
    } else if (existsSync(path.join(outDir, 'findings.json'))) {
      try { findings = JSON.parse(readFileSync(path.join(outDir, 'findings.json'), 'utf8')).findings ?? []; meta.findingsFile = 'ok'; }
      catch (e) { meta.findingsFile = `unreadable: ${e.message}`; cpSync(path.join(outDir, 'findings.json'), path.join(dest, 'findings.raw.json')); }
    } else meta.findingsFile = 'missing';
    writeFileSync(path.join(dest, 'findings.json'), scrubPaths(JSON.stringify({ findings }, null, 2)) + '\n');
    meta.findingCount = findings.length;

    // Did the arm change the code under test? (rough-ride's own folder is expected.)
    const after = sh('git', ['status', '--porcelain'], { cwd: repo }).stdout;
    meta.sourceChanged = after.split('\n').filter((l) => l && !l.includes('.rough-ride/')).join('\n') !== meta.diffBefore.split('\n').filter((l) => l && !l.includes('.rough-ride/')).join('\n');
    meta.sourceDiff = sh('git', ['diff', '--stat'], { cwd: repo }).stdout;
  } finally {
    await stopApp();
  }
  // Keep what the arm wrote to its scratch folder, then free the disk.
  cpSync(scratch, path.join(dest, 'scratch'), { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
  rmSync(work, { recursive: true, force: true });
  meta.finishedAt = new Date().toISOString();
  writeFileSync(path.join(dest, 'meta.json'), scrubPaths(JSON.stringify(meta, null, 2)) + '\n');
  console.log(`${id}: ${meta.findingCount} findings, ${Math.round(meta.wallMs / 1000)}s, exit ${meta.claudeExit}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
}
