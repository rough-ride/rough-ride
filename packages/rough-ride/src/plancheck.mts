// `attack --run <id> --plan - --check` (spec part 11 section 45.3): the same
// validation against plan's data and adversary/saved/, with no flow run.
// Final validation still happens against the fresh baseline runs in attack.

import { specFacts } from './appchecks.mjs';
import type { PlannedAttack } from './attacks.mjs';
import { readSaved } from './flowsave.mjs';
import type { FolderState } from './folder.mjs';
import { Manifest } from './manifest.mjs';
import { formatDuration } from './output.mjs';
import { parsePlan, validatePlan, type PlanInput } from './plan.mjs';
import { runnerBlock, type RunnerInfo } from './runner.mjs';
import { callCount, checkRun, recordCall, type PlanState } from './runcheck.mjs';
import type { Section } from './summary.mjs';

const STICKY_BY_DEFAULT = new Set(['500', '400', '429', 'reset', 'malformed-json', 'empty-200', '401', 'hang']);

// A stand-in for an attack the fresh run would build: only its id and flow matter here.
const stub = (flow: string, id: string): PlannedAttack => ({ id, flow } as PlannedAttack);

export function checkPlan(input: PlanInput, plan: PlanState, saved: string[], folder?: FolderState) {
  const outline = plan.flows as { name: string; aboveCut: boolean; requests?: { key: string }[]; forms?: { form: string }[] }[];
  const allFlows = new Set([...(plan.flowPages ?? []).map((f) => f.name), ...outline.map((f) => f.name), ...saved]);
  return validatePlan(input, {
    tier: plan.tier,
    aboveFlows: new Set([...outline.filter((f) => f.aboveCut).map((f) => f.name), ...saved]),
    allFlows,
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
    selected: new Set(plan.selected ?? []),
    fault: (flow, request, fault, oneShot) => {
      const known = outline.find((f) => f.name === flow);
      // A flow saved in this run has no recorded footprint yet; attack checks its points.
      if (known && !(known.requests ?? []).some((q) => q.key === request)) return `${request} is not an attack point of ${flow}`;
      const sticky = !oneShot && STICKY_BY_DEFAULT.has(fault);
      return stub(flow, `${flow}/${request}/${fault}${sticky ? '!' : ''}`);
    },
    badInputs: (flow, form) => {
      const known = outline.find((f) => f.name === flow);
      if (known && (known.forms ?? []).length === 0) return `${typeof form === 'string' ? form : 'that form'} is not a form of ${flow}`;
      return Array.from({ length: 12 }, (_, i) => stub(flow, `${flow}/${typeof form === 'string' ? form : 'form'}/input-${i + 1}`));
    },
    viewport: (flow) => (flow === 'sign-in' ? 'no viewport attack on the sign-in flow' : stub(flow, `${flow}/viewport-375`)),
  });
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
  const kept = result.entries.filter((e) => e.status === 'kept').length + result.checks.filter((e) => e.status === 'kept').length;
  const body = ['Plan check:', ...parsed.warnings, ...result.lines, `Plan check: ${kept} ${kept === 1 ? 'entry' : 'entries'} valid, ${result.kept.length} planned ${result.kept.length === 1 ? 'attack' : 'attacks'}`];
  const rejected = result.entries.some((e) => e.status === 'rejected') || result.lines.some((l) => l.startsWith('Rejected plan entry'));
  return finish(body, rejected ? 2 : 0);
}
