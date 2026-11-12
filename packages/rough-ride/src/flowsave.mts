// `rough-ride flow save` (spec part 3 section 13.10): the only way an agent
// saves a flow. One YAML document per name on stdin; each is checked, baseline
// run against the effective version, and written with `schema` first plus a
// saved copy in the checksum manifest. The --run item and keep rules come in
// ticket 40.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import { printed } from '../hooks/path-check.mjs';
import type { BrowserName, Launched } from './browser.mjs';
import { parseCommitted } from './committed.mjs';
import { stopWith } from './exit.mjs';
import { checkCommittedFiles, writeProtected } from './files.mjs';
import { ensureFolder, type FolderState } from './folder.mjs';
import { envNames, isFrameworkInternal, runFlow, type Flow, type FlowRunResult, type Step } from './flowrun.mjs';
import { FORMATS } from './formats.mjs';
import { Manifest } from './manifest.mjs';
import { formatDuration, type Note } from './output.mjs';
import { blockLines, blockWithHints, compareFlow, compareProtected, summaryLines as protectedSummary } from './protected.mjs';
import type { Section } from './summary.mjs';
import { followUpCommand, runnerBlock, type RunnerInfo } from './runner.mjs';
import type { RunReport } from './runoutput.mjs';
import type { RunFolder } from './runs.mjs';
import { loadSchema } from './schema.mjs';
import { checkEnv, checkSignInEnv, envReader } from './session.mjs';
import { asciiJson } from './adversary.mjs';
import { computeDiff } from './diff.mjs';
import { readLinks } from './link.mjs';
import { moduleFiles, repoFiles, samePage } from './tracing.mjs';
import { nuxtCandidates } from './target.mjs';
import { openTargetSession } from './targetsession.mjs';
import { callCount, checkRun, LIMITS, planAgain, recordCall } from './runcheck.mjs';
import { writeAtomic } from './write.mjs';

export const MAX_INPUT = 24 * 1024;
const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const SECRET_FORMATS = [
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{36,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /xox[abposr]-/,
  /npm_[A-Za-z0-9]{36}/,
  /sk-[A-Za-z0-9_-]{20,}/,
];

export interface FlowSaveContext {
  root: string;
  folder: FolderState;
  info: RunnerInfo;
  names: string[];
  runId: string | null;
  stdin: string;
  browserFlag: BrowserName | null;
  start: boolean;
  argv: string[];
  env: NodeJS.ProcessEnv;
  notes: Note[];
  // Where the run reports its run folder, protected comparison and contract.
  report: RunReport;
  elapsed: () => number;
  progress: (line: string) => void;
  launch?: (name: BrowserName) => Promise<Launched>;
}

export interface FlowSaveResult {
  run: RunFolder | null;
  lines: string[];
  document: Record<string, unknown>;
  status: 'passed' | 'incomplete';
  exitCode: 0 | 2;
}

interface Doc {
  name: string;
  text: string;
  value: Record<string, unknown> | null;
  // The first refusal, or null while the document is still in the running.
  refused: string | null;
  line: string | null;
  // Under --run: the needsFlow item a new flow is for (`name:n1`).
  item: string | null;
  points: string | null;
}

// A needsFlow item the run offers: plan's n ids and accepted page links' l ids.
interface Item {
  id: string;
  page: string;
  file: string;
  entry: string | null;
}

// adversary/saved/<name>.json: what flow save --run kept or refused for attack.
export interface SavedRecord {
  name: string;
  item: string | null;
  kind: 'new' | 'repair' | 'other';
  kept: boolean;
  // A kept flow repaired in this run: one repair per flow (09 item 8).
  repaired?: boolean;
  // A new flow not kept: its item's page, for `no passing flow for <page>` (16.8).
  page?: string | null;
  why: string | null;
  file: string | null;
  points: string[];
  forms: string[];
}

// Splits stdin into one document per name, in order, keeping each one's text.
export function splitDocuments(stdin: string): string[] {
  const text = stdin.replace(/\r\n/g, '\n');
  return parseAllDocuments(text).map((d) => {
    const [start, , end] = d.range;
    return text.slice(start, end).replace(/^---[^\n]*\n/, '').replace(/\n?\.\.\.\s*$/, '');
  });
}

// Checks that need no browser: name, bytes, schema key, parse and schema,
// goto paths and known secret formats (13.10 steps 1 and 2, 44.5).
export function staticRefusal(name: string, text: string, formats = FORMATS): { refused: string | null; value: Record<string, unknown> | null } {
  const refuse = (why: string) => ({ refused: why.startsWith('Not saved:') ? why : `Not saved: ${name} (${why})`, value: null });
  if (DEVICE.test(name)) return refuse('a Windows device name');
  if (!NAME.test(name)) return refuse('a flow name is lowercase letters, digits and hyphens, at most 48 characters');
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    if (/[^\t\x20-\x7e]/.test(line)) return refuse(`non-ASCII byte at line ${i + 1}: write it as \\uXXXX inside double quotes`);
  }
  let top: unknown = null;
  try {
    top = parseAllDocuments(text)[0]?.toJSON();
  } catch {
    top = null;
  }
  if (top && typeof top === 'object' && !Array.isArray(top) && 'schema' in top) return { refused: 'Not saved: leave schema out; flow-save writes it.', value: null };
  // 44.5's guards read the raw steps, so their own line wins over a schema message.
  const rawSteps = top && typeof top === 'object' && Array.isArray((top as { steps?: unknown }).steps) ? ((top as { steps: unknown[] }).steps) : [];
  for (const [i, step] of rawSteps.entries()) {
    if (!step || typeof step !== 'object') continue;
    const st = step as Record<string, unknown>;
    if (typeof st.goto === 'string' && !st.goto.startsWith('/')) return refuse('goto must be a path on the target, such as /notes');
    if (typeof st.value === 'string' && SECRET_FORMATS.some((re) => re.test(st.value as string))) return refuse(`step ${i + 1} holds what looks like a secret`);
  }
  const body = `schema: ${formats.flow.current}\n${text.replace(/\n*$/, '\n')}`;
  const parsed = parseCommitted(body, `flows/${name}.yaml`, 'flow', loadSchema('flow.schema.json'), formats);
  const problem = [...parsed.problems, ...parsed.step5][0];
  if (problem) return refuse(problem.replace(/^flows\/[^ ]+ /, ''));
  if (!parsed.value) return refuse('empty document');
  return { refused: null, value: parsed.value };
}

