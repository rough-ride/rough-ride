// rough-ride repro <run id>/r<n> [--keep-open] (spec part 3 section 14): re-runs
// one failed attack by its id and says whether it reproduced. With --keep-open
// it replays the attack in a Chrome it keeps open, fault armed, for Chrome
// DevTools MCP, one repro at a time, for up to 30 minutes.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext } from 'playwright-core';
import { runAttack } from './attacks.mjs';
import type { BrowserName, Launched } from './browser.mjs';
import { inlineChecks } from './appchecks.mjs';
import { buildCatalogue, resolveTest } from './catalogue.mjs';
import { checkRank, checkSeverity } from './checks.mjs';
import { stopWith } from './exit.mjs';
import { checkCommittedFiles } from './files.mjs';
import { ensureFolder, type FolderState } from './folder.mjs';
import type { Flow } from './flowrun.mjs';
import { runFlow } from './flowrun.mjs';
import { SEVERITY_TEXT } from './groups.mjs';
import { Manifest } from './manifest.mjs';
import { fetchOpenApi, rekey } from './openapi.mjs';
import { escapeName, formatDuration, type Note } from './output.mjs';
import { compareProtected } from './protected.mjs';
import { followUpCommand, runnerBlock, type RunnerInfo } from './runner.mjs';
import { RUN_ID, type RunFolder } from './runs.mjs';
import { checkSignInEnv } from './session.mjs';
import { apiOrigins } from './tier.mjs';
import { openTargetSession } from './targetsession.mjs';

export interface ReproContext {
  root: string;
  folder: FolderState;
  info: RunnerInfo;
  id: string | null;
  keepOpen: boolean;
  browserFlag: BrowserName | null;
  start: boolean;
  argv: string[];
  env: NodeJS.ProcessEnv;
  notes: Note[];
  elapsed: () => number;
  progress: (line: string) => void;
  launch?: (name: BrowserName) => Promise<Launched>;
  // Tests replace the 30-minute hold.
  holdMs?: number;
}

export interface ReproResult {
  run: RunFolder | null;
  lines: string[];
  document: Record<string, unknown>;
  status: 'findings' | 'passed' | 'incomplete';
  exitCode: 0 | 1 | 2;
}

const HOLD_MS = 30 * 60 * 1000;

interface ReproRecord {
  runId: string;
  repro: string;
  finding?: string;
  page?: string | null;
  key?: string;
  runner: { version: string };
  flow: { name: string; parsed: Flow };
  attack: Record<string, unknown>;
  failedChecks: { id: string; evidence: string; check?: Record<string, unknown> }[];
}

// 0.x accepts the same version; from 1.0.0 the same major (14.3).
function sameRunner(written: string, running: string): boolean {
  if (running.startsWith('0.')) return written === running;
  return written.split('.')[0] === running.split('.')[0];
}

