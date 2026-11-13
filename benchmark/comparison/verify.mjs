// node benchmark/comparison/verify.mjs <lanes>
// Checks every distinct non-planted issue from judge pass 1 on a fresh copy of
// its feature (clean, or the one buggy variant every report came from): a claude session with a Playwright browser tries to
// reproduce it and says confirmed, not-reproduced or not-a-defect. It sees
// the issue and sample reports, never which arm reported it.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { lanePorts, materializeVariant, mcpConfig, newSessionId, REPO, RESULTS, runClaude, scrubPaths, seed, startApp, FEATURES } from './lib.mjs';
import { scoredTrials } from './judge.mjs';

function verifyPrompt(feature, sentence, samples, ports, out, scratch) {
  const request = readFileSync(path.join(REPO, 'benchmark/apps/garden-log/features', feature, 'request.md'), 'utf8').trim();
  return `Testers reported a problem with a change to this garden-log web app. Your job is to check, independently and sceptically, whether the problem is real.

The change (uncommitted, see \`git diff main\` and \`git status\`) implements this request:
${request}

The app is running: web http://localhost:${ports.web}, API http://localhost:${ports.api}/api. Sign in with DEMO_EMAIL / DEMO_PASSWORD from the environment. You have a Playwright browser (playwright MCP tools; \`browser_route\` can make requests fail, hang or return odd data). You may read the code. Do not edit files in this repository; scratch files go in ${scratch}.

The reported problem: ${sentence}

Sample reports (they may be wrong, exaggerated or right):
${JSON.stringify(samples, null, 1)}

Decide one verdict:
- "confirmed": you made it happen in the running app (or, for a server-only problem, through the API), and it is a defect a user or the request would not accept.
- "not-a-defect": it happens, but it is how the app is meant to work, what the request asks for, or a deliberate design choice (for example a control that is disabled on purpose with a reason shown).
- "not-reproduced": you could not make it happen by following the reports and reasonable variations.
Be strict: "confirmed" needs something you saw. Write JSON to ${out}: {"verdict": "...", "evidence": "what you did and saw", "severity": "high" | "medium" | "low" | null}.`;
}

async function verifyOne(feature, bug, key, sentence, samples, lane) {
  const dest = path.join(RESULTS, 'verify', feature, key);
  if (existsSync(path.join(dest, 'verdict.json'))) return;
  mkdirSync(dest, { recursive: true });
  const work = path.join(process.env.BENCH_WORK, `verify-${feature}-${key}`);
  const scratch = path.join(work, 'scratch'); const outDir = path.join(work, 'out');
  mkdirSync(scratch, { recursive: true }); mkdirSync(outDir, { recursive: true });
  const repo = materializeVariant({ feature, bug }, lane, path.join(work, 'variant'));
  const stop = await startApp(repo, lane, path.join(dest, 'app.log'));
  try {
    await seed(lane, feature);
    const ports = lanePorts(lane);
    const mcpFile = path.join(work, 'mcp.json');
    mcpConfig(mcpFile, path.join(scratch, 'playwright'));
    const out = path.join(outDir, 'verdict.json');
    const text = verifyPrompt(feature, sentence, samples, ports, out, scratch);
    writeFileSync(path.join(dest, 'prompt.txt'), scrubPaths(text) + '\n');
    const r = await runClaude({ cwd: repo, arm: 'playwright', text, sessionId: newSessionId(), outDir, mcpFile });
    writeFileSync(path.join(dest, 'claude.json'), r.stdout);
    let verdict = { verdict: 'no-answer', evidence: r.stdout.slice(-500) };
    try { verdict = JSON.parse(readFileSync(out, 'utf8')); } catch {}
    writeFileSync(path.join(dest, 'verdict.json'), scrubPaths(JSON.stringify({ feature, variant: bug, key, sentence, ...verdict, wallMs: r.ms }, null, 2)) + '\n');
    console.log(`${feature}/${key}: ${verdict.verdict}`);
  } finally {
    await stop();
    rmSync(work, { recursive: true, force: true });
  }
}

const lanes = Number(process.argv[2] ?? '2');
const trials = scoredTrials();
const findingOf = (key) => { const [tid, i] = key.split('#'); return trials.find((t) => t.id === tid).findings[Number(i)]; };
const jobs = [];
for (const feature of FEATURES) {
  const file = path.join(RESULTS, 'judge', `${feature}.pass1.json`);
  if (!existsSync(file)) continue;
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const byIssue = {};
  for (const r of j.reports) if (!r.planted) (byIssue[r.issue] ??= []).push(r.key);
  for (const [key, keys] of Object.entries(byIssue)) {
    // Checked on the clean variant, unless every report came from one buggy variant.
    const variants = [...new Set(keys.map((k) => trials.find((t) => t.id === k.split('#')[0]).meta.bug))];
    const bug = variants.length === 1 ? variants[0] : 'clean';
    const samples = keys.slice(0, 3).map(findingOf).map(({ title, where, steps, expected, actual, evidence }) => ({ title, where, steps, expected, actual, evidence }));
    jobs.push({ feature, bug, key, sentence: j.issues[key] ?? key, samples });
  }
}
console.log(`${jobs.length} issues to verify`);
let next = 0;
await Promise.all(Array.from({ length: lanes }, async (_, lane) => {
  while (next < jobs.length) { const job = jobs[next++]; try { await verifyOne(job.feature, job.bug, job.key, job.sentence, job.samples, lane + Number(process.env.BENCH_LANE_OFFSET ?? 0)); } catch (e) { console.log(`${job.feature}/${job.key}: error ${e.message}`); } }
}));
