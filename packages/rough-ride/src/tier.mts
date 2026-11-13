// A single quick or standard invocation up to its baseline runs (spec part 3
// sections 13.1 to 13.6, part 4 section 15.9). Attacks join in later tickets;
// until then every run that gets this far ends as nothing attacked.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import type { Page, Locator } from 'playwright-core';
import { printed } from '../hooks/path-check.mjs';
import { SHORT_TITLES, type BrowserName, type Launched } from './browser.mjs';
import { diffMap, diffPatch, headerLine2, type Diff } from './diff.mjs';
import { checkCommittedFiles, writeProtected } from './files.mjs';
import { ensureFolder, folderNotes, nestedFoldersNote, readFolderFile, type FolderState } from './folder.mjs';
import { DELAY_MS, holdMsFor, RETRY_AFTER } from './faults.mjs';
import { describeLocator, envNames, runFlow, S, stepKind, type Flow, type FlowRunResult, type LocatorSpec } from './flowrun.mjs';
import { FORMATS, type FormatsReport } from './formats.mjs';
import { allowedSuffix } from './guard.mjs';
import type { HostPolicy } from './hosts.mjs';
import { canonicalJson, formatDuration, type Note } from './output.mjs';
import { ciMode, environmentRecord, followUpCommand, runnerBlock, type RunnerInfo } from './runner.mjs';
import type { RunReport } from './runoutput.mjs';
import type { RunFolder } from './runs.mjs';
import { asciiJson, instructionNotes, needsFlowItems, patchRanges, readSpecs, specCandidates, writeAdversaryFolder } from './adversary.mjs';
import { openReviewed } from './reviewed.mjs';
import { parseDotenv } from './session.mjs';
import { readSaved } from './flowsave.mjs';
import { cutPlanned, parsePlan, validatePlan, type ParsedPlan, type PlanResult } from './plan.mjs';
import { buildCatalogue, planCandidates, toRecord, type CatalogueRecord } from './catalogue.mjs';
import { readLinks } from './link.mjs';
import { adversaryCallTime, CATALOGUE, LIMITS, planAgain, SELECTION, type PlanState } from './runcheck.mjs';
import { blockLines, blockWithHints, changedDuringRun, compareProtected, type ProtectedResult, extraNodeCodeNote, protectedJson, reportLines as protectedReport, summaryLines as protectedSummary } from './protected.mjs';
import { Manifest } from './manifest.mjs';
import { buildTest } from './regression.mjs';
import { combine, judgeRun, runTestOnce, type FirstRun, type RunJudgement, type TestOutcome, type TestValue } from './regress.mjs';
import { parse as parseYaml } from 'yaml';
import { createClock } from './clock.mjs';
import { attackNominalMs, computeCut, flowNominalMs, orderedList, reserveMs, bandOf, type CutResult } from './budget.mjs';
import { TIER_TABLE, tierTableSha256, type TierName } from './tiers.mjs';
import { attackKey, attackRecord, writeRepro } from './record.mjs';
import { orderNotes, renderSections, reproId, type SummaryView } from './summary.mjs';
import { redactSecrets } from './secrets.mjs';
import { checkSignInEnv, refusedStop, type SignInOutcome } from './session.mjs';
import type { Target } from './target.mjs';
import { openTargetSession } from './targetsession.mjs';
import { reachedVia } from './tracing.mjs';
import { reachCounts, select, type Selection } from './selection.mjs';
import { account, notAttackedLines, nothingAttackedLine, reportNotAttacked, SCOPE_LINE } from './accounting.mjs';
import { attackLink, groupLines, nonFinding, orderAttacks, timingDedupeKey, runAttack, symptom as symptomOf, type AttackOutcome, type PlannedAttack } from './attacks.mjs';
import { baselineFailures, checkLabel } from './checks.mjs';
import { baselineGate, inlineChecks, probeFor, shapeOf, specFacts, type AppCheck, type PointProbe } from './appchecks.mjs';
import { cmp, confirmGroups, groupFindings, memberOf, SEVERITY_TEXT, type Group } from './groups.mjs';
import { acceptedEntries, acceptedRecord, acceptedReport, acceptsBaseline, applyAccepted, baselineKey, testAcceptedNotes } from './accepted.mjs';
import { moduleFiles, repoFiles } from './tracing.mjs';
import { writeAtomic } from './write.mjs';
import { CONTRACT_FILES, contractJson, contractLine, detectContract, summaryContractLine } from './contract.mjs';

// Every 0.x run says it, on the header line and in report.txt: the benchmark
// (benchmark/comparison/REPORT.md) measured this engine below Claude Code with a browser.
export const PRE_RELEASE = 'early preview: benchmarked below Claude Code with a browser, treat findings as leads to check';
export const PRE_RELEASE_REPORT = "Early preview: on the rough-ride benchmark, this engine's standard tier caught the planted bug in 5 of 18 runs, where Claude Code testing with a browser caught it in 18 of 18 with fewer false alarms (benchmark/comparison/REPORT.md in the rough-ride repository); quick was not measured. Treat findings as leads to check.";

// 1 CPU -> 1 lane, 2 or 3 -> 2, 4 -> 3, 5 or more -> 4 (49.3).
export function lanesFor(cpus: number): number {
  if (cpus <= 1) return 1;
  if (cpus <= 3) return 2;
  if (cpus === 4) return 3;
  return 4;
}

// Runs `jobs` at most `lanes` at a time, in order of start.
export async function inLanes<T>(lanes: number, jobs: (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await jobs[index]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(lanes, jobs.length) }, worker));
  return results;
}

export { capSection, orderNotes } from './summary.mjs';

export interface BaselineOutcome {
  flow: Flow;
  passed: boolean;
  // Two baseline runs for a flow with no reviewed version.
  runs: FlowRunResult[];
  failure: { step: number; label: string; message: string } | null;
  // sign-in: no session for a signed-in flow; bash: not started after the Bash tool's 500 s.
  skipped: 'sign-in' | 'bash' | null;
}

export interface TierContext {
  subcommand: 'quick' | 'standard';
  root: string;
  folder: FolderState;
  diff: Diff;
  info: RunnerInfo;
  browserFlag: BrowserName | null;
  start: boolean;
  argv: string[];
  env: NodeJS.ProcessEnv;
  notes: Note[];
  // Where the run reports its run folder, protected comparison and contract.
  report: RunReport;
  elapsed: () => number;
  progress: (line: string) => void;
  cpus?: number;
  // Tests replace the browser launch.
  launch?: (name: BrowserName) => Promise<Launched>;
  // The split tier (42): `plan` selects and stops; `attack` reruns setup and
  // attacks what the plan selected, in its run folder.
  mode?: 'plan' | 'attack';
  plan?: PlanState;
  // attack --plan -: the attack plan's text from stdin (45.1).
  planText?: string | null;
}

export interface TierResult {
  run: RunFolder;
  lines: string[];
  document: Record<string, unknown>;
  // record.json's fields beyond summary.json's.
  record: Record<string, unknown>;
  status: 'nothing-attacked' | 'passed' | 'findings' | 'incomplete' | 'planned';
  exitCode: 0 | 1 | 2;
}

// Origins other than the Target's own that fetch or XHR requests went to, on
// hosts the runner itself may contact: loopback and allow.remoteTarget (resolution 4).
export function apiOrigins(target: Target, results: FlowRunResult[], hosts: HostPolicy): string[] {
  const own = new URL(target.url).origin;
  const origins = new Set<string>();
  for (const r of results) {
    for (const req of r.requests) {
      if (req.resourceType !== 'fetch' && req.resourceType !== 'xhr') continue;
      try {
        const origin = new URL(req.url).origin;
        if (origin !== own && hosts.forwardable(req.url)) origins.add(origin);
      } catch {
        // Not a URL with an origin.
      }
    }
  }
  return [...origins].sort();
}