export async function runRepro(ctx: ReproContext): Promise<ReproResult> {
  const { root, info } = ctx;
  const m = /^(.+)\/(r\d{2,})$/.exec(ctx.id ?? '');
  if (!m || !RUN_ID.test(m[1]!)) stopWith('usage', `repro takes <run id>/r<n>, for example 20261025-141207-quick-k3fz/r01 (got ${escapeName(ctx.id ?? 'nothing')}).`);
  const [, runId, repro] = m!;
  const tierCmd = followUpCommand(info, ['quick']);
  const folder = ensureFolder(ctx.folder);
  const runDir = path.join(folder.dir, 'runs', runId!);
  const file = path.join(runDir, 'repros', `${repro}.json`);
  if (!existsSync(runDir)) stopWith('run-not-found', `Run ${runId} not found: rough-ride keeps the newest 10 tier runs. Run ${tierCmd} again.`);
  // Refused before any browser starts: altered, unknown or missing records (27.6).
  const manifest = new Manifest(root);
  ctx.notes.push(...manifest.notes);
  let record: ReproRecord | null = null;
  try {
    record = JSON.parse(readFileSync(file, 'utf8')) as ReproRecord;
  } catch {
    record = null;
  }
  if (record && !sameRunner(record.runner?.version ?? '', info.version)) {
    stopWith('run-other-version', `Run ${runId} was written by rough-ride ${record.runner.version}; this is ${info.version}. Run ${tierCmd} again.`);
  }
  manifest.verifyRun(runId!, `repros/${repro}.json`, record, `repro ${repro}`, tierCmd);
  const rec = record!;

  const files = checkCommittedFiles(folder, { info, subcommand: 'repro', argv: ctx.argv, env: ctx.env });
  const prot = compareProtected({ root, folderDir: folder.dir, files, env: ctx.env, pluginData: !!info.pluginData, manifest, mode: 'regress' });
  ctx.notes.push(...files.notes, ...prot.notes);
  const config = prot.config;
  const flows = prot.flows.map((f) => f.flow);
  // The flow's effective version (13.7), not the copy in the record.
  const flow = flows.find((f) => f.name === rec.flow.name) ?? rec.flow.parsed;
  checkSignInEnv(flows, folder, ctx.env);
  // repro's flow runs have never had the Bash limits, though 50.4 names every call with a plugin data folder.
  const session = await openTargetSession({
    root, folder, files, info, argv: ctx.argv, env: ctx.env, notes: ctx.notes, config, flows,
    start: ctx.start, againCommand: tierCmd, browserFlag: ctx.browserFlag, ...(ctx.launch ? { launch: ctx.launch } : {}),
    elapsed: ctx.elapsed, run: { create: 'repro' }, reset: true, bashLimits: false,
  });
  const { target, hosts } = session;
  const run = session.run!;
  const lead = [...rec.failedChecks].map((c) => c.id).sort((a, b) => checkRank(a) - checkRank(b))[0] ?? null;
  let verdict: 'reproduced' | 'did not reproduce' | string = 'did not reproduce';
  let exitCode: 0 | 1 | 2 = 0;
  const openLines: string[] = [];
  try {
    await session.reset();
    const signedIn = await session.signIn();
    const base = session.defaults(flow);
    const baseline = flow.name === 'sign-in' && signedIn.result ? signedIn.result : await runFlow({ ...base, flow, shots: 'all' });
    if (!baseline.passed) {
      verdict = `could not apply: ${flow.name} failed its baseline run`;
      exitCode = 2;
    } else {
      const docs = await fetchOpenApi(apiOrigins(target, [baseline]), [baseline]);
      rekey(baseline, docs);
      const catalogue = buildCatalogue({ tier: 'standard', flows: [{ flow, runs: [baseline], passed: true }], docs, hosts, today: new Date() });
      const resolved = resolveTest(catalogue, flow.name, rec.attack);
      if ('stale' in resolved || 'pass' in resolved) {
        verdict = `could not apply: ${'stale' in resolved ? resolved.stale : resolved.pass}`;
        exitCode = 2;
      } else {
        const o = await runAttack(resolved.attack, flow, baseline, base, docs, inlineChecks(rec.failedChecks.flatMap((c) => (c.check ? [c.check] : []))));
        const leadResult = o.checks.find((c) => c.id === lead)?.result;
        if (['not-applied', 'fault-never-fired', 'void', 'inconclusive'].includes(o.verdict)) {
          verdict = `could not apply: ${o.notApplied ?? o.verdict}`;
          exitCode = 2;
        } else if (leadResult === 'fail') {
          verdict = 'reproduced';
          exitCode = 1;
        }
        if (ctx.keepOpen) await keepOpen(ctx, resolved.attack, flow, baseline, base, docs, openLines);
      }
    }
  } finally {
    await session.close();
  }
  const sev = lead ? SEVERITY_TEXT[checkSeverity(lead)] : 'LOW ';
  const lines = [
    `rough-ride repro | ${formatDuration(ctx.elapsed())} | run ${run.id}`,
    `${sev}  ${rec.finding ?? ''}`,
    `      ${rec.page ?? '-'} | ${rec.key ?? '-'} | fails: ${rec.failedChecks.map((c) => c.id).join(', ')}`,
    verdict,
    ...runnerBlock(info),
  ];
  return { run, lines, document: { repro: { id: `${runId}/${repro}`, verdict, lead } }, status: exitCode === 1 ? 'findings' : exitCode === 2 ? 'incomplete' : 'passed', exitCode };
}

