// rough-ride regress (spec part 6 section 25): runs the committed regression
// tests with no agent and no LLM. Each test runs its flow from the first step,
// re-applies its one attack through the same single-attack runner confirmation
// runs use, and is judged only by its listed checks.

import { availableParallelism } from 'node:os';
import path from 'node:path';
import { printed } from '../hooks/path-check.mjs';
import { nonFinding, runAttack, type AttackOutcome, type PlannedAttack } from './attacks.mjs';
import type { BrowserName, Launched } from './browser.mjs';
import { inlineChecks } from './appchecks.mjs';
import { buildCatalogue, resolveTest } from './catalogue.mjs';
import { checkRank } from './checks.mjs';
import { stopWith } from './exit.mjs';
import { checkCommittedFiles } from './files.mjs';
import { ensureFolder, type FolderState } from './folder.mjs';
import { runFlow, type Flow, type FlowRunResult } from './flowrun.mjs';
import { allowedSuffix } from './guard.mjs';
import { Manifest } from './manifest.mjs';
import { fetchOpenApi, rekey, type OpenApiDoc } from './openapi.mjs';
import { canonicalJson, formatDuration, type Note } from './output.mjs';
import { capSections } from './summary.mjs';
import { blockLines, blockWithHints, compareProtected, protectedJson, reportLines as protectedReport, summaryLines as protectedSummary } from './protected.mjs';
import { ciMode, environmentRecord, followUpCommand, runnerBlock, type RunnerInfo } from './runner.mjs';
import { acceptedEntries, testAcceptedNotes } from './accepted.mjs';
import type { RunFolder } from './runs.mjs';
import { checkSignInEnv } from './session.mjs';
import { apiOrigins, inLanes, lanesFor, PRE_RELEASE } from './tier.mjs';
import { openTargetSession, type FlowRunDefaults } from './targetsession.mjs';
import { writeAtomic } from './write.mjs';

export type TestOutcome = 'pass' | 'fail' | 'flaky' | 'stale';

export interface TestValue {
  flow: string;
  attack: Record<string, unknown>;
  checks: unknown[];
  context?: { timezone: string; locale: string };
  found?: { held?: { length: number | null } };
}

export interface RunJudgement {
  state: 'pass' | 'fail' | 'stale';
  reason: string | null;
  failed: string[];
  alsoFailed: string[];
}

const checkId = (c: unknown): string => (typeof c === 'string' ? c : String((c as { id?: string })?.id ?? ''));

// One flow run judged by the test's listed checks only (25.6).
export function judgeRun(listed: unknown[], o: AttackOutcome): RunJudgement {
  const ids = listed.map(checkId);
  const failedAll = o.checks.filter((c) => c.result === 'fail').map((c) => c.id as string);
  const alsoFailed = failedAll.filter((c) => !ids.includes(c));
  if (['not-applied', 'fault-never-fired', 'void', 'pending', 'inconclusive'].includes(o.verdict) && !o.checks.some((c) => ids.includes(c.id) && c.result === 'fail')) {
    return { state: 'stale', reason: nonFinding(o, 12_000)?.text ?? o.verdict, failed: [], alsoFailed };
  }
  const byRank = (a: string, b: string) => checkRank(a) - checkRank(b);
  const failed = o.checks.filter((c) => ids.includes(c.id) && c.result === 'fail').map((c) => c.id as string).sort(byRank);
  const noAttack = o.checks.filter((c) => ids.includes(c.id) && c.result === 'skipped-baseline').map((c) => c.id as string);
  if (failed.length > 0 || noAttack.length > 0) {
    return { state: 'fail', reason: noAttack.length > 0 && failed.length === 0 ? 'fails with no attack' : null, failed: [...failed, ...noAttack], alsoFailed };
  }
  const unjudged = o.checks.filter((c) => ids.includes(c.id) && c.result === 'not-evaluated');
  if (unjudged.length > 0) return { state: 'stale', reason: `not evaluated (${unjudged[0]!.evidence})`, failed: [], alsoFailed };
  return { state: 'pass', reason: null, failed: [], alsoFailed };
}

export interface FirstRun {
  judgement: RunJudgement | null;
  stale: string | null;
  pass: string | null;
  attack: PlannedAttack | null;
  outcome: AttackOutcome | null;
  pin?: { timezone: string; locale: string };
}