// A fill value equal to the value of any ${env.NAME} the repository's flows
// read; values under 4 characters are ignored (13.10 step 2).
export function envValueRefusal(name: string, value: Record<string, unknown>, names: string[], read: (n: string) => string | undefined): string | null {
  const steps = Array.isArray(value.steps) ? (value.steps as Record<string, unknown>[]) : [];
  for (const envName of [...new Set(names)].sort()) {
    const v = read(envName);
    if (v === undefined || v.length < 4) continue;
    if (steps.some((s) => typeof s.value === 'string' && s.value === v)) return `Not saved: ${name} (contains the value of ${envName}; use \${env.${envName}})`;
  }
  return null;
}

// The step of the first expect the new version adds against `old`.
function addedExpectStep(next: Record<string, unknown>, old: Record<string, unknown>): number {
  const ns = (next.steps as unknown[]) ?? [];
  const os = (old.steps as unknown[]) ?? [];
  let j = 0;
  for (const [i, step] of ns.entries()) {
    if (j < os.length && JSON.stringify(step) === JSON.stringify(os[j])) j++;
    else return i + 1;
  }
  return ns.length;
}

const toFlow = (name: string, v: Record<string, unknown>): Flow => ({ name, signedIn: v.signedIn as boolean, steps: v.steps as Step[] });

