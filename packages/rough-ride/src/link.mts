// `link --run <id>` (spec part 11 section 44.2, part 4 section 16.7): adversary
// links from changed files to endpoints, flows or pages, accepted or rejected
// against the run's own data, appended to adversary/links.json.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { asciiJson } from './adversary.mjs';
import { checkCommittedFiles } from './files.mjs';
import { ensureFolder, type FolderState } from './folder.mjs';
import { matchesExclude } from './flowrun.mjs';
import { Manifest } from './manifest.mjs';
import { formatDuration, type Note } from './output.mjs';
import { compareProtected, summaryLines as protectedSummary } from './protected.mjs';
import { runnerBlock, type RunnerInfo } from './runner.mjs';
import type { RunReport } from './runoutput.mjs';
import { callCount, checkRun, recordCall, tierCommand, type PlanState } from './runcheck.mjs';
import type { Section } from './summary.mjs';
import { routeMatches, samePage } from './tracing.mjs';
import { writeAtomic } from './write.mjs';

const MAX_INPUT = 24 * 1024;
export const LINKS = ['adversary', 'links.json'];

export interface LinkInput {
  file: string;
  endpoint?: string;
  flow?: string;
  page?: string;
  entry?: 'in-app';
  because: string;
}

export interface LinkResult {
  input: LinkInput;
  accepted: boolean;
  // l1, l2 ... for an accepted page link: a needsFlow item.
  id: string | null;
  why: string | null;
}

export interface LinksFile {
  links: LinkResult[];
}

// links.json as link wrote it: an altered, unreadable or deleted copy is
// refused with exit 75 when read back (42.4, 43.3).
export function readLinks(folder: FolderState, runId: string, manifest: Manifest, again: string): LinksFile {
  const file = path.join(folder.dir, 'runs', runId, ...LINKS);
  if (!existsSync(file) && !manifest.hasRun(runId, LINKS.join('/'))) return { links: [] };
  let value: unknown = null;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    value = null;
  }
  manifest.verifyRun(runId, LINKS.join('/'), value, 'links.json', again);
  return value as LinksFile;
}

const target = (l: Partial<LinkInput>) => (l.endpoint !== undefined ? l.endpoint : l.flow !== undefined ? `flow ${l.flow}` : `page ${l.page}`);

// The input's own shape: exactly one target, an ASCII `because` of 1 to 160 characters.
export function shapeProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'a link is a mapping';
  const l = raw as Record<string, unknown>;
  const kinds = ['endpoint', 'flow', 'page'].filter((k) => l[k] !== undefined);
  if (kinds.length !== 1) return 'a link names exactly one of endpoint, flow or page';
  for (const key of Object.keys(l)) if (!['file', 'endpoint', 'flow', 'page', 'entry', 'because'].includes(key)) return `unknown field ${key}`;
  if (typeof l.file !== 'string' || l.file === '') return 'file is missing';
  if (typeof l[kinds[0]!] !== 'string') return `${kinds[0]} is not text`;
  if (l.entry !== undefined && (l.entry !== 'in-app' || kinds[0] !== 'page')) return 'entry: in-app goes only with a page';
  if (typeof l.because !== 'string' || !/^[\x20-\x7e]{1,160}$/.test(l.because)) return 'because is one ASCII line of 1 to 160 characters';
  return null;
}

export interface RunData {
  changed: { path: string; class: string }[];
  plan: PlanState;
  exclude: string[];
}

// 16.7's acceptance rules against the run's data; null when accepted.
export function linkProblem(l: LinkInput, data: RunData): string | null {
  const file = data.changed.find((f) => f.path === l.file);
  if (!file || !['app', 'config', 'dependency'].includes(file.class)) return 'not a changed app, config or dependency file';
  const flows = data.plan.flowPages ?? [];
  if (l.endpoint !== undefined) {
    const key = l.endpoint.replace(/\{[^}]*\}/g, '{}');
    const recorded = flows.some((f) => f.requests.includes(key));
    if (!(data.plan.apiKeys ?? []).includes(key) && !recorded) return 'in no OpenAPI document and no recorded request';
    return null;
  }
  if (l.flow !== undefined) {
    const flow = flows.find((f) => f.name === l.flow);
    if (!flow) return `no saved flow named ${l.flow}`;
    if (!flow.passed) return `${l.flow} failed its baseline run`;
    return null;
  }
  const page = l.page!;
  if (!page.startsWith('/') || page.startsWith('//')) return 'a page is a path on the target, such as /notes';
  if (data.exclude.some((p) => matchesExclude(p, page))) return 'under exclude in config.yaml';
  if (data.plan.routes && !data.plan.routes.some((r) => routeMatches(r, page))) return 'no Nuxt route matches it';
  if (l.entry === 'in-app') {
    const already = flows.find((f) => f.passed && f.pages.some((pg) => pg.entry === 'in-app' && samePage(data.plan.routes ?? null, page, pg.path)));
    if (already) return `${already.name} already enters it in-app`;
  }
  return null;
}