// One test's first flow run: a pinned baseline when its context differs, the
// attack point, then the single-attack runner (25.3, 25.4).
export async function runTestOnce(
  value: TestValue,
  flow: Flow,
  baseline: FlowRunResult,
  docs: OpenApiDoc[],
  options: FlowRunDefaults,
): Promise<FirstRun> {
  const own = Intl.DateTimeFormat().resolvedOptions();
  const pin = value.context && (value.context.timezone !== own.timeZone || value.context.locale !== own.locale) ? value.context : undefined;
  let base = baseline;
  if (pin) {
    const pinned = await runFlow({ ...options, flow, pin, shots: 'all' });
    if (!pinned.passed) return { judgement: null, stale: `${flow.name} failed its baseline run in ${pin.timezone} ${pin.locale}`, pass: null, attack: null, outcome: null };
    rekey(pinned, docs);
    base = pinned;
  }
  const catalogue = buildCatalogue({ tier: 'standard', flows: [{ flow, runs: [base], passed: true }], docs, hosts: options.hosts, today: new Date() });
  const resolved = resolveTest(catalogue, flow.name, value.attack);
  if ('stale' in resolved) return { judgement: null, stale: resolved.stale, pass: null, attack: null, outcome: null };
  if ('pass' in resolved) return { judgement: null, stale: null, pass: resolved.pass, attack: null, outcome: null };
  const o = await runAttack(resolved.attack, flow, base, { ...options, ...(pin ? { pin } : {}) }, docs, inlineChecks(value.checks));
  return { judgement: judgeRun(value.checks, o), stale: null, pass: null, attack: resolved.attack, outcome: o, ...(pin ? { pin } : {}) };
}

// pass, fail, flaky or stale from one or two flow runs (25.6).
export function combine(first: RunJudgement, second: RunJudgement | null): TestOutcome {
  if (!second) return first.state === 'pass' ? 'pass' : first.state === 'fail' ? 'fail' : 'stale';
  const states = [first.state, second.state];
  if (states.every((x) => x === 'pass')) return 'pass';
  if (states.includes('pass')) return 'flaky';
  if (states.includes('fail')) return 'fail';
  return 'stale';
}

export const REGRESS_CAP = 50;

export interface RegressContext {
  root: string;
  folder: FolderState;
  info: RunnerInfo;
  only: string[];
  browserFlag: BrowserName | null;
  start: boolean;
  argv: string[];
  env: NodeJS.ProcessEnv;
  notes: Note[];
  elapsed: () => number;
  progress: (line: string) => void;
  launch?: (name: BrowserName) => Promise<Launched>;
}

export interface RegressResult {
  run: RunFolder | null;
  lines: string[];
  document: Record<string, unknown>;
  status: 'passed' | 'findings' | 'incomplete';
  exitCode: 0 | 1 | 2;
}

interface TestResult {
  name: string;
  flow: string;
  outcome: TestOutcome;
  reason: string | null;
  checks: string[];
  failed: string[];
  alsoFailed: string[];
  note: string | null;
  accepted: string[];
}