function firstLine(message: string): string {
  return message.split('\n')[0]!.replace(/"/g, '\\"');
}

export async function runFlowSave(ctx: FlowSaveContext): Promise<FlowSaveResult> {
  const { root, info } = ctx;
  const folder = ensureFolder(ctx.folder);
  // Under --run, 42.4's run-id stops come before anything else.
  const runPlan = ctx.runId !== null ? checkRun(folder, ctx.runId, info, new Manifest(root)) : null;
  if (ctx.runId !== null) ctx.report.namedRun({ id: ctx.runId, dir: path.join(folder.dir, 'runs', ctx.runId) }, false);
  const parsedNames = ctx.names.map((n) => ({ name: n.split(':')[0]!, item: n.includes(':') ? n.slice(n.indexOf(':') + 1) : null }));
  const files = checkCommittedFiles(folder, { info, subcommand: 'flow save', argv: ctx.argv, env: ctx.env, report: ctx.report });
  ctx.notes.push(...files.notes);
  const manifest = new Manifest(root);
  const prot = compareProtected({ root, folderDir: folder.dir, files, env: ctx.env, pluginData: !!info.pluginData, manifest });
  ctx.report.protectedFiles(prot);
  ctx.notes.push(...prot.notes);
  const read = envReader(folder, ctx.env);

  let runDir: RunFolder | null = ctx.runId === null ? null : { id: ctx.runId, dir: path.join(folder.dir, 'runs', ctx.runId) } as RunFolder;

  const docs: Doc[] = [];
  if (Buffer.byteLength(ctx.stdin, 'utf8') > MAX_INPUT) {
    for (const { name, item } of parsedNames) docs.push({ name, text: '', value: null, refused: `Not saved: ${name} (input over 24 KB; save fewer flows per call)`, line: null, item, points: null });
  } else {
    const texts = splitDocuments(ctx.stdin);
    if (texts.length !== ctx.names.length) {
      stopWith('usage', `flow save got ${texts.length} ${texts.length === 1 ? 'document' : 'documents'} on stdin for ${ctx.names.length} ${ctx.names.length === 1 ? 'name' : 'names'}; send one YAML document per name, in order, separated by ---.`);
    }
    for (const [i, { name, item }] of parsedNames.entries()) {
      const text = texts[i]!;
      const s = staticRefusal(name, text);
      docs.push({ name, text, value: s.value, refused: s.refused, line: null, item, points: null });
    }
  }

  // --run: the call limit, the digest, then items and the per-run limits (44.3, 42.7).
  const savedBefore = runPlan ? readSaved(folder, runPlan.runId) : [];
  const limits = runPlan ? LIMITS[runPlan.tier] : null;
  // Counted from flows actually kept, earlier calls first; a re-save keeps its record's kind.
  const prior = new Map(savedBefore.filter((r) => r.kept).map((r) => [r.name, r]));
  let newCount = [...prior.values()].filter((r) => r.kind === 'new').length;
  let repairCount = [...prior.values()].filter((r) => r.repaired || r.kind === 'repair').length;
  const records: SavedRecord[] = [];
  const limitRecord = (d: Doc) => {
    const it = items.find((x) => x.id === d.item);
    if (it) records.push({ name: d.name, item: it.id, kind: 'new', kept: false, why: d.refused, file: it.file, page: it.page, points: [], forms: [] });
  };
  const newLimitLine = (name: string) => `Not saved: ${name} (run ${runPlan!.runId} already saved ${limits!.newFlows} new flows, the ${runPlan!.tier} limit)`;
  const items: Item[] = [];
  if (runPlan) {
    const again = followUpCommand(info, planAgain(runPlan));
    if (callCount(folder, runPlan.runId, 'flow save') >= limits!.flowSaveCalls) {
      const names = docs.map((d) => d.name).join(', ');
      for (const d of docs) d.refused = '';
      docs.splice(0, docs.length, { name: names, text: '', value: null, refused: `Not saved: ${names} (run ${runPlan.runId} already made ${limits!.flowSaveCalls} flow save calls)`, line: null, item: null, points: null });
    } else {
      const now = computeDiff({ root, given: runPlan.base.given, env: ctx.env, nuxtRoots: nuxtCandidates(root).map((c) => c.rel) });
      if (now.digest !== runPlan.digest) {
        for (const d of docs.filter((x) => x.refused === null)) d.refused = `Not saved: ${d.name} (the code changed since run ${runPlan.runId} was planned; run ${again} again)`;
      }
    }
    for (const n of (runPlan.needsFlow ?? []) as Item[]) items.push({ id: n.id, page: n.page, file: n.file, entry: n.entry ?? null });
    for (const l of readLinks(folder, runPlan.runId, manifest, again).links.filter((x) => x.accepted && x.id)) items.push({ id: l.id!, page: l.input.page!, file: l.input.file, entry: l.input.entry ?? null });
  }

  // Steps 2 to 4 against the effective version, before any browser starts.
  const effective = new Map(prot.flows.map((e) => [e.flow.name, e]));
  const repoEnv = [...prot.flows.flatMap((e) => envNames(e.flow.steps)), ...docs.flatMap((d) => (d.value ? envNames(d.value.steps) : []))];
  type Plan = { kind: 'new' | 'expects' | 'repair' | 'same' | 'pending'; text?: string; old?: Record<string, unknown>; working?: Record<string, unknown>; ours?: boolean };
  const plans = new Map<Doc, Plan>();
  const heldLine = (d: Doc) => `Not saved: ${d.name} (flows/${d.name}.yaml has an edit rough-ride didn't make, which is held until merged. Report it to the user.)`;
  // Check 4 against the effective version E: refused, or the plan for the runs.
  const planAgainst = (d: Doc, old: Record<string, unknown>): Plan | null => {
    const change = compareFlow({ signedIn: d.value!.signedIn, steps: d.value!.steps }, old);
    if (change.kind === 'weakened') {
      d.refused = /^(removes|changes) the expect/.test(change.text)
        ? `Proposed, not saved: ${change.text.replace(/ \(.*\)$/, '')}`
        : `Not saved: ${d.name} (${change.text})`;
      return null;
    }
    if (change.kind === 'same') return { kind: 'same' };
    if (change.kind === 'expects-added') return { kind: 'expects', text: `adds an expect at step ${addedExpectStep(d.value!, old)}`, old };
    return { kind: 'repair', text: change.text.replace(/ changed$/, ' repaired'), old };
  };
  for (const d of docs.filter((x) => x.refused === null)) {
    d.refused = envValueRefusal(d.name, d.value!, repoEnv, read);
    if (d.refused) continue;
    const rel = `flows/${d.name}.yaml`;
    const e = effective.get(d.name);
    const w = files.flows.find((f) => f.shown === `.rough-ride/${rel}`);
    // Changed steps: R's baseline run in this call decides whether W or R is E (26.5 rule 2).
    if (w?.value && e?.stepsChanged) {
      const sw = e.stepsChanged.working;
      plans.set(d, { kind: 'pending', old: { signedIn: e.flow.signedIn, steps: e.flow.steps }, working: { signedIn: sw.signedIn, steps: sw.steps }, ours: manifest.label(rel, w.text) === 'saved by flow save' });
      continue;
    }
    // An outside edit held back for a settled reason: weakened, invalid or deleted.
    if ((w?.value && !e) || (e && e.used !== 'working-tree')) {
      d.refused = heldLine(d);
      continue;
    }
    if (!e) {
      if (runPlan && d.name !== 'sign-in') {
        if (d.item === null) {
          d.refused = `Not saved: ${d.name} (a new flow names the needsFlow item it is for, such as ${d.name}:n1)`;
          continue;
        }
        if (!items.some((it) => it.id === d.item)) {
          d.refused = `Not saved: ${d.name} (run ${runPlan.runId} has no needsFlow item ${d.item})`;
          continue;
        }
        if (newCount >= limits!.newFlows) {
          d.refused = newLimitLine(d.name);
          limitRecord(d);
          continue;
        }
      }
      plans.set(d, { kind: 'new' });
      continue;
    }
    const plan = planAgainst(d, { signedIn: e.flow.signedIn, steps: e.flow.steps });
    if (plan) plans.set(d, plan);
  }

  const toRun = docs.filter((d) => d.refused === null && plans.get(d)?.kind !== 'same');
  for (const d of docs.filter((x) => plans.get(x)?.kind === 'same')) d.line = `Saved: flows/${d.name}.yaml (unchanged)`;
  // A missing ${env} variable stops before anything runs or is written.
  for (const d of toRun) checkEnv(toFlow(d.name, d.value!), read, folder, ctx.env);
  if (toRun.length > 0) {
    // The committed sign-in flow always runs, so its variables are checked too (51.8).
    if (!toRun.some((d) => d.name === 'sign-in')) checkSignInEnv(prot.flows.map((e) => e.flow), folder, ctx.env);
    const config = prot.config;
    // Saving sign-in runs that version as the sign-in flow.
    const newSignIn = toRun.find((d) => d.name === 'sign-in');
    const flows = [...prot.flows.map((e) => e.flow).filter((f) => !(newSignIn && f.name === 'sign-in')), ...(newSignIn ? [toFlow('sign-in', newSignIn.value!)] : [])];
    // Under --run the run folder exists already, and flow save prunes nothing.
    const session = await openTargetSession({
      root, folder, files, info, argv: ctx.argv, env: ctx.env, notes: ctx.notes, report: ctx.report, config, flows,
      start: ctx.start, againCommand: runPlan ? followUpCommand(info, planAgain(runPlan)) : 'flow save', browserFlag: ctx.browserFlag, ...(ctx.launch ? { launch: ctx.launch } : {}),
      elapsed: ctx.elapsed, run: runDir ? { existing: runDir, prune: false } : { create: 'flow' }, reset: true, read,
    });
    const { target } = session;
    const run = session.run!;
    runDir = run;
    try {
      await session.reset();
      const signInOutcome = await session.signIn(newSignIn ? { untrusted: true } : {});
      if (newSignIn) {
        if (!signInOutcome.passed) {
          const stop = (signInOutcome.result as { untrustedStop?: string | null } | null)?.untrustedStop;
          newSignIn.refused = stop ? `Not saved: sign-in (${stop})` : failedLine(newSignIn.name, signInOutcome.result, null);
        }
      }
      const once = async (flow: Flow): Promise<{ result: FlowRunResult & { untrustedStop?: string | null }; snapshot: string | null }> => {
        let snapshot: string | null = null;
        const result = await runFlow({
          ...session.defaults(flow),
          flow,
          // 44.5: destructive writes and other sites are aborted in these runs.
          untrusted: true,
          onFailure: async (page) => {
            const text = await page.locator('body').ariaSnapshot().catch(() => '');
            writeAtomic(folder, ['runs', run.id, 'snapshots', `${flow.name}.txt`], text + '\n');
            snapshot = printed(path.join(run.dir, 'snapshots', `${flow.name}.txt`));
          },
        });
        return { result, snapshot };
      };
      for (const d of toRun.filter((x) => x.refused === null)) {
        let plan = plans.get(d)!;
        const flow = toFlow(d.name, d.value!);
        if (flow.signedIn && !signInOutcome.passed) {
          d.refused = `Not saved: ${d.name} (${signInOutcome.ran ? 'sign-in failed' : 'no sign-in flow'}, so a signed-in flow can't run)`;
          continue;
        }
        const bashLine = `Not saved: ${d.name} (stopped by the Bash time limit; save it in another call)`;
        if (session.bashBlocks()) {
          d.refused = bashLine;
          continue;
        }
        ctx.progress(`Baseline run: ${d.name}`);
        if (plan.kind === 'pending') {
          if (session.bashBlocks()) {
            d.refused = bashLine;
            continue;
          }
          const reviewed = await once(toFlow(d.name, plan.old!));
          // R fails: W is E. R passes: R is E, and W is held back unless flow save wrote it.
          if (!reviewed.result.passed) {
            const entry = effective.get(d.name)?.stepsChanged?.entry;
            if (entry) {
              entry.used = 'working-tree';
              entry.outcome = 'ran this version';
              entry.change += `; the ${prot.base?.shown ?? 'reviewed'} version fails its baseline run`;
              entry.weakening = false;
            }
            const next = planAgainst(d, plan.working!);
            if (!next) continue;
            plan = next;
          } else if (!plan.ours) {
            d.refused = heldLine(d);
            continue;
          } else {
            const next = planAgainst(d, plan.old!);
            if (!next) continue;
            if (next.kind === 'repair') {
              d.refused = `Not saved: ${d.name} (${next.text!.replace(/ repaired$/, ' changed')} while flows/${d.name}.yaml passes its baseline run)`;
              continue;
            }
            // Back to the reviewed version: written over flow save's own repair.
            plan = next.kind === 'same' ? { kind: 'expects', text: 'same as the reviewed version' } : next;
          }
          if (plan.kind === 'same') {
            d.line = `Saved: flows/${d.name}.yaml (unchanged)`;
            continue;
          }
        }
        if (runPlan && plan.kind === 'repair') {
          if (prior.get(d.name)?.repaired || prior.get(d.name)?.kind === 'repair') {
            d.refused = `Not saved: ${d.name} (run ${runPlan.runId} already repaired it once; one repair per flow)`;
            continue;
          }
          if (repairCount >= limits!.repairs) {
            d.refused = `Not saved: ${d.name} (run ${runPlan.runId} already repaired ${limits!.repairs} flows, the ${runPlan.tier} limit)`;
            continue;
          }
        }
        // A new flow uses a slot only once kept, so earlier failures in this call don't count.
        if (runPlan && plan.kind === 'new' && d.name !== 'sign-in' && newCount >= limits!.newFlows) {
          d.refused = newLimitLine(d.name);
          limitRecord(d);
          continue;
        }
        if (plan.kind === 'repair') {
          // Changed steps need the effective version to fail its baseline run in this call.
          if (session.bashBlocks()) {
            d.refused = bashLine;
            continue;
          }
          const old = await once(toFlow(d.name, plan.old!));
          if (old.result.passed) {
            d.refused = `Not saved: ${d.name} (${plan.text!.replace(/ repaired$/, ' changed')} while flows/${d.name}.yaml passes its baseline run)`;
            continue;
          }
        }
        const times = plan.kind === 'new' && d.name !== 'sign-in' ? 2 : 1;
        const runs: FlowRunResult[] = [];
        if (d.name === 'sign-in') {
          // The sign-in run above was this version's baseline run.
          if (plan.kind === 'new' && signInOutcome.passed) {
            if (session.bashBlocks()) d.refused = bashLine;
            else {
              const again = await session.signInAgain({ untrusted: true });
              const stop = (again.result as { untrustedStop?: string | null } | null)?.untrustedStop;
              if (!again.passed) d.refused = stop ? `Not saved: sign-in (${stop})` : failedLine(d.name, again.result, null);
            }
          }
        } else {
          for (let i = 0; i < times && d.refused === null; i++) {
            if (session.bashBlocks()) {
              d.refused = bashLine;
              break;
            }
            const r = await once(flow);
            if (r.result.untrustedStop) d.refused = `Not saved: ${d.name} (${r.result.untrustedStop})`;
            else if (!r.result.passed) d.refused = failedLine(d.name, r.result, r.snapshot);
            else runs.push(r.result);
          }
        }
        // The keep rule (16.8): a new flow for an item is kept only if its footprint reaches it.
        const item = runPlan && plan.kind === 'new' ? items.find((it) => it.id === d.item) ?? null : null;
        if (d.refused === null && item) {
          const why = keepProblem(item, runs, root, target.nuxtRoot?.rel ?? null, runPlan?.routes ?? null);
          if (why) {
            d.refused = `Not saved: ${d.name} (${why})`;
            records.push({ name: d.name, item: item.id, kind: 'new', kept: false, why, file: item.file, points: [], forms: [] });
          }
        }
        if (d.refused) {
          // A new flow for an item that never got two passing runs: `no passing flow for <page>` (16.8).
          if (item && !records.some((r) => r.name === d.name)) records.push({ name: d.name, item: item.id, kind: 'new', kept: false, why: d.refused, file: item.file, page: item.page, points: [], forms: [] });
          continue;
        }
        const text = `schema: ${FORMATS.flow.current}\n${d.text.replace(/\n*$/, '\n')}`;
        const rel = `flows/${d.name}.yaml`;
        writeProtected({ folder, manifest, files, info, root, nuxtRel: target.nuxtRoot?.rel ?? null, argv: ctx.argv }, `flows/${d.name}.yaml`, text, 'flow save', run.id);
        d.line = `Saved: ${rel} (${plan.kind === 'new' ? 'new, passed twice' : plan.text})`;
        if (runPlan) {
          // 44.3: the saved flow's attack points, for the adversary and for attack.
          const last = runs.at(-1);
          const points = [...new Set((last?.requests ?? []).filter((q) => (q.resourceType === 'fetch' || q.resourceType === 'xhr') && !isFrameworkInternal(q.url) && session.hosts.ownHost(q.url)).map((q) => q.key))];
          const forms = [...new Set((last?.requests ?? []).filter((q) => q.method === 'POST' && (q.resourceType === 'fetch' || q.resourceType === 'xhr') && !isFrameworkInternal(q.url)).map((q) => q.key.replace(/ #\d+$/, '')))];
          d.points = `  points: ${points.join(', ') || 'none'}${forms.length > 0 ? `; forms: ${forms.join(', ')}` : ''}`;
          const before = prior.get(d.name);
          const kind = before?.kind === 'new' || before?.kind === 'repair' ? before.kind : plan.kind === 'new' ? 'new' : plan.kind === 'repair' ? 'repair' : 'other';
          const record: SavedRecord = { name: d.name, item: before?.item ?? d.item, kind, kept: true, repaired: !!before?.repaired || plan.kind === 'repair', why: null, file: before?.file ?? item?.file ?? null, points, forms };
          records.push(record);
          prior.set(d.name, record);
          if (plan.kind === 'new' && !before) newCount++;
          if (plan.kind === 'repair') repairCount++;
        }
      }
    } catch (error) {
      throw session.withRun(error);
    } finally {
      await session.close();
    }
  }

  if (runPlan) for (const r of records) writeAtomic(folder, ['runs', runPlan.runId, 'adversary', 'saved', `${r.name}.json`], asciiJson(JSON.stringify(r, null, 2)) + '\n');
  // Under --run the call is adversary time: timed, never budgeted (42.7).
  if (ctx.runId !== null && runDir) recordCall(folder, runDir.id, 'flow save', ctx.elapsed());
  const out = docs.flatMap((d) => (d.line ? [d.line, ...(d.points ? [d.points] : [])] : [d.refused!]));
  const saved = docs.filter((d) => d.line !== null).length;
  const header = ['rough-ride flow save', formatDuration(ctx.elapsed()), ...(runDir ? [`run ${runDir.id}`] : [])].join(' | ');
  const sections: Section[] = [
    { id: 'header', lines: [header] },
    { id: 'protected', lines: protectedSummary(prot) },
    { id: 'flows', lines: out },
    { id: 'runner', lines: runnerBlock(info) },
  ].filter((x) => x.lines.length > 0) as Section[];
  const lines = sections.flatMap((x) => x.lines);
  const allSaved = saved === docs.length;
  return {
    run: ctx.runId === null ? runDir : null,
    lines,
    document: { sections, protectedLines: prot.entries.length === 0 ? [] : blockWithHints(prot), flowSave: docs.map((d) => ({ name: d.name, saved: d.line !== null, line: d.line ?? d.refused })) },
    status: allSaved ? 'passed' : 'incomplete',
    exitCode: allSaved ? 0 : 2,
  };
}

function failedLine(name: string, result: FlowRunResult | null, snapshot: string | null): string {
  const f = result?.failure;
  if (!f) return `Not saved: ${name} (its baseline run failed)`;
  const message = f.message.startsWith(`${f.label}: `) ? f.message.slice(f.label.length + 2) : f.message;
  return `Not saved: ${name} (step ${f.step} failed: "${firstLine(message)}"${snapshot ? `; snapshot: ${snapshot}` : ''})`;
}

export function readSaved(folder: FolderState, runId: string): SavedRecord[] {
  const dir = path.join(folder.dir, 'runs', runId, 'adversary', 'saved');
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    try {
      return [JSON.parse(readFileSync(path.join(dir, n), 'utf8')) as SavedRecord];
    } catch {
      return [];
    }
  });
}

// Why a new flow does not reach its item, or null (16.8): it reaches it when a
// run loaded the item's file or visited its page; an `entry: in-app` link item
// also needs every run to enter the page in-app.
export function keepProblem(item: { page: string; file: string; entry: string | null }, runs: FlowRunResult[], root: string, nuxtRoot: string | null, routes: string[] | null = null): string | null {
  const visits = (r: FlowRunResult) => r.pages.some((p) => samePage(routes, item.page, p.path));
  if (item.entry === 'in-app') {
    if (!runs.every((r) => r.pages.some((p) => samePage(routes, item.page, p.path) && p.entry === 'in-app'))) return `enters ${item.page} by full page load only`;
    return null;
  }
  const repo = repoFiles(root);
  const loaded = runs.some((r) => r.requests.some((q) => moduleFiles(q.url, repo, root, nuxtRoot).files.includes(item.file)));
  if (loaded || runs.some(visits)) return null;
  return `new flow does not reach ${item.file}`;
}
