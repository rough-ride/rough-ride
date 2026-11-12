// `attack --run <id> --plan - --check` (spec part 11 section 45.3): the same
// validation against plan's data and adversary/saved/, with no flow run.
// Final validation still happens against the fresh baseline runs in attack.

import { specFacts } from './appchecks.mjs';
import { fromRecord, planCandidates } from './catalogue.mjs';
import { stopWith } from './exit.mjs';
import { readSaved } from './flowsave.mjs';
import type { FolderState } from './folder.mjs';
import { Manifest } from './manifest.mjs';
import { formatDuration } from './output.mjs';
import { parsePlan, validatePlan, type PlanInput, type PlanResult } from './plan.mjs';
import { followUpCommand, runnerBlock, type RunnerInfo } from './runner.mjs';
import { callCount, CATALOGUE, checkRun, planAgain, recordCall, type PlanState } from './runcheck.mjs';
import type { Section } from './summary.mjs';

// The recorded Attack catalogue resolves entries as attack's fresh one will;
// entries on flows saved after the plan stay unchecked until attack.
export function checkPlan(input: PlanInput, plan: PlanState, saved: string[], folder?: FolderState) {
  const recorded = fromRecord(plan.catalogue);
  if (!recorded) throw new Error(`run ${plan.runId} has no recorded Attack catalogue`);
  const allFlows = new Set([...(plan.flowPages ?? []).map((f) => f.name), ...plan.flows.map((f) => f.name), ...saved]);
  return validatePlan(input, {
    ...planCandidates(recorded.catalogue, { selected: recorded.scope.selected, aboveFlows: [...recorded.scope.aboveFlows, ...saved], changedSince: saved }),
    // The static gates only: anchors on baseline text and the baseline gate wait for attack's fresh runs.
    checks: {
      specs: folder ? specFacts(folder, plan.specParts ?? []) : new Map(),
      flows: allFlows,
      footprint: (flow) => {
        const f = (plan.flowPages ?? []).find((x) => x.name === flow);
        return f ? { paths: f.pages.map((pg) => pg.path), requests: f.requests, steps: null, fills: null } : null;
      },
      apiKeys: plan.apiKeys ?? [],
    },
  });
}

// The closing count, then how many entries only attack can decide (45.3).
export function verdictLines(result: PlanResult): string[] {
  const kept = result.entries.filter((e) => e.status === 'kept').length + result.checks.filter((e) => e.status === 'kept').length;
  const unchecked = result.entries.filter((e) => e.status === 'unchecked').length;
  const lines = [`Plan check: ${kept} ${kept === 1 ? 'entry' : 'entries'} valid, ${result.kept.length} planned ${result.kept.length === 1 ? 'attack' : 'attacks'}`];
  if (unchecked > 0) lines.push(`Plan check: ${unchecked} ${unchecked === 1 ? 'entry' : 'entries'} unchecked; attack checks ${unchecked === 1 ? 'it' : 'them'} against fresh baseline runs`);
  return lines;
}

export interface PlanCheckContext {
  folder: FolderState;
  root: string;
  info: RunnerInfo;
  runId: string;
  stdin: string;
  elapsed: () => number;
}

export function runPlanCheck(ctx: PlanCheckContext): { lines: string[]; document: Record<string, unknown>; status: 'passed' | 'incomplete' | 'stopped'; exitCode: 0 | 2 | 78 } {
  const plan = checkRun(ctx.folder, ctx.runId, ctx.info, new Manifest(ctx.root));
  if (!fromRecord(plan.catalogue)) stopWith('refused-run-output', `Refused: run ${ctx.runId}'s ${CATALOGUE} is not one this runner reads. Run ${followUpCommand(ctx.info, planAgain(plan))} again.`);
  const finish = (body: string[], exitCode: 0 | 2 | 78) => {
    const header = ['rough-ride attack --check', formatDuration(ctx.elapsed()), `run ${ctx.runId}`].join(' | ');
    const sections: Section[] = [{ id: 'header', lines: [header] }, { id: 'flows', lines: body }, { id: 'runner', lines: runnerBlock(ctx.info) }].filter((x) => x.lines.length > 0) as Section[];
    return { lines: sections.flatMap((x) => x.lines), document: { sections }, status: exitCode === 0 ? 'passed' as const : exitCode === 2 ? 'incomplete' as const : 'stopped' as const, exitCode };
  };
  if (callCount(ctx.folder, ctx.runId, 'check') >= 2) return finish([`Not run: attack --check (run ${ctx.runId} already made 2 check calls)`], 2);
  recordCall(ctx.folder, ctx.runId, 'check', ctx.elapsed());
  const parsed = parsePlan(ctx.stdin, plan.tier);
  if (parsed.refused) return finish(['Plan check:', parsed.refused], 78);
  const saved = readSaved(ctx.folder, ctx.runId).filter((r) => r.kept).map((r) => r.name);
  const result = checkPlan(parsed.input!, plan, saved, ctx.folder);
  const body = ['Plan check:', ...parsed.warnings, ...result.lines, ...verdictLines(result)];
  const rejected = result.entries.some((e) => e.status === 'rejected') || result.lines.some((l) => l.startsWith('Rejected plan entry'));
  return finish(body, rejected ? 2 : 0);
}