export async function runRegress(ctx: RegressContext): Promise<RegressResult> {
  const { root, info } = ctx;
  const folder = ensureFolder(ctx.folder);
  const files = checkCommittedFiles(folder, { info, subcommand: 'regress', argv: ctx.argv, env: ctx.env });
  ctx.notes.push(...files.notes);
  const manifest = new Manifest(root);
  const prot = compareProtected({ root, folderDir: folder.dir, files, env: ctx.env, pluginData: !!info.pluginData, manifest, mode: 'regress' });
  ctx.notes.push(...prot.notes);
  const acceptedList = acceptedEntries(files.accepted, prot.accepted, info.version, ctx.notes);
  const block = runnerBlock(info);
  const all = prot.tests;
  // --only names every test it wants, valid or not; an unknown name is a usage stop (25.1).
  const names = [...new Set([...all.map((t) => t.name), ...files.tests.map((f) => f.shown.split('/').at(-1)!.replace(/\.yaml$/, ''))])].sort();
  const unknown = ctx.only.filter((n) => !names.includes(n));
  if (unknown.length > 0) stopWith('unknown-test', `No regression test named ${unknown.join(', ')}. Tests: ${names.join(', ') || 'none'}.`);
  if (all.length === 0) {
    return { run: null, lines: ['rough-ride regress | ' + formatDuration(ctx.elapsed()), 'No regression tests in .rough-ride/tests/.', ...block], document: { protectedLines: prot.entries.length === 0 ? [] : blockWithHints(prot), sections: [{ id: 'header', lines: ['rough-ride regress | ' + formatDuration(ctx.elapsed())] }, { id: 'after', lines: ['No regression tests in .rough-ride/tests/.'] }, { id: 'runner', lines: block }], regress: { pass: 0, fail: 0, flaky: 0, stale: 0, overLimit: 0, tests: [] } }, status: 'passed', exitCode: 0 };
  }
  // At most 50 tests: open ones first, then by name; --only is not capped (51.13, resolution 134).
  const isOpen = (name: string) => !!manifest.data.tests[name];
  const ordered = ctx.only.length > 0 ? all.filter((t) => ctx.only.includes(t.name)) : [...all].sort((a, b) => Number(isOpen(b.name)) - Number(isOpen(a.name)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const tests = ctx.only.length > 0 ? ordered : ordered.slice(0, REGRESS_CAP);
  const overLimit = ordered.slice(tests.length).map((t) => t.name);
  const config = prot.config;
  const flows = prot.flows.map((f) => f.flow);
  checkSignInEnv(flows, folder, ctx.env);
  const session = await openTargetSession({
    root, folder, files, info, argv: ctx.argv, env: ctx.env, notes: ctx.notes, config, flows,
    start: ctx.start, againCommand: '/rough-ride:quick', browserFlag: ctx.browserFlag, ...(ctx.launch ? { launch: ctx.launch } : {}),
    elapsed: ctx.elapsed, run: { create: 'regress' }, reset: true,
  });
  const { target, hosts } = session;
  const run = session.run!;
  const results: TestResult[] = [];
  const startedAt = new Date().toISOString();
  try {
    await session.reset();
    const signInOutcome = await session.signIn();
    const lanes = lanesFor(availableParallelism());
    // Each flow the tests use: one baseline run, two with neither a reviewed version nor a saved copy (25.2).
    const usedFlows = [...new Set(tests.map((t) => String(t.value.flow)))];
    const baselines = new Map<string, FlowRunResult | null>();
    const bashSkipped = new Set<string>();
    if (signInOutcome.result) baselines.set('sign-in', signInOutcome.passed ? signInOutcome.result : null);
    await inLanes(lanes, usedFlows.filter((n) => n !== 'sign-in').map((name) => async () => {
      const flow = flows.find((f) => f.name === name);
      const eff = prot.flows.find((e) => e.flow.name === name);
      if (!flow || (flow.signedIn && !signInOutcome.passed)) return baselines.set(name, null);
      const times = eff && (eff.reviewed || eff.used === 'saved-copy') ? 1 : 2;
      let last: FlowRunResult | null = null;
      for (let i = 0; i < times; i++) {
        if (session.bashBlocks()) {
          bashSkipped.add(name);
          return baselines.set(name, null);
        }
        const r = await runFlow({ ...session.defaults(flow), flow, shots: 'all' });
        if (!r.passed) return baselines.set(name, null);
        last = r;
      }
      baselines.set(name, last);
    }));
    const docs = await fetchOpenApi(apiOrigins(target, [...baselines.values()].filter((x): x is FlowRunResult => !!x)), [...baselines.values()].filter((x): x is FlowRunResult => !!x));
    for (const r of baselines.values()) if (r) rekey(r, docs);

    // First runs in lanes, the sign-in flow's tests last; then a refresh and second runs alone (25.2).
    const first = new Map<string, FirstRun>();
    const runTest = async (t: (typeof tests)[number]) => {
      const name = String(t.value.flow);
      const flow = flows.find((f) => f.name === name);
      if (session.bashBlocks()) return first.set(t.name, { judgement: null, stale: 'stopped by the Bash time limit', pass: null, attack: null, outcome: null });
      if (!flow) return first.set(t.name, { judgement: null, stale: `flow ${name} is missing or invalid`, pass: null, attack: null, outcome: null });
      if (flow.signedIn && !signInOutcome.ran) return first.set(t.name, { judgement: null, stale: 'no sign-in flow', pass: null, attack: null, outcome: null });
      if (flow.signedIn && !signInOutcome.passed) return first.set(t.name, { judgement: null, stale: 'sign-in failed', pass: null, attack: null, outcome: null });
      const baseline = baselines.get(name);
      if (!baseline) return first.set(t.name, { judgement: null, stale: bashSkipped.has(name) ? 'stopped by the Bash time limit' : `${name} failed its baseline run`, pass: null, attack: null, outcome: null });
      first.set(t.name, await runTestOnce(t.value as unknown as TestValue, flow, baseline, docs, session.defaults(flow)));
    };
    await inLanes(lanes, tests.filter((t) => t.value.flow !== 'sign-in').map((t) => () => runTest(t)));
    await inLanes(lanes, tests.filter((t) => t.value.flow === 'sign-in').map((t) => () => runTest(t)));
    let refreshFailed = false;
    if (tests.some((t) => t.value.flow === 'sign-in') && signInOutcome.ran) {
      if (session.bashBlocks() || !(await session.refreshSignIn())) refreshFailed = true;
    }
    for (const t of tests) {
      const f = first.get(t.name)!;
      const value = t.value as unknown as TestValue;
      const listed = value.checks.map(checkId);
      let second: RunJudgement | null = null;
      if (f.judgement && f.judgement.state !== 'pass' && f.attack) {
        const flow = flows.find((x) => x.name === value.flow)!;
        if (refreshFailed && flow.signedIn) second = { state: 'stale', reason: 'sign-in failed', failed: [], alsoFailed: [] };
        else if (session.bashBlocks()) second = { state: 'stale', reason: 'stopped by the Bash time limit', failed: [], alsoFailed: [] };
        else second = judgeRun(value.checks, await runAttack(f.attack, flow, baselines.get(String(value.flow))!, { ...session.defaults(flow), ...(f.pin ? { pin: f.pin } : {}) }, docs, inlineChecks(value.checks)));
      }
      if (f.stale || f.pass) {
        results.push({ name: t.name, flow: String(value.flow), outcome: f.pass ? 'pass' : 'stale', reason: f.pass ?? f.stale, checks: listed, failed: [], alsoFailed: [], note: null, accepted: [] });
        continue;
      }
      const outcome = combine(f.judgement!, second);
      const failed = [...new Set([...(f.judgement!.failed), ...(second?.failed ?? [])])];
      const reason = outcome === 'flaky' ? 'passed once, failed once' : outcome === 'stale' ? (f.judgement!.reason ?? second?.reason ?? null) : f.judgement!.reason;
      // The held length against the length when found, for bad inputs (25.3).
      const heldNow = f.outcome?.run.badInput?.held?.length ?? null;
      const heldThen = value.found?.held?.length ?? null;
      const note = heldNow !== null && heldThen !== null && heldNow !== heldThen ? `held ${heldNow.toLocaleString('en-US')} chars now; ${heldThen.toLocaleString('en-US')} when found${heldNow < heldThen ? ' (cut by maxlength)' : ''}` : null;
      results.push({ name: t.name, flow: String(value.flow), outcome, reason, checks: listed, failed, alsoFailed: f.judgement!.alsoFailed, note, accepted: testAcceptedNotes(acceptedList, f.outcome, flows.find((x) => x.name === value.flow), failed) });
    }
  } finally {
    await session.close();
  }

  // Each test's last outcome in the manifest (25.7); tests themselves are never written.
  for (const r of results) manifest.data.tests[r.name] = { outcome: r.outcome, run: run.id, at: startedAt };
  manifest.save();
  ctx.notes.push(...manifest.notes.filter((n) => !ctx.notes.some((m) => m.text === n.text)));
  const count = (o: TestOutcome) => results.filter((r) => r.outcome === o).length;
  const status: RegressResult['status'] = count('fail') > 0 ? 'findings' : count('flaky') + count('stale') + overLimit.length > 0 ? 'incomplete' : 'passed';
  const exitCode: RegressResult['exitCode'] = status === 'findings' ? 1 : status === 'incomplete' ? 2 : 0;
  const testLine = (r: TestResult): string[] => {
    if (r.outcome === 'fail') return [`fail   ${r.name} | ${r.reason === 'fails with no attack' ? 'fails with no attack: ' : ''}${r.failed.join(', ')}${r.alsoFailed.length > 0 ? ` | also failed: ${r.alsoFailed.join(', ')} (not checked by this test)` : ''}`, ...(r.note ? [`       ${r.note}`] : [])];
    if (r.outcome === 'flaky') return [`flaky  ${r.name} | passed once, failed once`];
    if (r.outcome === 'stale') return [`stale  ${r.name} | ${r.reason ?? 'stale'}`];
    return [];
  };
  const notPassed = results.filter((r) => r.outcome !== 'pass');
  const shown = notPassed.slice(0, 8).flatMap(testLine);
  const more = notPassed.length > 8 ? [`+${notPassed.length - 8} more (report.txt)`] : [];
  const totals = `Regression tests: ${count('pass')} passed | ${count('fail')} failed | ${count('flaky')} flaky | ${count('stale')} stale${overLimit.length > 0 ? ` | ${overLimit.length} over the regress limit` : ''}`;
  const failedNames = results.filter((r) => r.outcome === 'fail').map((r) => r.name);
  const ci = ciMode(ctx.env, info);
  const commands: string[] = [];
  // No Fix and no Next line in CI mode (51.12).
  if (failedNames.length > 0 && !ci) {
    const fix = `Fix, then run: ${followUpCommand(info, ['regress', ...failedNames.flatMap((n) => ['--only', n])])}`;
    commands.push(fix.length > 400 ? `Fix, then run: ${followUpCommand(info, ['regress'])}` : fix);
  } else if (ctx.only.length > 0 && count('pass') === results.length && !ci) {
    commands.push(info.pluginData ? 'Next: /rough-ride:quick attacks what the fix changed.' : `Next: ${followUpCommand(info, ['quick'])}`);
  }
  const reportPath = printed(path.join(folder.dir, 'runs', run.id, 'report.txt'));
  const head1 = [`rough-ride regress`, formatDuration(ctx.elapsed()), `run ${run.id}`, ...(info.version.startsWith('0.') ? [PRE_RELEASE] : [])].join(' | ');
  const sections = capSections([
    { id: 'header', lines: [head1] },
    { id: 'protected', lines: protectedSummary(prot) },
    { id: 'findings', lines: [...shown, ...more] },
    { id: 'after', lines: [totals] },
    { id: 'commands', lines: commands },
    { id: 'report', lines: [ci ? `Full report: ${run.id}/report.txt in the job's uploaded run output` : `Full report: ${reportPath}`] },
    { id: 'runner', lines: block },
  ], 25);
  const lines = sections.flatMap((x) => x.lines);
  const report = [
    head1,
    `started ${startedAt}`,
    `target: ${target.url}${allowedSuffix(hosts)}`,
    '',
    ...ctx.notes.map((n) => n.text),
    ...protectedReport(prot),
    '',
    ...results.flatMap((r) => (r.outcome === 'pass' ? [`pass   ${r.name}${r.reason ? ` | ${r.reason}` : ''}`] : [...testLine(r), ...r.accepted.map((a) => `       ${a}`)])),
    ...overLimit.map((n) => `over   ${n} | over the regress limit`),
    '',
    totals,
    ...commands,
    '',
    ...block,
  ];
  writeAtomic(folder, ['runs', run.id, 'report.txt'], report.join('\n') + '\n');
  const document = {
    sections,
    protectedLines: prot.entries.length === 0 ? [] : blockWithHints(prot),
    runId: run.id,
    runDir: run.dir.split('\\').join('/'),
    protected: protectedJson(prot),
    regress: {
      pass: count('pass'), fail: count('fail'), flaky: count('flaky'), stale: count('stale'), overLimit: overLimit.length,
      tests: results.map((r) => ({ name: r.name, outcome: r.outcome, reason: r.reason, checks: r.checks, alsoFailed: r.alsoFailed })),
    },
    commands: { fix: commands.find((c) => c.startsWith('Fix')) ?? null, investigate: null, more: null },
    meta: { startedAt, durationMs: Math.round(ctx.elapsed()), timings: { regressMs: Math.round(ctx.elapsed()) } },
  };
  // record.json adds the environment; summary.json does not carry it (38, 52.1).
  writeAtomic(folder, ['runs', run.id, 'record.json'], canonicalJson({ ...document, environment: environmentRecord(ctx.env, info) }));
  return { run, lines, document, status, exitCode };
}
