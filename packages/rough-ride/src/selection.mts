// Selection after the baseline runs (spec part 4 sections 16 to 18): OpenAPI
// keys, backend endpoints, reach, forms, flow order and the accounting. Runs
// while the dev server still answers, because tracing reads its modules.

import { account, type Accounting, type AttackLink, type FlowInfo } from './accounting.mjs';
import { traceBackend, type BackendResult } from './backend.mjs';
import type { Diff } from './diff.mjs';
import { findForms, flowClass, orderFlows, type FlowClass, type Form } from './forms.mjs';
import { isFrameworkInternal, isLoopbackHostname, type Flow, type FlowRunResult } from './flowrun.mjs';
import { apiOrigins, fetchOpenApi, rekey, type OpenApiDoc } from './openapi.mjs';
import { repoFiles, reachedVia, traceReach, type TracingResult } from './tracing.mjs';

export interface FlowRuns {
  flow: Flow;
  passed: boolean;
  excluded: boolean;
  runs: FlowRunResult[];
}

export interface SelectedFlow {
  name: string;
  cls: FlowClass;
  reachCount: number;
  forms: Form[];
}

export interface Selection {
  docs: OpenApiDoc[];
  backend: BackendResult;
  tracing: TracingResult;
  accounting: Accounting;
  // Reached flows in attack order.
  ordered: SelectedFlow[];
  formsByFlow: Map<string, Form[]>;
  changedEndpoints: Set<string>;
  flowInfo: FlowInfo[];
}

export async function select(options: {
  baseURL: string;
  root: string;
  nuxtRoot: string | null;
  noProvenRoot: boolean;
  remoteTarget: string | null;
  allowedHosts: string[];
  diff: Diff;
  flows: FlowRuns[];
  signIn: 'none' | 'passed' | 'failed';
  attacks: AttackLink[];
  attacksBuilt: boolean;
  tier: string;
}): Promise<Selection> {
  const results = options.flows.flatMap((f) => f.runs);
  const docs = await fetchOpenApi(apiOrigins(results, options.remoteTarget), results);
  for (const r of results) rekey(r, docs);
  const files = repoFiles(options.root);
  const backend = traceBackend({
    root: options.root,
    diff: options.diff,
    docs,
    nuxtRoot: options.nuxtRoot,
    pythonFiles: files.filter((f) => f.endsWith('.py')),
  });
  const tracing = await traceReach({
    baseURL: options.baseURL,
    root: options.root,
    nuxtRoot: options.nuxtRoot,
    noProvenRoot: options.noProvenRoot,
    flows: options.flows.map((f) => ({ name: f.flow.name, passed: f.passed, runs: f.runs })),
    diff: options.diff.files,
    files,
  });
  // Backend app-wide files (module-level Python, Nuxt server middleware) join the app-wide set.
  for (const f of backend.appWide) if (!tracing.appWide.includes(f)) tracing.appWide.push(f);
  if (backend.appWide.length > 0 && !tracing.notes.some((n) => n.id === 'app-wide-change') && options.flows.length > 0) {
    tracing.notes.push({ id: 'app-wide-change', text: `App-wide change (${tracing.appWide.join(', ')}): ${options.flows.length} saved flows in scope at the lowest priority` });
  }

  const changedEndpoints = new Set(backend.endpoints.map((e) => e.endpoint));
  const ownHost = (url: string) => {
    try {
      const host = new URL(url).hostname;
      return isLoopbackHostname(host) || options.allowedHosts.includes(host);
    } catch {
      return false;
    }
  };
  const via = reachedVia(tracing, options.diff.files);
  const formsByFlow = new Map<string, Form[]>();
  const flowInfo: FlowInfo[] = [];
  const reachedFlows: SelectedFlow[] = [];
  for (const f of options.flows) {
    const run = f.runs[0];
    const forms = run ? findForms(f.flow, run, ownHost, changedEndpoints) : [];
    formsByFlow.set(f.flow.name, forms);
    const reach = new Map<string, string>();
    for (const [file, list] of via) for (const v of list) if (v.flow === f.flow.name) reach.set(file, v.rule);
    for (const file of tracing.appWide) reach.set(file, reach.get(file) ?? 'app-wide');
    const sent = new Set(f.runs.flatMap((r) => r.requests.filter((q) => (q.resourceType === 'fetch' || q.resourceType === 'xhr') && !isFrameworkInternal(q.url)).map((q) => q.key.replace(/ #\d+$/, ''))));
    const r = tracing.reach.find((x) => x.flow === f.flow.name);
    flowInfo.push({
      name: f.flow.name,
      signedIn: f.flow.signedIn,
      passed: f.passed,
      excluded: f.excluded,
      reach,
      firstLoad: r?.firstLoad ?? new Map(),
      sent,
      pages: f.runs.flatMap((x) => x.pages),
      attackPointSteps: [...new Set(f.runs.flatMap((x) => x.requests.filter((q) => (q.resourceType === 'fetch' || q.resourceType === 'xhr') && ownHost(q.url) && !isFrameworkInternal(q.url)).map((q) => q.step)))],
    });
    const byRule = [...reach.values()].some((rule) => rule === 'module' || rule === 'page');
    const cls = flowClass({ forms, requestKeys: [...sent], changedEndpoints, reachesByRule: byRule }) ?? (tracing.appWide.length > 0 ? 'app-wide' : null);
    if (cls === null) continue;
    const reachCount = [...reach.values()].length + [...sent].filter((k) => changedEndpoints.has(k)).length;
    reachedFlows.push({ name: f.flow.name, cls, reachCount, forms });
  }
  const accounting = account({
    files: options.diff.files,
    endpoints: backend.endpoints,
    untraced: backend.untraced,
    flows: flowInfo,
    signIn: options.signIn,
    modulesOn: tracing.modules,
    attacks: options.attacks,
    attacksBuilt: options.attacksBuilt,
    tier: options.tier,
  });
  const ordered = orderFlows(reachedFlows).map((o) => reachedFlows.find((r) => r.name === o.name)!);
  return { docs, backend, tracing, accounting, ordered, formsByFlow, changedEndpoints, flowInfo };
}

// `-> 3 flows, 4 endpoints, 2 forms`, zero parts left out.
export function reachCounts(selection: Selection): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const forms = selection.ordered.reduce((n, f) => n + f.forms.length, 0);
  const parts = [
    selection.ordered.length > 0 ? plural(selection.ordered.length, 'flow') : null,
    selection.changedEndpoints.size > 0 ? plural(selection.changedEndpoints.size, 'endpoint') : null,
    forms > 0 ? plural(forms, 'form') : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? ` -> ${parts.join(', ')}` : '';
}