export interface LinkContext {
  root: string;
  folder: FolderState;
  info: RunnerInfo;
  runId: string;
  stdin: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  notes: Note[];
  // Where the run reports its run folder, protected comparison and contract.
  report: RunReport;
  elapsed: () => number;
}

export function runLink(ctx: LinkContext): { lines: string[]; document: Record<string, unknown>; status: 'passed' | 'incomplete'; exitCode: 0 | 2 } {
  const { root, info } = ctx;
  const folder = ensureFolder(ctx.folder);
  const manifest = new Manifest(root);
  const plan = checkRun(folder, ctx.runId, info, manifest);
  ctx.report.namedRun({ id: ctx.runId, dir: path.join(folder.dir, 'runs', ctx.runId) }, false);
  let protLines: string[] = [];
  const finish = (body: string[], exitCode: 0 | 2) => {
    const header = ['rough-ride link', formatDuration(ctx.elapsed()), `run ${ctx.runId}`].join(' | ');
    const sections: Section[] = [{ id: 'header', lines: [header] }, { id: 'protected', lines: protLines }, { id: 'flows', lines: body }, { id: 'runner', lines: runnerBlock(info) }].filter((x) => x.lines.length > 0) as Section[];
    return { lines: sections.flatMap((x) => x.lines), document: { sections }, status: exitCode === 0 ? 'passed' as const : 'incomplete' as const, exitCode };
  };
  if (callCount(folder, ctx.runId, 'link') >= 2) return finish([`Not run: link (run ${ctx.runId} already made 2 link calls)`], 2);
  const files = checkCommittedFiles(folder, { info, subcommand: 'link', argv: ctx.argv, env: ctx.env, report: ctx.report });
  const prot = compareProtected({ root, folderDir: folder.dir, files, env: ctx.env, pluginData: !!info.pluginData, manifest });
  ctx.report.protectedFiles(prot);
  protLines = protectedSummary(prot);
  ctx.notes.push(...files.notes, ...prot.notes);

  let raw: unknown = null;
  let inputProblem: string | null = null;
  if (Buffer.byteLength(ctx.stdin) > MAX_INPUT) inputProblem = 'input over 24 KB';
  else if (/[^\t\r\n\x20-\x7e]/.test(ctx.stdin)) inputProblem = 'non-ASCII byte: write it as \\uXXXX inside double quotes';
  else {
    try {
      raw = parse(ctx.stdin);
    } catch {
      inputProblem = 'not one YAML list';
    }
    if (inputProblem === null && !Array.isArray(raw)) inputProblem = 'not one YAML list';
  }
  if (inputProblem) {
    recordCall(folder, ctx.runId, 'link', ctx.elapsed());
    return finish([`Not run: link (${inputProblem})`], 2);
  }

  const map = JSON.parse(readFileSync(path.join(folder.dir, 'runs', ctx.runId, 'diff-map.json'), 'utf8')) as { files: { path: string; class: string }[] };
  const data: RunData = { changed: map.files, plan, exclude: prot.config?.exclude ?? [] };
  const existing = readLinks(folder, ctx.runId, manifest, tierCommand(info, plan.tier));
  let nextId = existing.links.filter((l) => l.id !== null).length + 1;
  const out: string[] = [];
  const results: LinkResult[] = [];
  for (const item of raw as unknown[]) {
    const shape = shapeProblem(item);
    const l = item as LinkInput;
    if (shape) {
      out.push(`Rejected adversary link: ${typeof l?.file === 'string' ? l.file : '?'} -> ${l && typeof l === 'object' ? target(l) : '?'} (${shape})`);
      results.push({ input: l, accepted: false, id: null, why: shape });
      continue;
    }
    const why = linkProblem(l, data);
    if (why) {
      out.push(`Rejected adversary link: ${l.file} -> ${target(l)} (${why})`);
      results.push({ input: l, accepted: false, id: null, why });
      continue;
    }
    const id = l.page !== undefined ? `l${nextId++}` : null;
    out.push(`Accepted adversary link${id ? ` ${id}` : ''}: ${l.file} -> ${target(l)}${l.entry ? ` (entry: ${l.entry})` : ''}`);
    results.push({ input: l, accepted: true, id, why: null });
  }
  const value: LinksFile = { links: [...existing.links, ...results] };
  // Read back by flow save and attack, so its hash goes into the manifest as it is written (43.3).
  writeAtomic(folder, ['runs', ctx.runId, ...LINKS], asciiJson(JSON.stringify(value, null, 2)) + '\n');
  manifest.recordRun(ctx.runId, LINKS.join('/'), JSON.parse(JSON.stringify(value)));
  recordCall(folder, ctx.runId, 'link', ctx.elapsed());
  return finish(out, 0);
}