// --keep-open: a persistent Chrome on an emptied profile and a random debugging
// port, the attack replayed with its fault armed, held until Ctrl-C or 30 minutes.
async function keepOpen(
  ctx: ReproContext,
  attack: Parameters<typeof runAttack>[0],
  flow: Flow,
  baseline: Parameters<typeof runAttack>[2],
  base: Omit<Parameters<typeof runFlow>[0], 'flow'>,
  docs: Parameters<typeof runAttack>[4],
  out: string[],
): Promise<void> {
  const dataDir = ctx.info.pluginData?.path ?? null;
  const profile = dataDir ? path.join(dataDir, 'repro-profile') : mkdtempSync(path.join(tmpdir(), 'rough-ride-repro-'));
  const lockFile = dataDir ? path.join(dataDir, 'repro-profile.lock') : null;
  // One repro at a time (14.7).
  if (lockFile && existsSync(lockFile)) {
    const held = JSON.parse(readFileSync(lockFile, 'utf8')) as { pid: number; repo: string };
    let alive = false;
    try {
      process.kill(held.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) stopWith('repro-open', `Another repro is open (pid ${held.pid}, repo ${held.repo}). Close it with Ctrl-C there, or wait for its 30-minute limit.`);
  }
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  if (lockFile) writeFileSync(lockFile, JSON.stringify({ pid: process.pid, repo: ctx.root }));
  const { chromium } = await import('playwright-core');
  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chrome',
      headless: false,
      args: ['--remote-debugging-port=0'],
      ...(attack.kind === 'viewport' ? { viewport: { width: 375, height: 800 } } : {}),
    });
    // The port Chrome picked, from DevToolsActivePort (a fixed port can be taken).
    let port = '';
    for (let i = 0; i < 50 && !port; i++) {
      try {
        port = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]!.trim();
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    // The shared session goes into the persistent context: its cookies, and localStorage per origin.
    const state = base.storageState;
    if (state) {
      await context.addCookies(state.cookies);
      for (const origin of state.origins) {
        await context.addInitScript(({ o, items }) => {
          if (location.origin === o) for (const it of items) localStorage.setItem(it.name, it.value);
        }, { o: origin.origin, items: origin.localStorage });
      }
    }
    const o = await runAttack(attack, flow, baseline, { ...base, browser: undefined as unknown as Browser, context, keepArmed: true, keepDialogs: true }, docs);
    const fault = attack.fault;
    out.push(`page: ${o.page ?? '-'}`);
    if (fault) out.push(`fault: ${fault} on ${attack.template}, ${attack.sticky ? 'sticky, on until Ctrl-C' : 'one-shot, re-arms on every page load: reload, then repeat the action'}`);
    else if (attack.kind === 'viewport') out.push('viewport: 375 x 800, kept until Ctrl-C');
    else if (attack.kind === 'bad-input' && attack.badInput) out.push(`bad input: ${attack.badInput.inputId} in ${attack.badInput.field.name} (${attack.template || 'no request'}), replayed; nothing stays armed`);
    else if (attack.timing === 'signed-out-reload') out.push(`timing: signed-out-reload on ${attack.page ?? '-'}, signed out until Ctrl-C`);
    else if (attack.timing === 'out-of-order') out.push(`timing: out-of-order on ${attack.template}, armed until Ctrl-C: type two values quickly; the first answer arrives last`);
    else out.push(`timing: ${attack.timing} on ${attack.controlName ?? attack.key} (${attack.key}), replayed; nothing stays armed`);
    for (const e of o.run.pageEvents.slice(0, 3)) out.push(`console: ${escapeName(e.text, 80)}`);
    out.push('Attach Chrome DevTools MCP, then repeat the failing action: the MCP sees no earlier events.');
    out.push(`--browserUrl=http://127.0.0.1:${port}`);
    for (const line of out) process.stdout.write(line + '\n');
    // Held until Ctrl-C or 30 minutes; Ctrl-C here ends the repro, never exit 130.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ctx.holdMs ?? HOLD_MS);
      process.removeAllListeners('SIGINT');
      process.once('SIGINT', () => {
        clearTimeout(timer);
        resolve();
      });
      context!.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } finally {
    await context?.close().catch(() => {});
    if (lockFile) {
      try {
        unlinkSync(lockFile);
      } catch {
        // Already gone.
      }
    }
  }
}