export async function runTier(ctx: TierContext): Promise<TierResult> {
  const { root, diff, info } = ctx;
  // The --base this run was given, kept in every command it says to run next.
  const givenBase = diff.base.given ? diff.base.ref : null;
  // Step 4: a writing invocation creates the folder and its .gitignore.
  const folder = ensureFolder(ctx.folder);
  // Step 5: every committed file, read once and checked before any is used.
  const files = checkCommittedFiles(folder, { info, subcommand: ctx.subcommand, argv: ctx.argv, env: ctx.env, report: ctx.report });
  ctx.notes.push(...files.notes, ...folderNotes(folder, files.flows.map((f) => f.shown.split('/').at(-1)!)));
  const nested = nestedFoldersNote(root);
  if (nested) ctx.notes.push(nested);
  // Protected files against their reviewed versions, read once before anything runs (26.9).
  const manifest = new Manifest(root);
  // plan and single tiers also read the root instruction files' merge-base
  // versions in that read (40.4), and plan its spec files' (43.1).
  const reviewed = openReviewed(root, ctx.env, !!info.pluginData);
  if (ctx.mode !== 'attack') reviewed.want(CONTRACT_FILES);
  if (ctx.mode === 'plan') reviewed.want(specCandidates(folder).paths);
  const prot = compareProtected({ root, folderDir: folder.dir, files, env: ctx.env, pluginData: !!info.pluginData, manifest, reviewed });
  ctx.report.protectedFiles(prot);
  ctx.notes.push(...prot.notes);
  // The contract status: detected here, before reset or target.start; attack carries its plan's (resolution 37).
  const contract = ctx.mode === 'attack' ? ctx.plan?.contract ?? null : detectContract(root, reviewed.atMergeBase(CONTRACT_FILES), prot.base);
  ctx.report.contract(contract);
  const acceptedList = acceptedEntries(files.accepted, prot.accepted, info.version, ctx.notes);
  // Only plan reads specs and lists changed instruction files (43.1, 43.6).
  const baseShown = prot.base?.shown ?? 'the base branch';
  const specs = ctx.mode === 'plan' ? readSpecs(folder, reviewed, baseShown) : null;
  // attack's block covers the whole run, so it repeats the plan's spec and instruction-file lines (46.5).
  const planNotes = specs ? [...specs.notes, ...instructionNotes(diff, baseShown)] : ctx.plan?.planNotes ?? [];
  ctx.notes.push(...planNotes);
  const specMeta = specs ? specs.parts.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })) : ctx.plan?.specParts ?? [];
  const extraCode = extraNodeCodeNote(process.execArgv, ctx.env.NODE_OPTIONS);
  if (extraCode) ctx.notes.push(extraCode);
  const config = prot.config;
  const flows = prot.flows.map((f) => f.flow);
  const notRun = prot.notRun;
  checkSignInEnv(flows, folder, ctx.env);

  let startedAt = '';
  let patchBytes: Buffer = Buffer.alloc(0);
  const session = await openTargetSession({
    root, folder, files, info, argv: ctx.argv, env: ctx.env, notes: ctx.notes, report: ctx.report, config, flows,
    start: ctx.start, againCommand: followUpCommand(info, { command: ctx.subcommand, base: givenBase }), browserFlag: ctx.browserFlag, ...(ctx.launch ? { launch: ctx.launch } : {}),
    elapsed: ctx.elapsed, progress: ctx.progress, noteUnfinishedRun: true, reset: true,
    run: ctx.mode === 'attack'
      ? { existing: { id: ctx.plan!.runId, dir: path.join(folder.dir, 'runs', ctx.plan!.runId) } as RunFolder, prune: true }
      : { create: ctx.mode === 'plan' ? 'plan' : ctx.subcommand },
    // The run starts with its folder, and diff.patch is written before the browser starts.
    runReady: (made) => {
      startedAt = new Date().toISOString();
      patchBytes = diffPatch(root, diff);
      writeAtomic(folder, ['runs', made.id, 'diff.patch'], patchBytes);
    },
  });
  const { target, hosts, launched, guard } = session;
  const run = session.run!;
  let signInOutcome: SignInOutcome;
  let outcomes: BaselineOutcome[] = [];
  let selection: Selection | undefined;
  let attackOutcomes: AttackOutcome[] = [];
  let groups: Group[] = [];
  const skippedLines: string[] = [];
  const holdMs = holdMsFor(S);
  let ordinalNext = 0;
  // The cut and the items it or the clock left out.
  const tierName: TierName = ctx.subcommand === 'standard' ? 'standard' : 'quick';
  let cut: CutResult | null = null;
  const cutItems: { attack: PlannedAttack; nominalMs: number; reason: 'cut' | 'time' | 'bash' | 'planned' }[] = [];
  let lanes = 1;
  let laneBackOff = false;
  const signInFailedGroups = new Set<string>();
  const fieldsNotAttacked: string[] = [];
  let tierTests: ProtectedResult['tests'] = [];
  let testsOverBudget: string[] = [];
  // plan: the Attack catalogue attack --check resolves entries against (45.3).
  let catalogueRecord: CatalogueRecord | null = null;
  const testFirst = new Map<string, FirstRun>();
  const underTestOf = new Map<Group, string>();
  const testResults: { name: string; outcome: TestOutcome; reason: string | null; failed: string[]; accepted?: string[] }[] = [];
  const timingByFlow = new Map<string, { attack: string; key: string; step: number; control: string | null; diffLinked: boolean; skipped: boolean }[]>();
  const rateLimited = new Set<string>();
  const rateLimitedLines: string[] = [];
  const meta = new Map<AttackOutcome, { ordinal: number; durationMs: number }>();
  const confirmOrdinals = new Map<string, number>();
  // attack --plan -: the parsed plan, its validation and the planned attacks that fit.
  let planParsed: ParsedPlan | null = null;
  let planResult: PlanResult | null = null;
  const plannedIds = new Set<string>();
  const plannedItems: CutResult['items'] = [];
  // App-specific checks (45.6 to 45.8): the shapes a plan carries, probed on the fresh
  // baseline runs; the checks that judge attacks; their lines and plan.json statuses.
  const earlyChecks: AppCheck[] = [];
  if (ctx.mode === 'attack' && typeof ctx.planText === 'string') {
    const early = parsePlan(ctx.planText, ctx.plan?.tier ?? 'quick');
    for (const raw of early.input?.checks ?? []) {
      const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? shapeOf(raw as Record<string, unknown>, false) : 'not a mapping';
      if (typeof c !== 'string') earlyChecks.push(c);
    }
  }
  const baselineProbes = new Map<FlowRunResult, PointProbe[]>();
  const baselineProbe = () => {
    if (earlyChecks.length === 0) return { options: {}, keep: (_: FlowRunResult) => {} };
    const probe = probeFor(earlyChecks);
    return { options: { onPoint: probe.onPoint }, keep: (r: FlowRunResult) => baselineProbes.set(r, probe.probes) };
  };
  let activeChecks: AppCheck[] = [];
  const checkLines: string[] = [];
  const checkStatus = new Map<string, { status: string; why?: string }>();
  // Split tier: the ordered list plan wrote.
  let planList: PlanState['attacks'] = [];
  const clock = createClock({ mode: ctx.mode ?? 'tier', tier: tierName, planMs: ctx.plan?.planMs, appStartMs: target.startMs, bashStop: session.bashStop });
  // attack: what the adversary added between plan and attack (44.2, 44.3).
  const savedRecords = ctx.mode === 'attack' ? readSaved(folder, ctx.plan!.runId) : [];
  const savedInRun = new Set(savedRecords.filter((r) => r.kept).map((r) => r.name));
  const linkResults = ctx.mode === 'attack' ? readLinks(folder, ctx.plan!.runId, manifest, followUpCommand(info, planAgain(ctx.plan!))).links : [];
  const bashBlocks = () => session.bashBlocks();
  try {
    clock.resetFinished(await session.reset());
    const rewritten = changedDuringRun(folder.dir, prot.texts);
    if (rewritten) ctx.notes.push(rewritten);
    const screenshot = (name: string) => async (page: Page, masks: Locator[]) => {
      const png = await page.screenshot({ mask: masks });
      writeAtomic(folder, ['runs', run.id, 'baseline', `${name}.png`], png);
    };

    const signInProbe = baselineProbe();
    signInOutcome = await session.signIn(signInProbe.options);
    clock.backendAnswered(signInOutcome.waitedMs);
    if (signInOutcome.result) signInProbe.keep(signInOutcome.result);
    const others = flows.filter((f) => f.name !== 'sign-in');
    lanes = lanesFor(ctx.cpus ?? availableParallelism());
    ctx.progress(`Baseline runs of ${others.length} saved flows`);
    outcomes = await inLanes(
      lanes,
      others.map((first) => async (): Promise<BaselineOutcome> => {
        let flow = first;
        if (flow.signedIn && !signInOutcome.passed) return { flow, passed: false, runs: [], failure: null, skipped: 'sign-in' };
        if (bashBlocks()) return { flow, passed: false, runs: [], failure: null, skipped: 'bash' };
        const effective = prot.flows.find((e) => e.flow === flow)!;
        const reviewedProbe = baselineProbe();
        const baselineRun = (f: Flow) => runFlow({
          ...reviewedProbe.options,
          ...session.defaults(f),
          flow: f,
          onFailure: screenshot(f.name),
          shots: 'all',
        });
        // Steps changed: the working copy runs only if the reviewed version fails its baseline run (26.5 rule 2).
        if (effective.stepsChanged) {
          const reviewedRun = await baselineRun(flow);
          reviewedProbe.keep(reviewedRun);
          refusedStop(reviewedRun, target.url);
          if (reviewedRun.passed) return { flow, passed: true, runs: [reviewedRun], failure: null, skipped: null };
          const entry = effective.stepsChanged.entry;
          entry.change += `; the ${prot.base?.shown ?? 'reviewed'} version fails its baseline run`;
          entry.used = 'working-tree';
          entry.outcome = 'ran this version';
          entry.weakening = false;
          effective.used = 'working-tree';
          effective.flow = effective.stepsChanged.working;
          flows[flows.indexOf(flow)] = effective.flow;
          flow = effective.flow;
        }
        // A flow flow save kept in this run already passed two baseline runs there (42.6 step 3).
        const times = effective.reviewed || savedInRun.has(flow.name) ? 1 : 2;
        const runs: FlowRunResult[] = [];
        for (let i = 0; i < times; i++) {
          if (i > 0 && bashBlocks()) return { flow, passed: false, runs, failure: null, skipped: 'bash' };
          const probe = baselineProbe();
          const result = await runFlow({
            ...probe.options,
            ...session.defaults(flow),
            flow,
            onFailure: screenshot(flow.name),
            shots: 'all',
          });
          refusedStop(result, target.url);
          probe.keep(result);
          runs.push(result);
          if (!result.passed) break;
        }
        const failed = runs.find((r) => !r.passed);
        return {
          flow,
          passed: !failed,
          runs,
          failure: failed?.failure ?? (failed?.excluded ? { step: failed.steps.length + 1, label: 'goto', message: `visits an excluded page (${failed.excluded})` } : null),
          skipped: null,
        };
      }),
    );
    const bashSkipped = outcomes.filter((o) => o.skipped === 'bash').length;
    if (bashSkipped > 0) ctx.notes.push({ id: 'budget', text: `Over the ${ctx.subcommand} budget (Bash time limit): ${bashSkipped} saved ${bashSkipped === 1 ? 'flow' : 'flows'} not run, because no flow run starts after 500 s in a session.` });
    // Reach: footprints against the diff, while the dev server still runs.
    ctx.progress('Tracing what the flows reach');
    selection = await select({
      baseURL: target.url,
      root,
      nuxtRoot: target.nuxtRoot?.rel ?? null,
      noProvenRoot: target.proof === 'config' && target.nuxtRoot === null,
      hosts,
      diff,
      flows: [
        ...(signInOutcome.result ? [{ flow: flows.find((f) => f.name === 'sign-in')!, passed: signInOutcome.passed, excluded: signInOutcome.result.excluded !== null, runs: [signInOutcome.result] }] : []),
        ...outcomes.filter((o) => o.skipped === null).map((o) => ({ flow: o.flow, passed: o.passed, excluded: o.runs.some((r) => r.excluded !== null), runs: o.runs })),
      ],
      signIn: !signInOutcome.ran ? 'none' : signInOutcome.passed ? 'passed' : 'failed',
      attacks: [],
      attacksBuilt: false,
      tier: ctx.subcommand,
    });

    // Attacks: flow by flow in selection order, the sign-in flow's last (17.7).
    const sel0 = selection;
    const ownHost = hosts.ownHost;
    const changedFiles = new Set(diff.files.map((f) => f.path));
    const runsOf = (name: string) => (name === 'sign-in' ? (signInOutcome.result ? [signInOutcome.result] : []) : outcomes.find((o) => o.flow.name === name)?.runs ?? []);
    // attack: flows kept in this run go after every saved flow, so planned attacks keep
    // the dedupe and field ownership; a kept flow that only visits its linked page
    // joins here even though no rule reached a changed file through it (42.6 step 4).
    const addedFlows = new Set(ctx.mode === 'attack' ? [...savedInRun].filter((n) => !ctx.plan!.attacks.some((p) => p.attack.flow === n) && flows.some((f) => f.name === n)) : []);
    const orderedNames = [
      ...sel0.ordered.map((o) => o.name).filter((n) => n !== 'sign-in' && !addedFlows.has(n)),
      ...[...addedFlows].filter((n) => n !== 'sign-in'),
      ...sel0.ordered.filter((o) => o.name === 'sign-in').map((o) => o.name),
    ];
    const firstLoadOf = (name: string) => {
      const info = sel0.flowInfo.find((f) => f.name === name);
      const loads = [...(info?.firstLoad ?? new Map<string, number>())].filter(([file]) => changedFiles.has(file)).map(([, st]) => st);
      return loads.length > 0 ? Math.min(...loads) : null;
    };
    const catalogue = buildCatalogue({
      tier: tierName,
      flows: [...orderedNames, ...flows.map((f) => f.name).filter((n) => !orderedNames.includes(n))].map((name) => {
        const info = sel0.flowInfo.find((f) => f.name === name);
        return {
          flow: flows.find((f) => f.name === name)!,
          runs: runsOf(name),
          passed: !!(name === 'sign-in' ? signInOutcome.passed : outcomes.find((o) => o.flow.name === name)?.passed),
          reached: orderedNames.includes(name) && !!info,
          forms: sel0.formsByFlow.get(name) ?? [],
          firstLoad: firstLoadOf(name),
          reachesByRule: info?.reachesByRule ?? false,
        };
      }),
      changedEndpoints: sel0.changedEndpoints,
      docs: sel0.docs,
      hosts,
      noCredential: session.credentials.length === 0 && (signInOutcome.storageState?.cookies ?? []).filter((c) => ownHost(`http://${c.domain.replace(/^\./, '')}/`)).length === 0,
      today: new Date(),
    });
    skippedLines.push(...catalogue.skipped);
    fieldsNotAttacked.push(...catalogue.fieldsNotAttacked);
    const planned = [...catalogue.share];

    // The ordered list (48.3), the dedupe (48.5), then the cut by nominal time (48.7).
    const spec = TIER_TABLE.tiers[tierName];
    const flowOf = (name: string) => flows.find((f) => f.name === name)!;
    // Changed files a flow had loaded at or before a step: the dedupe's file condition.
    const loadedBy = (name: string, step: number) => {
      const info = sel0.flowInfo.find((f) => f.name === name);
      return new Set([...(info?.firstLoad ?? new Map<string, number>())].filter(([file, at]) => changedFiles.has(file) && at <= step).map(([file]) => file));
    };
    const covers = (kept: PlannedAttack, dup: PlannedAttack) => [...loadedBy(dup.flow, dup.step)].every((f) => loadedBy(kept.flow, kept.step).has(f));
    const faultSeen = new Map<string, PlannedAttack>();
    const viewportSeen: { attack: PlannedAttack; pages: Set<string> }[] = [];
    const seen = new Set<string>();
    const timingSeen = new Map<string, string>();
    const list: PlannedAttack[] = [];
    for (const attack of orderedList(orderedNames, planned)) {
      if (seen.has(attack.id)) continue;
      seen.add(attack.id);
      if (attack.kind === 'timing') {
        const first = timingSeen.get(timingDedupeKey(attack));
        const entry = { attack: attack.id, key: attack.key, step: attack.step, control: attack.controlName ?? null, diffLinked: attack.diffLinked, skipped: !!first };
        timingByFlow.set(attack.flow, [...(timingByFlow.get(attack.flow) ?? []), entry]);
        if (first) {
          skippedLines.push(`Skipped: ${attack.id} (same attack as ${first})`);
          continue;
        }
        timingSeen.set(timingDedupeKey(attack), attack.id);
      }
      if (attack.kind === 'fault') {
        // {fault, sticky, page template when sent, judged step kind, action}.
        const q = runsOf(attack.flow)[0]?.requests.find((r) => r.step === attack.step && r.key === attack.key);
        const s0 = flowOf(attack.flow).steps[attack.step - 1];
        const key = [attack.fault, attack.sticky, q?.pagePath ?? '', s0 ? stepKind(s0) : '', attack.template].join('|');
        const kept = faultSeen.get(key);
        if (kept && covers(kept, attack)) {
          skippedLines.push(`Skipped: ${attack.id} (same attack as ${kept.id})`);
          continue;
        }
        if (!kept) faultSeen.set(key, attack);
      }
      if (attack.kind === 'viewport') {
        const pages = new Set((runsOf(attack.flow)[0]?.pages ?? []).map((p) => p.path));
        const covered = viewportSeen.find((v) => [...pages].every((p) => v.pages.has(p)) && covers(v.attack, attack));
        if (covered && pages.size > 0) {
          skippedLines.push(`Skipped: ${attack.id} (same attack as ${covered.attack.id})`);
          continue;
        }
        viewportSeen.push({ attack, pages });
      }
      list.push(attack);
    }
    const nominalOf = (a: PlannedAttack) => attackNominalMs(a, flowOf(a.flow), runsOf(a.flow)[0]);
    const signInFlow = flows.find((f) => f.name === 'sign-in');
    cut = computeCut({
      tier: tierName,
      list,
      nominal: nominalOf,
      signInNominalMs: signInFlow ? flowNominalMs(signInFlow, signInOutcome.result ?? undefined) : 0,
      baselineNominalMs: outcomes.flatMap((o) => o.runs.map(() => flowNominalMs(o.flow, o.runs[0]))),
      tableSha256: tierTableSha256(),
    });
    // attack: the plan's ordered list and cut stand; fresh points stand in for the
    // planned ones, and a planned point the fresh run lacks never fires (42.6 step 4).
    const neverFired = new Set<string>();
    if (ctx.mode === 'attack' && ctx.plan) {
      const fresh = new Map(list.map((a) => [a.id, a]));
      const planned = new Map(ctx.plan.attacks.map((p) => [p.attack.id, p]));
      for (const p of ctx.plan.attacks) if (p.aboveCut && !fresh.has(p.attack.id)) neverFired.add(p.attack.id);
      if (addedFlows.size === 0) {
        cut = { ...cut, items: ctx.plan.attacks.map((p) => ({ attack: fresh.get(p.attack.id) ?? p.attack, nominalMs: p.nominalMs, aboveCut: p.aboveCut })) };
      } else {
        // New flows join in selection order; the recomputed cut can push a planned
        // attack out but never pull a cut one back in (42.6 step 4).
        // The plan's schedule stands, missing points and failed flows included; new flows' attacks follow.
        const combined = [...ctx.plan.attacks.map((p) => fresh.get(p.attack.id) ?? p.attack), ...list.filter((a) => addedFlows.has(a.flow) && !planned.has(a.id))];
        const recut = computeCut({
          tier: tierName,
          list: combined,
          nominal: (a) => planned.get(a.id)?.nominalMs ?? nominalOf(a),
          signInNominalMs: signInFlow ? flowNominalMs(signInFlow, signInOutcome.result ?? undefined) : 0,
          baselineNominalMs: outcomes.flatMap((o) => o.runs.map(() => flowNominalMs(o.flow, o.runs[0]))),
          tableSha256: tierTableSha256(),
        });
        cut = { ...cut, items: recut.items.map((x) => ({ ...x, aboveCut: x.aboveCut && (planned.get(x.attack.id)?.aboveCut ?? true) })) };
      }
    }
    planList = cut.items.map((x) => ({ attack: x.attack, nominalMs: x.nominalMs, aboveCut: x.aboveCut }));
    for (const item of cut.items.filter((x) => !x.aboveCut)) cutItems.push({ attack: item.attack, nominalMs: item.nominalMs, reason: 'cut' });

    // Regression tests (48.4): open tests by name, then tests whose flow the diff
    // reaches, in flow order; capped per tier. Known before plan validation, because
    // a flow with a test inside the cut is above it (45.5).
    const openNames = new Set(Object.entries(manifest.data.tests).filter(([, t]) => t.outcome !== 'pass').map(([n]) => n));
    const reachedOrder = sel0.ordered.map((o) => o.name);
    const eligible = prot.tests.filter((t) => openNames.has(t.name) || reachedOrder.includes(String(t.value.flow)));
    const orderedTests = [
      ...eligible.filter((t) => openNames.has(t.name)).sort((a, b) => cmp(a.name, b.name)),
      ...eligible.filter((t) => !openNames.has(t.name)).sort((a, b) => reachedOrder.indexOf(String(a.value.flow)) - reachedOrder.indexOf(String(b.value.flow)) || cmp(a.name, b.name)),
    ];
    const testFlows = orderedTests.slice(0, spec.tests).map((t) => String(t.value.flow));
    if (ctx.mode === 'plan') {
      const above = cut.items.filter((x) => x.aboveCut);
      catalogueRecord = toRecord(catalogue, { selected: above.map((x) => x.attack.id), aboveFlows: [...above.map((x) => x.attack.flow), ...testFlows] });
    }

    // attack --plan -: validated against these fresh footprints; it can only add (45.2, 45.4, 45.5).
    if (ctx.mode === 'attack' && typeof ctx.planText === 'string') {
      planParsed = parsePlan(ctx.planText, tierName);
      if (planParsed.refused === null) {
        const selectedAbove = cut.items.filter((x) => x.aboveCut);
        const aboveFlows = new Set([...selectedAbove.map((x) => x.attack.flow), ...testFlows, ...addedFlows]);
        planResult = validatePlan(planParsed.input!, {
          ...planCandidates(catalogue, { selected: selectedAbove.map((x) => x.attack.id), aboveFlows }),
          // App-specific checks against the spec read again and these fresh baseline runs (45.8).
          checks: {
            specs: specFacts(folder, ctx.plan?.specParts ?? []),
            flows: new Set(flows.map((f) => f.name)),
            footprint: (name) => {
              const flow = flows.find((f) => f.name === name);
              const runs = runsOf(name);
              if (!flow || runs.length === 0) return null;
              const action = flow.steps.filter((st) => !('goto' in st) && !('expect' in st));
              return {
                paths: [...new Set(runs.flatMap((r) => [...r.pages.map((pg) => pg.path), ...r.steps.map((st) => st.path).filter((x): x is string => x !== null)]))],
                requests: [...new Set(runs.flatMap((r) => r.requests.filter((q) => (q.resourceType === 'fetch' || q.resourceType === 'xhr') && ownHost(q.url)).map((q) => q.key)))],
                steps: action.map((st) => (st as Record<string, LocatorSpec>)[stepKind(st)]!),
                fills: flow.steps.filter((st) => 'value' in st).map((st) => (st as { value: string }).value),
              };
            },
            apiKeys: [...new Set(sel0.docs.flatMap((d) => Object.entries(d.doc.paths ?? {}).flatMap(([p, ops]) => Object.keys(ops).filter((m) => /^(get|put|post|delete|patch|head|options)$/.test(m)).map((m) => `${m.toUpperCase()} ${p.replace(/\{[^}]*\}/g, '{}')}`))))],
            baseline: (name) => {
              const runs = runsOf(name);
              if (runs.length === 0) return null;
              return {
                lines: runs.flatMap((r) => r.steps.flatMap((st) => st.observation ? [...st.observation.before.lines, ...st.observation.samples.flatMap((x) => [...x.lines, ...x.live]), ...st.observation.after.lines, ...st.observation.after.live] : [])),
                withinMatched: (loc) => runs.some((r) => (baselineProbes.get(r) ?? []).some((pr) => (pr.within[describeLocator(loc)] ?? []).length > 0)),
              };
            },
          },
        });
        for (const e of planResult.checks) if (e.id && /^app-/.test(e.id)) checkStatus.set(e.id, { status: e.status, ...(e.why ? { why: e.why } : {}) });
        // 45.8 gate 6: end and every-step checks must pass on the flow's fresh baseline run.
        for (const c of planResult.appChecks) {
          const r = runsOf(c.flow!)[0];
          const line = r ? baselineGate(c, r, baselineProbes.get(r) ?? [], ownHost) : null;
          if (line) {
            checkLines.push(line);
            checkStatus.set(c.id, { status: 'fails-with-no-attack', why: line.slice(line.indexOf(': ', line.indexOf('fails with no attack')) + 2) });
          } else activeChecks.push(c);
        }
        const fits = cutPlanned(selectedAbove.map((x) => ({ flow: x.attack.flow, nominalMs: x.nominalMs })), planResult.kept.map((a) => ({ flow: a.flow, nominalMs: nominalOf(a) })), cut.windowMs);
        for (const [i, a] of planResult.kept.entries()) {
          plannedIds.add(a.id);
          if (fits[i]) plannedItems.push({ attack: a, nominalMs: nominalOf(a), aboveCut: true });
          else cutItems.push({ attack: a, nominalMs: nominalOf(a), reason: 'planned' });
        }
      }
    }

    clock.selectionEnded();
    if (ctx.mode !== 'plan') {
      // The run-time clock (50.1 to 50.4): it only stops starts, never adds an attack.
      const hardStopAt = clock.hardStopAt();
      const speedOf = (name: string) => {
        const r = runsOf(name)[0];
        const nominal = flowNominalMs(flowOf(name), r);
        return r && nominal > 0 ? Math.max(0.25, r.durationMs / nominal) : 1;
      };
      const failedDurations: number[] = [];
      let heldMs = 0;
      let signInReserve = () => 0;
      const flowPassed = (name: string) => (name === 'sign-in' ? signInOutcome.passed : outcomes.find((o) => o.flow.name === name)?.passed ?? false);
      let stopReason: 'time' | 'bash' | null = null;
      // Lanes (49.3): attacks run in the lanes in list order; the sign-in segment
      // starts once the lanes drain. After the second `target unstable` void the
      // lanes drop to one for the rest of the invocation.
      let unstable = outcomes.flatMap((o) => o.runs).filter((r) => r.voided === 'target unstable').length;
      const lanesNow = () => (unstable >= 2 ? 1 : lanes);
      // attacks.jsonl: rewritten whole and atomically after each result, never appended to.
      const writeAttacks = () => {
        const byOrdinal = [...attackOutcomes].sort((a, b) => meta.get(a)!.ordinal - meta.get(b)!.ordinal);
        writeAtomic(folder, ['runs', run.id, 'attacks.jsonl'], byOrdinal.map((o) => JSON.stringify({ ...attackRecord(o, meta.get(o)!), planned: plannedIds.has(o.id) })).join('\n') + '\n');
      };
      const runOne = async (item: CutResult['items'][number]) => {
        const attack = item.attack;
        const flow = flowOf(attack.flow);
        // The repro id is the attack's ordinal, assigned when it starts (38).
        const ordinal = ++ordinalNext;
        ctx.progress(`Attack ${attack.id}`);
        const started = Date.now();
        const outcome = await runAttack(attack, flow, runsOf(attack.flow)[0]!, { ...session.defaults(flow), deadline: hardStopAt }, sel0.docs, activeChecks);
        attackOutcomes.push(outcome);
        meta.set(outcome, { ordinal, durationMs: Date.now() - started });
        if (outcome.voided === 'target unstable') unstable++;
        if (outcome.verdict === 'failed') failedDurations.push(Date.now() - started);
        if (outcome.badInput && outcome.verdict === 'inconclusive' && outcome.run.badInput?.carrying?.status === 429) {
          const formKey = `${outcome.badInput.formName}|${outcome.badInput.page}`;
          if (!rateLimited.has(formKey)) {
            rateLimited.add(formKey);
            rateLimitedLines.push(`Not attacked further: ${outcome.badInput.formName} on ${outcome.badInput.page} (rate limited)`);
          }
        }
        if (outcome.verdict === 'failed') {
          // The repro record's hash goes into the manifest in the same step as its write (14.2).
          const record = writeRepro(folder, run.id, info.version, outcome, ordinal, flow, runsOf(attack.flow)[0]!, holdMs, symptomOf(outcome));
          manifest.recordRun(run.id, `repros/${reproId(ordinal)}.json`, record);
        }
        writeAttacks();
      };
      // Starts items in order while a lane is free; the clock decides each start (50.2).
      const runInLanes = (items: CutResult['items']) => new Promise<void>((resolve) => {
        let next = 0;
        let active = 0;
        const pump = () => {
          while (active < lanesNow() && next < items.length) {
            const item = items[next++]!;
            const attack = item.attack;
            // After a 429, a form gets no more bad inputs this invocation.
            if (attack.badInput && rateLimited.has(`${attack.badInput.formName}|${attack.badInput.page}`)) continue;
            // A flow above the cut that fails its fresh baseline run is not
            // attacked, and its attacks keep their time (42.6 step 3).
            if (ctx.mode === 'attack' && !flowPassed(attack.flow)) {
              heldMs += item.nominalMs;
              continue;
            }
            if (neverFired.has(attack.id)) {
              const ordinal = ++ordinalNext;
              const stub: AttackOutcome = { ...attack, verdict: 'fault-never-fired', checks: [], page: attack.page ?? null, control: '', events: [], voided: null, served: null, notApplied: null, givenUp: false, run: runsOf(attack.flow)[0]! };
              attackOutcomes.push(stub);
              meta.set(stub, { ordinal, durationMs: 0 });
              writeAttacks();
              continue;
            }
            const need = heldMs + item.nominalMs * speedOf(attack.flow);
            // A planned attack starts only if the sign-in segment's selected work still fits (45.5).
            if (plannedIds.has(attack.id)) {
              if (stopReason !== null || bashBlocks() || !clock.startFits(need + signInReserve(), reserveMs(failedDurations, tierName))) {
                cutItems.push({ attack, nominalMs: item.nominalMs, reason: 'planned' });
                continue;
              }
              active++;
              void runOne(item).finally(() => {
                active--;
                pump();
              });
              continue;
            }
            if (stopReason === null && bashBlocks()) stopReason = 'bash';
            if (stopReason === null && !clock.startFits(need, reserveMs(failedDurations, tierName))) stopReason = 'time';
            if (stopReason !== null) {
              cutItems.push({ attack, nominalMs: item.nominalMs, reason: stopReason });
              continue;
            }
            active++;
            void runOne(item).finally(() => {
              active--;
              pump();
            });
          }
          if (active === 0 && next >= items.length) resolve();
        };
        pump();
      });
      // First runs go ahead of the attacks.
      tierTests = orderedTests.slice(0, spec.tests);
      testsOverBudget = orderedTests.slice(spec.tests).map((t) => t.name);
      const attackBase = (flow: Flow) => ({ ...session.defaults(flow), deadline: hardStopAt });
      const runTest = async (t: (typeof tierTests)[number]) => {
        if (bashBlocks()) {
          testFirst.set(t.name, { judgement: null, stale: 'stopped by the Bash time limit', pass: null, attack: null, outcome: null });
          return;
        }
        const flow = flows.find((f) => f.name === t.value.flow);
        const baseline = flow ? runsOf(flow.name)[0] : undefined;
        if (!flow || !baseline || !(flow.name === 'sign-in' ? signInOutcome.passed : outcomes.find((o) => o.flow.name === flow.name)?.passed)) {
          testFirst.set(t.name, { judgement: null, stale: flow ? `${flow.name} failed its baseline run` : `flow ${String(t.value.flow)} is missing or invalid`, pass: null, attack: null, outcome: null });
          return;
        }
        testFirst.set(t.name, await runTestOnce(t.value as unknown as TestValue, flow, baseline, sel0.docs, attackBase(flow)));
      };
      await inLanes(lanesNow(), tierTests.filter((t) => t.value.flow !== 'sign-in').map((t) => () => runTest(t)));
      const above = cut.items.filter((x) => x.aboveCut);
      let signInStarted = false;
      signInReserve = () => (signInStarted ? 0 : above.filter((x) => x.attack.flow === 'sign-in').reduce((n, x) => n + x.nominalMs, 0));
      await runInLanes(above.filter((x) => x.attack.flow !== 'sign-in'));
      // Planned attacks on other flows, after every selected one (42.6 step 7).
      await runInLanes(plannedItems.filter((x) => x.attack.flow !== 'sign-in'));
      // The sign-in segment: its tests, then its selected attacks, then its planned ones.
      signInStarted = true;
      await inLanes(lanesNow(), tierTests.filter((t) => t.value.flow === 'sign-in').map((t) => () => runTest(t)));
      await runInLanes(above.filter((x) => x.attack.flow === 'sign-in'));
      await runInLanes(plannedItems.filter((x) => x.attack.flow === 'sign-in'));
      if (unstable >= 2) laneBackOff = true;
      // Lanes finish in any order; everything downstream reads attacks by ordinal.
      attackOutcomes.sort((a, b) => meta.get(a)!.ordinal - meta.get(b)!.ordinal);

      // The session refresh (49.5 step 8): when any flow run on the sign-in flow
      // ran after the shared session was made, one more sign-in, alone.
      let refreshFailed = false;
      if (attackOutcomes.some((o) => o.flow === 'sign-in') && signInOutcome.ran && bashBlocks()) refreshFailed = true;
      else if (attackOutcomes.some((o) => o.flow === 'sign-in') && signInOutcome.ran) {
        ctx.progress('Refreshing the session');
        if (!(await session.refreshSignIn(hardStopAt))) refreshFailed = true;
      }

      // Tests that didn't pass get their second run alone, before any confirmation (49.5).
      for (const t of tierTests) {
        const f = testFirst.get(t.name);
        const value = t.value as unknown as TestValue;
        if (!f) continue;
        if (f.stale || f.pass) {
          testResults.push({ name: t.name, outcome: f.pass ? 'pass' : 'stale', reason: f.pass ?? f.stale, failed: [] });
          continue;
        }
        let second: RunJudgement | null = null;
        if (f.judgement!.state !== 'pass' && f.attack) {
          const flow = flows.find((x) => x.name === value.flow)!;
          second = bashBlocks() ? { state: 'stale', reason: 'stopped by the Bash time limit', failed: [], alsoFailed: [] }
            : refreshFailed && flow.signedIn ? { state: 'stale', reason: 'sign-in failed', failed: [], alsoFailed: [] }
            : judgeRun(value.checks, await runAttack(f.attack, flow, runsOf(flow.name)[0]!, { ...attackBase(flow), ...(f.pin ? { pin: f.pin } : {}) }, sel0.docs, inlineChecks(value.checks)));
        }
        const outcome = combine(f.judgement!, second);
        const failed = [...new Set([...f.judgement!.failed, ...(second?.failed ?? [])])];
        testResults.push({ name: t.name, outcome, reason: outcome === 'stale' ? (f.judgement!.reason ?? second?.reason ?? null) : outcome === 'flaky' ? 'passed once, failed once' : f.judgement!.reason, failed, accepted: testAcceptedNotes(acceptedList, f.outcome, flows.find((x) => x.name === value.flow), failed) });
      }

      // Accepted checks leave before grouping and severity (36).
      for (const o of attackOutcomes) {
        const flow = flows.find((f) => f.name === o.flow);
        if (flow) applyAccepted(o, flow, acceptedList);
      }
      // Finding groups, ranked once, then confirmed alone down the list (34, 35).
      const tokens = new Map(attackOutcomes.map((o) => [o.run.unique, o.id]));
      const members = attackOutcomes
        .filter((o) => o.verdict === 'failed')
        .map((o) => memberOf(o, flows.find((f) => f.name === o.flow)!, tokens))
        .filter((m): m is NonNullable<typeof m> => m !== null);
      groups = groupFindings(members, { flowClass: (name) => sel0.ordered.find((o) => o.name === name)?.cls ?? null });
      // A group repeating a test that failed in this invocation is under-test: no slot, no confirmation (35).
      const failedTestKeys = new Map(tierTests
        .filter((t) => testResults.some((r) => r.name === t.name && r.outcome === 'fail'))
        .map((t) => [`${String(t.value.flow)}|${canonicalJson(t.value.attack)}`, t.name]));
      for (const g of groups) {
        const hit = g.members.map((m) => failedTestKeys.get(`${m.outcome.flow}|${canonicalJson(attackKey(m.outcome))}`)).find(Boolean);
        if (hit) {
          g.state = 'under-test';
          underTestOf.set(g, hit);
        }
      }
      if (groups.length > 0) ctx.progress(`Confirming ${groups.length} finding ${groups.length === 1 ? 'group' : 'groups'}`);
      // Closing runs start only if t + est <= limit + G (50.3); est is the representative's measured duration.
      // A failed refresh leaves signed-in groups unchecked (sign-in failed before confirmation).
      const canConfirm = (o: AttackOutcome) => {
        if (bashBlocks()) return false;
        if (refreshFailed && flowOf(o.flow).signedIn) {
          signInFailedGroups.add(o.id);
          return false;
        }
        return clock.closingFits(meta.get(o)?.durationMs ?? 0);
      };
      await confirmGroups(groups, tierName, async (o) => {
        const flow = flows.find((f) => f.name === o.flow)!;
        const ordinal = ++ordinalNext;
        confirmOrdinals.set(o.id, ordinal);
        const again = await runAttack(o, flow, runsOf(o.flow)[0]!, { ...session.defaults(flow), deadline: hardStopAt }, sel0.docs, activeChecks);
        applyAccepted(again, flow, acceptedList);
        return again;
      }, canConfirm);
    }
  } catch (error) {
    throw session.withRun(error);
  } finally {
    await session.close();
  }
  const tracing = selection!.tracing;
  // findTarget already noted a config target with no proven Nuxt root.
  ctx.notes.push(...tracing.notes.filter((n) => !ctx.notes.some((m) => m.text === n.text)));
  // 45.7: a check that no attack matched is never a pass.
  for (const c of activeChecks) {
    const results = attackOutcomes.flatMap((o) => o.checks.filter((x) => x.id === c.id && x.app));
    if (results.length === 0) {
      checkLines.push(`App-specific check ${c.id}: not evaluated (no attack matched)`);
      checkStatus.set(c.id, { status: 'not-evaluated', why: 'no attack matched' });
    } else {
      const n = (r: string) => results.filter((x) => x.result === r).length;
      checkStatus.set(c.id, { status: 'evaluated', why: `${n('fail')} failed, ${n('pass')} passed, ${n('not-evaluated')} not evaluated` });
    }
  }
  // The accounting again, now with real attacks (18.2).
  const repo = repoFiles(root);
  const loadedBy = (o: AttackOutcome) => [...new Set(o.run.requests.flatMap((q) => moduleFiles(q.url, repo, root, target.nuxtRoot?.rel ?? null).files))];
  if (attackOutcomes.length > 0 || selection!.ordered.length > 0) {
    selection!.accounting = account({
      files: diff.files,
      endpoints: selection!.backend.endpoints,
      untraced: selection!.backend.untraced,
      flows: selection!.flowInfo,
      signIn: !signInOutcome!.ran ? 'none' : signInOutcome!.passed ? 'passed' : 'failed',
      modulesOn: tracing.modules,
      attacks: attackOutcomes.map((o) => attackLink(o, loadedBy(o))),
      cutAttacks: cutItems.map((c) => ({
        ...attackLink({ ...c.attack, verdict: 'passed', page: c.attack.page ?? null }, []),
        qualifier: c.reason === 'cut' ? '' : c.reason === 'bash' ? ' (Bash time limit)' : ` (${c.reason})`,
      })),
      attacksBuilt: true,
      tier: ctx.subcommand,
    });
  }
  const budgetNote = clock.budgetNote({
    clockCut: cutItems.filter((c) => c.reason === 'time' || c.reason === 'bash').length,
    unconfirmed: groups.filter((g) => g.state === 'unchecked').length,
    flows: outcomes.length,
  });
  if (budgetNote) ctx.notes.push({ id: 'budget', text: budgetNote });
  const voidCounts = new Map<string, number>();
  for (const o of attackOutcomes) if (o.voided) voidCounts.set(o.voided, (voidCounts.get(o.voided) ?? 0) + 1);
  for (const [why, n] of voidCounts) {
    const backOff = why === 'target unstable' && laneBackOff && lanes > 1 ? '; flow runs went one at a time from then on' : '';
    ctx.notes.push({ id: 'void-runs', text: `${why} during ${n} flow runs${backOff}` });
  }

  const via = reachedVia(tracing, diff.files);
  const sel = selection!;
  const entryOf = (kind: 'file' | 'endpoint', file: string, endpoint: string | null) =>
    sel.accounting.entries.find((e) => e.kind === kind && e.file === file && e.endpoint === endpoint);
  const flowEntries = tracing.reach.map((r) => {
    const runs = r.flow === 'sign-in' ? (signInOutcome!.result ? [signInOutcome!.result] : []) : (outcomes.find((o) => o.flow.name === r.flow)?.runs ?? []);
    return {
      name: r.flow,
      passed: r.passed,
      durationMs: runs.reduce((n, x) => n + x.durationMs, 0),
      baselineRuns: runs.length,
      reaches: diff.files.filter((f) => (via.get(f.path) ?? []).some((v) => v.flow === r.flow)).map((f) => f.path),
      class: sel.ordered.find((o) => o.name === r.flow)?.cls ?? null,
      pages: mergePages(runs),
      requests: runs[0]?.requests.filter((q) => q.resourceType === 'fetch' || q.resourceType === 'xhr')
        .map((q) => ({ key: q.key, step: q.step, diffLinked: sel.changedEndpoints.has(q.key.replace(/ #\d+$/, '')) })) ?? [],
      forms: (sel.formsByFlow.get(r.flow) ?? []).map((f) => ({ steps: f.steps, submitStep: f.submitStep, carrying: f.carrying, diffLinked: f.diffLinked })),
      timing: timingByFlow.get(r.flow) ?? [],
    };
  });
  const lines_ = notAttackedLines(sel.accounting.entries);
  // A failed test is a finding; a flaky or stale one, with nothing else exiting 1, is incomplete (25.8).
  const testFailed = testResults.some((r) => r.outcome === 'fail');
  const testIncomplete = testResults.some((r) => r.outcome === 'flaky' || r.outcome === 'stale');
  const status: TierResult['status'] = ctx.mode === 'plan' ? 'planned'
    : groups.some((g) => g.state === 'shown') || testFailed ? 'findings'
    // A refused plan never stops the invocation, and its exit code is at least 2 (45.2).
    : testIncomplete || planParsed?.refused ? 'incomplete'
    : attackOutcomes.length === 0 ? 'nothing-attacked' : 'passed';
  for (const r of testResults) manifest.data.tests[r.name] = { outcome: r.outcome, run: run.id, at: startedAt };
  // A cut never changes the exit code; groups left unchecked with none shown exit 2 (50.6).
  const exitCode: TierResult['exitCode'] = status === 'findings' ? 1 : status === 'incomplete' || groups.some((g) => g.state === 'unchecked') ? 2 : 0;
  const map = diffMap(diff, startedAt) as Record<string, unknown>;
  const adversaryCallsMs = ctx.mode === 'attack' ? adversaryCallTime(folder, run.id) : 0;
  map.tracing = { modules: tracing.modules, pages: tracing.pages, openapi: sel.docs.map((d) => d.url) };
  map.files = (map.files as { path: string }[]).map((f) => {
    const e = entryOf('file', f.path, null);
    return { ...f, via: via.get(f.path) ?? [], ...(e ? { state: e.state, reason: e.reason } : {}) };
  });
  map.endpoints = sel.backend.endpoints.map((e) => {
    const entry = entryOf('endpoint', e.file, e.endpoint);
    return { ...e, state: entry?.state ?? null, reason: entry?.reason ?? null, fullLoad: sel.accounting.fullLoad.filter((q) => q.endpoint === e.endpoint).map(({ line: _line, ...q }) => q) };
  });
  map.flows = flowEntries.map((f) => ({
    ...f,
    attacks: (cut?.items ?? []).filter((x) => x.attack.flow === f.name).map((x) => ({ id: x.attack.id, band: bandOf(x.attack.rank), rank: x.attack.rank, nominalMs: x.nominalMs, aboveCut: x.aboveCut })),
  }));
  map.budget = { nominalPlanMs: cut?.nominalPlanMs ?? null, windowMs: cut?.windowMs ?? null };
  map.selectionDigest = cut?.selectionDigest ?? null;
  map.order = sel.ordered.map((o) => o.name);
  map.meta = { planMs: clock.planMs() };
  // attack: plan.json, so a run can be replayed outside Claude Code (45.10).
  if (ctx.mode === 'attack' && ctx.plan) {
    const flowHash = (name: string) => {
      const f = files.flows.find((x) => x.shown === `.rough-ride/flows/${name}.yaml`);
      return f ? createHash('sha256').update(f.text).digest('hex') : null;
    };
    const attacked = [...new Set(attackOutcomes.map((o) => o.flow))].sort();
    const planFile = {
      schema: FORMATS.plan.current,
      run: run.id,
      tier: tierName,
      runner: info.version,
      base: { ref: diff.base.ref, sha: diff.base.sha },
      digest: diff.digest,
      spec: specMeta,
      flows: Object.fromEntries(attacked.flatMap((n) => (flowHash(n) ? [[n, flowHash(n)!]] : []))),
      links: {
        input: linkResults.map((l) => l.input).filter((x) => x && typeof x === 'object'),
        accepted: linkResults.filter((l) => l.accepted).map((l) => l.input),
        rejected: linkResults.filter((l) => !l.accepted && l.input && typeof l.input === 'object').map((l) => l.input),
      },
      flowSaves: savedRecords.filter((r) => r.file).map((r) => ({ name: r.name, item: { file: r.file!, ...(r.page ? { page: r.page } : {}) }, outcome: r.kept ? 'kept' : r.page ? 'no passing flow' : 'does not reach it' })),
      input: planParsed?.input ?? {},
      entries: [
        ...(planResult?.entries ?? []).map((e) => ({ path: e.path, status: e.status, attackIds: e.attackIds, ...(e.why ? { why: e.why } : {}) })),
        // A check rejected before it had a usable id is listed by its path.
        ...(planResult?.checks ?? []).filter((e) => !e.id || !/^app-[a-z0-9][a-z0-9-]{0,39}$/.test(e.id)).map((e) => ({ path: e.path, status: e.status, ...(e.why ? { why: e.why } : {}) })),
      ],
      checks: [...checkStatus].map(([id, st]) => ({ id, ...st })),
      noFlow: planResult?.noFlow ?? [],
    };
    writeAtomic(folder, ['runs', run.id, 'plan.json'], canonicalJson(planFile));
    manifest.recordRun(run.id, 'plan.json', JSON.parse(redactSecrets(canonicalJson(planFile))));
  }
  // plan: the selection attack reads back, hashed in the manifest as it is written (42.2, 27.2).
  if (ctx.mode === 'plan') {
    const aboveFlows = new Set(planList.filter((x) => x.aboveCut).map((x) => x.attack.flow));
    const spec = TIER_TABLE.tiers[tierName];
    // 43.3's outline for the adversary, plus what attack reads back.
    const above = planList.filter((x) => x.aboveCut);
    const appliesOf = (flow: string, key: string) => [...new Set(planList.filter((x) => x.attack.flow === flow && x.attack.key === key && x.attack.fault).map((x) => `${x.attack.fault}${x.attack.sticky ? '!' : ''}`))];
    const formsOf = (flow: string) => {
      const forms = new Map<string, Map<string, { field: string; kind: string; inputs: string[] }>>();
      for (const x of planList.filter((y) => y.attack.flow === flow && y.attack.badInput)) {
        const b = x.attack.badInput!;
        const fields = forms.get(b.formName) ?? new Map();
        const f = fields.get(b.fieldKey) ?? { field: b.field.name, kind: b.field.kind, inputs: [] };
        if (!f.inputs.includes(b.inputId)) f.inputs.push(b.inputId);
        fields.set(b.fieldKey, f);
        forms.set(b.formName, fields);
      }
      return [...forms].map(([form, fields]) => ({ form, fields: [...fields.values()] }));
    };
    const reachedFiles = new Set(tracing.reach.flatMap((r) => [...r.via.keys()]));
    const needsFlow = needsFlowItems(tracing.routes, diff.files.map((f) => f.path), reachedFiles);
    const unreached = sel.accounting.entries.filter((e) => e.kind === 'file' && e.state === 'not-attacked' && ['not traced', 'no flow reaches it', 'no flow sends it from the browser'].includes(e.reason ?? ''));
    const ranges = patchRanges(patchBytes);
    const envFile = Object.keys(parseDotenv(readFolderFile(folder, '.env') ?? ''));
    const state: PlanState = {
      runId: run.id,
      runner: info.version,
      tier: tierName,
      digest: diff.digest,
      base: { given: givenBase },
      planMs: clock.planMs() ?? 0,
      attacks: planList,
      flows: sel.ordered.map((o) => {
        const e = flowEntries.find((f) => f.name === o.name);
        return {
          name: o.name,
          class: o.cls,
          aboveCut: aboveFlows.has(o.name),
          pages: (e?.pages ?? []).map((pg) => ({ path: pg.path, entry: pg.entry })),
          requests: [...new Set((e?.requests ?? []).map((q) => q.key))].map((key) => ({ key, applies: appliesOf(o.name, key) })),
          forms: formsOf(o.name),
        };
      }),
      run: run.id,
      baseRef: { ref: diff.base.ref, sha: diff.base.sha },
      selected: above.map((x) => x.attack.id),
      failing: outcomes.filter((o) => !o.passed && o.failure).map((o) => ({ flow: o.flow.name, step: o.failure!.step, error: o.failure!.message.split('\n')[0]!.slice(0, 300), snapshot: `baseline/${o.flow.name}.png` })),
      needsFlow,
      files: unreached.slice(0, 200).map((e) => ({ path: e.file, state: e.state, reason: e.reason, patch: ranges.get(e.file) ?? null })),
      filesNotListed: Math.max(0, unreached.length - 200),
      endpoints: (map.endpoints as { endpoint: string; state: string | null; reason: string | null; fullLoad: unknown[] }[]).map((x) => ({ endpoint: x.endpoint, state: x.state, reason: x.reason, fullLoad: x.fullLoad })),
      env: [...new Set([...envFile, ...flows.flatMap((f) => envNames(f.steps))])].sort(),
      specParts: specMeta,
      planNotes,
      contract,
      // What link checks against (16.7): the route table, OpenAPI keys and every flow's entries.
      routes: tracing.routes ? tracing.routes.map((r) => r.path) : null,
      apiKeys: [...new Set(sel.docs.flatMap((d) => Object.entries(d.doc.paths ?? {}).flatMap(([p, ops]) => Object.keys(ops).filter((m) => /^(get|put|post|delete|patch|head|options)$/.test(m)).map((m) => `${m.toUpperCase()} ${p.replace(/\{[^}]*\}/g, '{}')}`))))].sort(),
      flowPages: flowEntries.map((f) => ({ name: f.name, passed: f.passed, pages: f.pages.map((pg) => ({ path: pg.path, entry: pg.entry })), requests: f.requests.map((q) => q.key.replace(/ #\d+$/, '')) })),
      limits: { tier: tierName, budgetMs: spec.budgetMs, windowMs: cut?.windowMs ?? 0, ...LIMITS[tierName] },
    };
    writeAdversaryFolder(folder, run.id, { diffMap: map, patch: patchBytes, needsFlow, selection: state as unknown as Record<string, unknown>, specs: specs?.parts ?? [] });
    // Written in field order so limits{} reads in 42.7's row order, escaped to
    // ASCII; the manifest hash is key-order free.
    writeAtomic(folder, ['runs', run.id, ...SELECTION], asciiJson(JSON.stringify(state, null, 2)) + '\n');
    manifest.recordRun(run.id, SELECTION.join('/'), JSON.parse(redactSecrets(canonicalJson(state))));
    writeAtomic(folder, ['runs', run.id, CATALOGUE], canonicalJson(catalogueRecord));
    manifest.recordRun(run.id, CATALOGUE, JSON.parse(redactSecrets(canonicalJson(catalogueRecord))));
  }
  writeAtomic(folder, ['runs', run.id, 'diff-map.json'], canonicalJson(map));
  // Read-back run output gets its hash in the manifest in the same step (27.2).
  manifest.recordRun(run.id, 'diff-map.json', JSON.parse(redactSecrets(canonicalJson(map))));
  manifest.prune(root, (rel, sha) => (prot.reviewedHashes.get(rel) ?? []).includes(sha), new Set(existsSync(path.join(folder.dir, 'runs')) ? readdirSync(path.join(folder.dir, 'runs')) : []));
  ctx.notes.push(...manifest.notes.filter((n) => !ctx.notes.some((m) => m.text === n.text)));
  const aborted = guard?.note();
  if (aborted) ctx.notes.push(aborted);
  const allResults = [...(signInOutcome!.result ? [signInOutcome!.result] : []), ...outcomes.flatMap((o) => o.runs)];
  const origins = apiOrigins(target, allResults, hosts);
  const ci = ciMode(ctx.env, info);

  // Header (section 37).
  const header1 = [`rough-ride ${ctx.mode === 'plan' ? `plan ${ctx.subcommand}` : ctx.mode === 'attack' ? 'attack' : ctx.subcommand}`, formatDuration(ctx.elapsed()), `run ${run.id}`];
  if (info.version.startsWith('0.')) header1.push(PRE_RELEASE);
  const proof = target.proof === 'nuxt-lock' ? 'proven Nuxt dev server' : 'target.url in config.yaml';
  const header3 = `target: ${target.url} (${proof}${target.started ? ', started by --start' : ''})` +
    (origins.length > 0 ? ` | API ${origins.join(', ')}` : '') +
    ` | ${SHORT_TITLES[launched.name]} ${launched.version}${allowedSuffix(hosts)}`;
  const header = [header1.join(' | '), headerLine2(diff) + reachCounts(sel), header3];

  // Flows.
  const flowLines: string[] = [];
  if (signInOutcome!.line) flowLines.push(signInOutcome!.line);
  const baselineFailedLines: string[] = [];
  for (const o of outcomes.filter((x) => !x.passed && x.skipped === null && x.failure)) {
    const message = o.failure!.message.startsWith(`${o.failure!.label}: `) ? o.failure!.message.slice(o.failure!.label.length + 2) : o.failure!.message;
    baselineFailedLines.push(`Baseline failed: ${o.flow.name} at step ${o.failure!.step} (${o.failure!.label}): ${message}. Not attacked until it passes.`);
  }
  flowLines.push(...baselineFailedLines);
  // Added by the adversary (38 item 4): links, then this run's saves.
  const linkTarget = (l: { endpoint?: string; flow?: string; page?: string }) => (l.endpoint ?? (l.flow !== undefined ? `flow ${l.flow}` : `page ${l.page}`));
  for (const l of linkResults) {
    // A rejected entry may be any YAML value, as the adversary sent it.
    const obj = l.input && typeof l.input === 'object' && !Array.isArray(l.input) ? l.input : null;
    flowLines.push(l.accepted && obj
      ? `Accepted adversary link${l.id ? ` ${l.id}` : ''}: ${obj.file} -> ${linkTarget(obj)}${obj.entry ? ` (entry: ${obj.entry})` : ''}`
      : `Rejected adversary link: ${typeof obj?.file === 'string' ? obj.file : '?'} -> ${obj ? linkTarget(obj) : '?'} (${l.why})`);
  }
  if (planParsed?.refused) flowLines.push(planParsed.refused);
  for (const w of planParsed?.warnings ?? []) flowLines.push(w);
  for (const line of planResult?.lines ?? []) flowLines.push(line);
  for (const line of checkLines) flowLines.push(line);
  for (const r of savedRecords) {
    if (r.kept) flowLines.push(`Saved: flows/${r.name}.yaml (${r.kind === 'new' ? `new, for ${r.item}` : r.kind === 'repair' ? 'repaired' : 'saved'})`);
    else if (r.page) flowLines.push(`Not attacked: no passing flow for ${r.page}`);
    else if (r.file) flowLines.push(`Not attacked: ${r.file} (new flow ${r.name} does not reach it${r.why?.startsWith('enters ') ? `: ${r.why}` : ''})`);
  }
  for (const name of notRun) {
    // A valid flow is not run when its reviewed version fails the check: the block's change says so.
    const listed = prot.entries.find((e) => e.path === `flows/${name}.yaml`);
    const reason = files.flows.find((f) => f.shown === `.rough-ride/flows/${name}.yaml`)?.step5[0] ?? (listed ? `.rough-ride/flows/${name}.yaml: ${listed.change}` : 'invalid');
    flowLines.push(`Not run: ${reason}`);
  }
  // Checks that fail with no attack: once per flow; outside the diff only in report.txt.
  const failsNoAttack: { flow: string; check: string; step: number; page: string | null; outside: boolean }[] = [];
  const allFlowRuns = [...(signInOutcome!.result ? [{ name: 'sign-in', run: signInOutcome!.result }] : []), ...outcomes.filter((o) => o.runs[0]).map((o) => ({ name: o.flow.name, run: o.runs[0]! }))];
  for (const { name, run: r } of allFlowRuns) {
    const outside = !selection!.ordered.some((o) => o.name === name);
    const flow = flows.find((x) => x.name === name);
    for (const f of baselineFailures(r)) {
      if (flow && acceptsBaseline(acceptedList, baselineKey(flow, r, f.step, f.page, hosts.ownHost), f.id, `fails with no attack: ${name} step ${f.step}`)) continue;
      failsNoAttack.push({ flow: name, check: f.id, step: f.step, page: f.page, outside });
    }
  }
  const failsLine = (f: (typeof failsNoAttack)[number]) => `Fails with no attack: ${f.check} on ${f.flow} at step ${f.step} (${f.page ?? '-'})${f.outside ? ' (outside the diff)' : ''}`;
  for (const f of failsNoAttack.filter((x) => !x.outside)) flowLines.push(failsLine(f));

  // Findings: shown groups, two lines each, with the repro id of the representative.
  const ordinalOf = (o: AttackOutcome) => meta.get(o)?.ordinal ?? 0;
  const shown = groups.filter((g) => g.state === 'shown');
  const groupLinesOf = (g: Group) => groupLines(g, reproId(ordinalOf(g.representative.outcome)));
  const notConfirmed = groups.filter((g) => g.state === 'not-confirmed').length;
  const capped = groups.filter((g) => g.state === 'capped').length;
  const unchecked = groups.filter((g) => g.state === 'unchecked').length;
  // Regression tests (24.4): a candidate for every finding, a committed test for each shown group.
  const today = startedAt.slice(0, 10);
  const candidateOf = new Map<AttackOutcome, string>();
  for (const o of attackOutcomes.filter((x) => x.verdict === 'failed')) {
    const group = groups.find((g) => g.members.some((m) => m.outcome === o));
    const t = buildTest(o, o.checks.filter((c) => c.result === 'fail').map((c) => c.id), { finding: symptomOf(group?.representative.outcome ?? o), run: run.id, runner: info.version, date: today });
    writeAtomic(folder, ['runs', run.id, 'tests', `${t.name}.yaml`], t.text);
    candidateOf.set(o, `.rough-ride/runs/${run.id}/tests/${t.name}.yaml`);
  }
  const testOf = new Map<Group, { name: string; state: 'new' | 'exists' | 'candidate' | 'not-written'; path: string }>();
  const newTests: string[] = [];
  const doesntCheck = new Map<Group, string[]>();
  for (const g of groups.filter((x) => x.state === 'shown')) {
    const rep = g.representative.outcome;
    const t = buildTest(rep, g.fails, { finding: symptomOf(rep), run: run.id, runner: info.version, date: today });
    const rel = `tests/${t.name}.yaml`;
    const shownPath = `.rough-ride/${rel}`;
    if (ci) {
      testOf.set(g, { name: t.name, state: 'candidate', path: candidateOf.get(rep) ?? shownPath });
      continue;
    }
    const existing = path.join(folder.dir, 'tests', `${t.name}.yaml`);
    if (existsSync(existing)) {
      // Never overwritten; a check that failed again but isn't listed is named in report.txt.
      let listed: unknown[] = [];
      try {
        listed = ((parseYaml(readFileSync(existing, 'utf8')) as { checks?: unknown[] })?.checks ?? []);
      } catch {
        listed = [];
      }
      const ids = listed.map((c) => (typeof c === 'string' ? c : (c as { id?: string })?.id));
      const missing = g.fails.filter((c) => !ids.includes(c));
      if (missing.length > 0) doesntCheck.set(g, missing.map((c) => `${rel} doesn't check ${c}, which failed again: add it to checks by hand.`));
      testOf.set(g, { name: t.name, state: 'exists', path: shownPath });
      continue;
    }
    writeProtected({ folder, manifest, files, info, root, nuxtRel: target.nuxtRoot?.rel ?? null, argv: ctx.argv }, `tests/${t.name}.yaml`, t.text, 'runner', run.id);
    newTests.push(shownPath);
    manifest.data.tests[t.name] = { outcome: 'fail', run: run.id, at: startedAt };
    testOf.set(g, { name: t.name, state: 'new', path: shownPath });
  }
  const afterFindings: string[] = [];
  // `Regression tests: 3 passed | 1 failed (a) | 1 stale (b: cause)`, at most 2 names per outcome (25.8).
  if (testResults.length > 0 || testsOverBudget.length > 0) {
    const part = (o: TestOutcome, word: string) => {
      const list = testResults.filter((r) => r.outcome === o);
      if (list.length === 0) return null;
      const names = list.slice(0, 2).map((r) => (o === 'stale' ? `${r.name}: ${r.reason ?? 'stale'}` : r.name)).join(', ');
      return o === 'pass' ? `${list.length} ${word}` : `${list.length} ${word} (${names}${list.length > 2 ? ', ...' : ''})`;
    };
    const parts = [part('pass', 'passed'), part('fail', 'failed'), part('flaky', 'flaky'), part('stale', 'stale'), testsOverBudget.length > 0 ? `${testsOverBudget.length} over the ${ctx.subcommand} budget` : null].filter(Boolean);
    afterFindings.push(`Regression tests: ${parts.join(' | ')}`);
  }
  if (newTests.length === 1) afterFindings.push(`New regression test: ${newTests[0]}. Commit it with your fix.`);
  else if (newTests.length > 1) afterFindings.push(`New regression tests: ${newTests.join(', ')}. Commit them with your fix.`);
  if (ci && shown.length > 0) afterFindings.push(`Regression test candidates are in the job's uploaded run output (${run.id}/tests/). Copy one to .rough-ride/tests/ and commit it to keep it.`);
  if (notConfirmed + capped + unchecked > 0) {
    const parts = [`Not shown: ${capped} more finding ${capped === 1 ? 'group' : 'groups'}`];
    if (notConfirmed > 0) parts.push(`${notConfirmed} not confirmed when run again alone`);
    if (unchecked > 0) parts.push(`${unchecked} not checked`);
    afterFindings.push(`${parts.join(', ')} (report.txt)`);
  }

  // The Attacks line, or Nothing attacked.
  const count = (v: string) => attackOutcomes.filter((o) => o.verdict === v).length;
  const counts = {
    total: attackOutcomes.length,
    passed: count('passed'),
    failed: count('failed'),
    pending: count('pending'),
    acceptedFinding: count('accepted-finding'),
    notJudged: { notApplied: count('not-applied'), inconclusive: count('inconclusive'), void: count('void'), faultNeverFired: count('fault-never-fired') },
    skipped: skippedLines.filter((l) => l.startsWith('Skipped:')).length,
    overBudget: {
      cut: cutItems.filter((c) => c.reason === 'cut').length,
      time: cutItems.filter((c) => c.reason === 'time').length + attackOutcomes.filter((o) => o.run.voided === 'stopped at the hard stop').length,
      bash: cutItems.filter((c) => c.reason === 'bash').length,
      planned: cutItems.filter((c) => c.reason === 'planned').length,
    },
  };
  let attacksLine: string | null = null;
  let nothing: string | null = attackOutcomes.length === 0 ? nothingAttackedLine(sel.accounting.entries) : null;
  if (attackOutcomes.length > 0) {
    const files_ = sel.accounting.entries.filter((e) => e.kind === 'file');
    const eps = sel.accounting.entries.filter((e) => e.kind === 'endpoint');
    const notJudged = counts.notJudged.notApplied + counts.notJudged.inconclusive + counts.notJudged.void + counts.notJudged.faultNeverFired;
    const head = [`${files_.filter((e) => e.state === 'attacked').length} of ${files_.length} changed ${files_.length === 1 ? 'file' : 'files'}`];
    if (eps.length > 0) head.push(`${eps.filter((e) => e.state === 'attacked').length} of ${eps.length} changed ${eps.length === 1 ? 'endpoint' : 'endpoints'}`);
    const parts = [counts.passed ? `${counts.passed} passed` : null, counts.failed ? `${counts.failed} failed` : null, counts.pending ? `${counts.pending} pending` : null, counts.acceptedFinding ? `${counts.acceptedFinding} matched accepted.yaml` : null, notJudged ? `${notJudged} not judged` : null].filter(Boolean);
    attacksLine = `Attacks: ${head.join(' and ')} attacked | ${counts.total} ${counts.total === 1 ? 'attack' : 'attacks'}: ${parts.join(', ')}${counts.skipped ? ` | ${counts.skipped} skipped` : ''}${cutItems.length > 0 ? ` | ${cutItems.length} over the ${ctx.subcommand} budget` : ''}`;
  }
  // Only flow files changed: name the flows checked (15.7).
  const appChanged = diff.files.some((f) => f.class === 'app' || f.class === 'config' || f.class === 'dependency');
  const changedFlows = diff.files.filter((f) => f.class === 'flow' && f.status !== 'deleted').map((f) => f.path.split('/').at(-1)!.replace(/\.yaml$/, ''));
  if (!appChanged && changedFlows.length > 0) {
    const checked = changedFlows.map((name) => {
      const o = outcomes.find((x) => x.flow.name === name);
      const isNew = diff.files.some((f) => f.class === 'flow' && f.status === 'added' && f.path.endsWith(`/${name}.yaml`));
      const how = !o ? 'not run' : o.passed ? (o.runs.length === 2 ? 'passed twice' : 'passed') : `failed at step ${o.failure?.step ?? '?'}`;
      return `${name} (${isNew ? 'new, ' : ''}${how})`;
    });
    nothing = `Nothing attacked: the diff changes no app code. Flows checked: ${checked.join(', ')}.`;
    attacksLine = null;
  }

  // Commands: Investigate names the first shown group's repro (section 37). The
  // Fix line comes with committed tests (ticket 33) and More attacks with the cut (ticket 28).
  const commands: string[] = [];
  // The Fix line names the tests written now and the open tests that failed (25.8).
  const fixNames = [...newTests.map((p) => p.split('/').at(-1)!.replace(/\.yaml$/, '')), ...testResults.filter((r) => r.outcome === 'fail').map((r) => r.name)];
  if (fixNames.length > 0 && !ci) {
    const fix = `Fix, then run: ${followUpCommand(info, { command: 'regress', only: [...new Set(fixNames)] })}`;
    commands.push(fix.length > 400 ? `Fix, then run: ${followUpCommand(info, { command: 'regress' })}` : fix);
  }
  if (shown.length > 0 && !ci) {
    const ids = shown.map((g) => reproId(ordinalOf(g.representative.outcome)));
    const others = ids.slice(1);
    commands.push(`Investigate (keeps running; start it in the background): ${followUpCommand(info, { command: 'repro', id: `${run.id}/${ids[0]}`, keepOpen: true })}${others.length > 0 ? ` (other findings: ${others.join(', ')})` : ''}`);
  }
  // In quick, whenever any selected attack or test was cut (50.6, 52.2).
  if (ctx.subcommand === 'quick' && (cutItems.length > 0 || testsOverBudget.length > 0) && ctx.mode !== 'plan') commands.push(`More attacks: ${followUpCommand(info, { command: 'standard', base: givenBase })}`);
  if (ctx.mode === 'plan') {
    const above = planList.filter((x) => x.aboveCut);
    const flowsAbove = new Set(above.map((x) => x.attack.flow)).size;
    attacksLine = null;
    nothing = `Planned: ${above.length} selected ${above.length === 1 ? 'attack' : 'attacks'} on ${flowsAbove} ${flowsAbove === 1 ? 'flow' : 'flows'} (${planList.length - above.length} below the ${ctx.subcommand} cut). Nothing attacked yet; run files: ${printed(path.join(folder.dir, 'runs', run.id, 'adversary'))}`;
  }
  const reportPath = printed(path.join(folder.dir, 'runs', run.id, 'report.txt'));
  const contractLineText = contractLine(contract, { version: info.version, ci });
  const naShown = lines_.map((l) => l.text);
  const scope = lines_.length > 0 || sel.accounting.fullLoad.length > 0 ? SCOPE_LINE : null;
  const protectedBlock = protectedSummary(prot).length === 1 && prot.entries.every((e) => e.used === 'working-tree' && e.notApplied.length === 0)
    ? protectedSummary(prot)
    : blockLines(prot);

  const view: SummaryView = {
    header,
    nothingAttacked: nothing,
    notes: ctx.notes,
    protectedBlock,
    flowLines,
    findings: shown.map(groupLinesOf),
    afterFindings,
    attacksLine,
    notAttacked: naShown,
    scopeLine: scope,
    contract: summaryContractLine(contract, contractLineText, { plan: ctx.mode === 'plan', shownFindings: shown.length, ci }),
    commands,
    // In CI mode the path points into the job's uploaded run output, rooted at runs/ (52.3).
    fullReport: ci ? `Full report: ${run.id}/report.txt in the job's uploaded run output` : `Full report: ${reportPath}`,
    runner: runnerBlock(info),
  };
  const sections = renderSections(view, !!info.pluginData);
  const lines = sections.flatMap((x) => x.lines);
  const adversaryDir = path.join(folder.dir, 'runs', run.id, 'adversary');
  if (existsSync(adversaryDir)) writeAtomic(folder, ['runs', run.id, 'adversary', 'summary.txt'], lines.map((l) => l + '\n').join(''));

  // report.txt: the 15 sections of section 38, empty ones left out.
  const section = (title: string | null, body: string[]) => (body.length > 0 ? [...(title ? [title] : []), ...body, ''] : []);
  const memberLines = (g: Group) => g.members.flatMap((m) => {
    const o = m.outcome;
    const id = reproId(ordinalOf(o));
    return [
      `  ${o.id}${plannedIds.has(o.id) ? ' (planned)' : ''} (${id}): fails ${m.failed.map((c) => checkLabel(c, o.checks)).join(', ')}`,
      ...o.checks.filter((c) => c.result === 'fail').map((c) => `    ${c.id}: ${c.evidence}`),
      `    screenshot: repros/${id}.png`,
    ];
  });
  const findingReport = groups.flatMap((g, i) => {
    const repOrdinal = confirmOrdinals.get(g.representative.outcome.id);
    const confirmation = g.confirmation
      ? `confirmation: ${g.state === 'shown' ? 'confirmed' : 'not confirmed'} (run ${repOrdinal ? reproId(repOrdinal) : '-'}, failed again: ${g.confirmation.failed.join(', ') || 'nothing'})`
      : g.state === 'under-test' ? `under-test: repeats tests/${underTestOf.get(g)}.yaml, which failed in this run`
      : `confirmation: ${g.state}${g.state === 'unchecked' && signInFailedGroups.has(g.representative.outcome.id) ? ' (sign-in failed before confirmation)' : ''}`;
    const notConfirmedLine = g.state === 'not-confirmed'
      ? [`Not confirmed: ${symptomOf(g.representative.outcome)} passed when run again alone; no regression test written (candidate: ${candidateOf.get(g.representative.outcome) ?? '-'}).`]
      : [];
    const testLine = testOf.get(g) ? [`test: ${testOf.get(g)!.path} (${testOf.get(g)!.state})`, ...(doesntCheck.get(g) ?? [])] : [];
    return [
      `${i + 1}. [${g.state}]`,
      ...groupLinesOf(g),
      `key: page ${g.key.page} | step ${g.key.step} | action ${g.key.action} | check ${g.lead}`,
      `severity: ${SEVERITY_TEXT[g.severity].trim()} (${checkLabel(g.lead, g.representative.outcome.checks)})`,
      confirmation,
      ...notConfirmedLine,
      ...testLine,
      ...memberLines(g),
      ...(i < groups.length - 1 ? [''] : []),
    ];
  });
  const notJudgedLines = [...attackOutcomes.map((o) => nonFinding(o, holdMs)?.text).filter((t): t is string => !!t), ...rateLimitedLines];
  const baselineShots = outcomes.filter((o) => !o.passed && o.skipped === null && o.failure).map((o) => `  screenshot: baseline/${o.flow.name}.png`);
  const writes = guard?.writesRecord() ?? { perHost: {}, aborted: [] };
  const writeLines = [
    ...Object.entries(writes.perHost as Record<string, number>).sort((a, b) => cmp(a[0], b[0])).map(([host, n]) => `writes to ${host}: ${n}`),
    ...(writes.aborted as { host: string; method: string; path: string; count: number }[]).map((a) => `aborted: ${a.method} ${a.host}${a.path} (${a.count})`),
  ];
  const reportBody = [
    ...section(null, [
      ...header,
      `started ${startedAt}`,
      clock.timeLine({ runnerMs: ctx.elapsed(), adversaryCallsMs }),
      ...(ctx.mode === 'plan' ? ['Not attacked lines are provisional: attack --run decides them.'] : []),
      ...[clock.resetLine()].filter((l): l is string => l !== null),
      ...(info.version.startsWith('0.') ? [PRE_RELEASE_REPORT] : []),
    ]),
    ...section('Notes', orderNotes(ctx.notes).map((n) => n.text)),
    ...section(null, protectedReport(prot)),
    ...section('Flows', [...flowLines, ...baselineShots, ...failsNoAttack.filter((x) => x.outside).map(failsLine)]),
    ...section('Findings', findingReport),
    ...section('Regression tests', testResults.flatMap((r) => [
      `${r.outcome.padEnd(6)} ${r.name}${r.failed.length > 0 ? ` | ${r.failed.join(', ')}` : r.reason ? ` | ${r.reason}` : ''}`,
      ...(r.accepted ?? []).map((a) => `       ${a}`),
    ])),
    ...section('Attacks without a full verdict', notJudgedLines),
    ...section('Skipped', skippedLines),
    ...section('Fields without bad inputs', fieldsNotAttacked),
    ...section(null, [...(attacksLine ? [attacksLine] : nothing ? [nothing] : []), ...reportNotAttacked(lines_, sel.accounting.fullLoad)]),
    ...section('Accepted entries', acceptedReport(acceptedList)),
    ...section('Writes', writeLines),
    ...section(null, contractLineText ? [contractLineText] : []),
    ...section('Commands', commands),
    ...section(null, runnerBlock(info)),
  ];
  const runDir = path.join(folder.dir, 'runs', run.id);
  const runFiles = [...new Set([...listFiles(runDir), 'report.txt', 'record.json', 'summary.txt', 'summary.json'])].sort(cmp);
  writeAtomic(folder, ['runs', run.id, 'report.txt'], [...reportBody, ...section('Files', runFiles)].join('\n').replace(/\n+$/, '') + '\n');

  const findings = shown.map((g) => ({
    group: groups.indexOf(g) + 1,
    severity: g.severity,
    lead: g.lead,
    symptom: symptomOf(g.representative.outcome),
    key: g.key,
    checks: g.fails,
    members: g.members.map((m) => m.outcome.id),
    representative: { attack: g.representative.outcome.id, repro: reproId(ordinalOf(g.representative.outcome)), test: testOf.get(g) ?? null },
    foreignRecords: g.members.flatMap((m) => m.foreign),
  }));
  const document = {
    spec: { parts: specMeta.length },
    sections,
    protectedLines: prot.entries.length === 0 ? [] : blockWithHints(prot),
    runId: run.id,
    runDir: run.dir.split('\\').join('/'),
    command: ctx.mode ?? ctx.subcommand,
    protected: protectedJson(prot),
    tier: ctx.subcommand,
    status,
    phase: ctx.mode === 'plan' ? 'planned' : ctx.mode === 'attack' ? 'attacked' : attackOutcomes.length > 0 ? 'attacked' : null,
    exitCode,
    preRelease: info.version.startsWith('0.'),
    target: {
      url: target.url,
      proof: target.proof === 'nuxt-lock' ? 'nuxt-lock' : 'config',
      started: target.started,
      apiOrigins: origins,
      browser: { channel: launched.name, version: launched.version },
      allowed: { remoteTarget: hosts.remoteTarget, remoteWrites: hosts.remoteWrites },
    },
    flows: {
      signIn: !signInOutcome!.ran ? 'none' : signInOutcome!.passed ? 'passed' : 'failed',
      baselineFailed: outcomes
        .filter((o) => !o.passed && o.skipped === null && o.failure)
        .map((o) => ({ flow: o.flow.name, step: o.failure!.step, label: o.failure!.label, message: o.failure!.message })),
      failsWithNoAttack: failsNoAttack.map((f) => ({ check: f.check, flow: f.flow, step: f.step, page: f.page, outsideDiff: f.outside })),
    },
    attacks: counts,
    findings,
    notShown: { notConfirmed, capped, unchecked, underTest: groups.filter((g) => g.state === 'under-test').length },
    regress: testResults.length === 0 ? null : {
      pass: testResults.filter((r) => r.outcome === 'pass').length,
      fail: testResults.filter((r) => r.outcome === 'fail').length,
      flaky: testResults.filter((r) => r.outcome === 'flaky').length,
      stale: testResults.filter((r) => r.outcome === 'stale').length,
      overLimit: 0,
      tests: testResults.map((r) => ({ name: r.name, outcome: r.outcome, reason: r.reason, checks: r.failed, alsoFailed: [] })),
    },
    coverage: {
      files: { changed: sel.accounting.entries.filter((e) => e.kind === 'file').length, attacked: sel.accounting.entries.filter((e) => e.kind === 'file' && e.state === 'attacked').length },
      endpoints: { changed: sel.accounting.entries.filter((e) => e.kind === 'endpoint').length, attacked: sel.accounting.entries.filter((e) => e.kind === 'endpoint' && e.state === 'attacked').length },
      nothingAttacked: attackOutcomes.length === 0,
      notAttacked: {
        total: sel.accounting.entries.filter((e) => e.state === 'not-attacked').length,
        byReason: Object.fromEntries([...new Set(sel.accounting.entries.filter((e) => e.reason).map((e) => e.reason!))].map((r) => [r, sel.accounting.entries.filter((e) => e.reason === r).length])),
        lines: lines_.map((l) => l.text),
      },
      fullLoad: sel.accounting.fullLoad.map(({ line: _line, ...q }) => q),
    },
    contract: contractJson(contract),
    commands: { fix: null, investigate: commands[0] ?? null, more: null },
    files: {
      report: 'report.txt', summaryText: 'summary.txt', record: 'record.json', attacks: attackOutcomes.length > 0 ? 'attacks.jsonl' : null,
      diffMap: 'diff-map.json', diffPatch: 'diff.patch', upgradePatch: null,
    },
    meta: {
      startedAt,
      durationMs: Math.round(ctx.elapsed()),
      budgetMs: TIER_TABLE.tiers[tierName].budgetMs,
      budget: {
        tier: tierName,
        ...clock.fields(),
        nominalPlanMs: cut?.nominalPlanMs ?? null,
        windowMs: cut?.windowMs ?? null,
        adversaryCallsMs,
        lanes,
        cpus: availableParallelism(),
      },
    },
    formats: files.formats as FormatsReport,
    writes,
  };
  // record.json: everything in summary.json plus the per-attack and per-group records.
  const record = {
    specParts: specMeta,
    accepted: acceptedRecord(acceptedList, files.accepted !== null),
    environment: environmentRecord(ctx.env, info),
    flows: flowEntries.map((f) => ({
      name: f.name,
      used: prot.flows.find((e) => e.flow.name === f.name)?.used ?? 'working-tree',
      class: f.class,
      baselineRuns: f.baselineRuns,
      durationMs: f.durationMs,
      pages: f.pages,
    })),
    attacks: attackOutcomes.map((o) => {
      const group = groups.findIndex((g) => g.members.some((m) => m.outcome === o));
      return {
        ...attackRecord(o, meta.get(o)!, flows.find((f) => f.name === o.flow)),
        key: group >= 0 ? groups[group]!.members.find((m) => m.outcome === o)!.key : null,
        group: group >= 0 ? group + 1 : null,
        foreignRecords: group >= 0 ? groups[group]!.members.find((m) => m.outcome === o)!.foreign : [],
        planned: plannedIds.has(o.id),
      };
    }),
    groups: groups.map((g, i) => ({
      id: i + 1,
      rank: i + 1,
      state: g.state,
      severity: g.severity,
      lead: g.lead,
      key: g.key,
      representative: g.representative.outcome.id,
      members: g.members.map((m) => m.outcome.id),
      confirmation: g.confirmation
        ? { ordinal: confirmOrdinals.get(g.representative.outcome.id) ?? null, failedChecks: g.confirmation.failed, confirmedChecks: g.fails }
        : null,
    })),
    nonFindings: attackOutcomes.map((o) => nonFinding(o, holdMs)).filter((n): n is NonNullable<typeof n> => n !== null),
    skipped: skippedLines.map((text) => ({ text })),
    fieldsNotAttacked,
    cut: cutItems.map((c) => ({ id: c.attack.id, flow: c.attack.flow, kind: c.attack.kind, band: bandOf(c.attack.rank), nominalMs: c.nominalMs, reason: c.reason })),
    tier: { name: tierName, tableSha256: tierTableSha256() },
    constants: { delayMs: DELAY_MS, holdMs, retryAfter: RETRY_AFTER },
  };
  manifest.save();
  return { run, lines, document, record, status, exitCode };
}


// One page list per flow: when baseline runs disagree on a step's entry, full-load wins.
function mergePages(runs: FlowRunResult[]): FlowRunResult['pages'] {
  const byStep = new Map<number, FlowRunResult['pages'][number]>();
  for (const run of runs) {
    for (const entry of run.pages) {
      const seen = byStep.get(entry.step);
      if (!seen) byStep.set(entry.step, { ...entry });
      else if (entry.entry === 'full-load') byStep.set(entry.step, { ...seen, entry: 'full-load', method: entry.method });
    }
  }
  return [...byStep.values()].sort((a, b) => a.step - b.step);
}

// Files under a run folder, relative, with `/`.
function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).sort(cmp);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, `${prefix}${name}/`));
    else if (!name.startsWith('tmp-')) out.push(`${prefix}${name}`);
  }
  return out;
}
