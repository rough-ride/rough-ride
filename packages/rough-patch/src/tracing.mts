// Which flows reach which changed files (spec part 4 sections 16.2, 16.3 and
// 16.6): the module rule on any Vite dev server, the page rule and the Nuxt
// exclusion on Nuxt, and app-wide changes.

import type { DiffFile } from './diff.mjs';
import type { FlowRunResult } from './flowrun.mjs';
import { git } from './git.mjs';
import type { Note } from './output.mjs';

export function repoFiles(root: string): string[] {
  const listed = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root);
  return listed.stdout.split('\0').filter(Boolean).map((f) => f.normalize('NFC'));
}

export interface ModuleMapping {
  files: string[];
  // More than one repository file matched.
  ambiguous: boolean;
}

// URL to repository file (16.2): drop origin, query and the /_nuxt/ base,
// skip Vite internals and node_modules, /@fs/ names an absolute path, and any
// other path names the file whose path ends with it at a segment boundary.
export function moduleFiles(url: string, files: string[], root: string, nuxtRoot: string | null): ModuleMapping {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return { files: [], ambiguous: false };
  }
  if (pathname.startsWith('/_nuxt/')) pathname = pathname.slice('/_nuxt'.length);
  if (/\/@vite\/|\/@id\/|\/node_modules\//.test(pathname) || pathname.startsWith('/@vite') || pathname.startsWith('/@id')) {
    return { files: [], ambiguous: false };
  }
  if (pathname.startsWith('/@fs/')) {
    let abs = pathname.slice('/@fs'.length);
    if (/^\/[A-Za-z]:\//.test(abs)) abs = abs.slice(1);
    const rootFwd = root.replace(/\\/g, '/').replace(/\/$/, '');
    const rel = abs.startsWith(`${rootFwd}/`) ? abs.slice(rootFwd.length + 1) : null;
    return { files: rel !== null && files.includes(rel) ? [rel] : [], ambiguous: false };
  }
  const tail = pathname.replace(/^\/+/, '');
  if (tail === '' || !tail.includes('.')) return { files: [], ambiguous: false };
  const pool = nuxtRoot ? files.filter((f) => f.startsWith(nuxtRoot)) : files;
  // The longest match wins; it must cover the whole file name.
  const segments = tail.split('/');
  for (let take = segments.length; take >= 1; take--) {
    const suffix = segments.slice(segments.length - take).join('/');
    const matches = pool.filter((f) => f === suffix || f.endsWith(`/${suffix}`));
    if (matches.length > 0) return { files: matches, ambiguous: matches.length > 1 };
  }
  return { files: [], ambiguous: false };
}

export function viteSeen(results: FlowRunResult[]): boolean {
  return results.some((r) => r.requests.some((q) => /\/@vite\/client(\?|$)/.test(safePath(q.url))));
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

export interface NuxtRoute {
  path: string;
  component: string;
  // Repository files in the component's import closure.
  closure: string[];
}

const IMPORT = /(?:import|export)\s*(?:[^'"]*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

// Nuxt's route module, read from the running dev server with no app edit and
// no build (16.3), with each route component's import closure.
export async function nuxtRoutes(baseURL: string, results: FlowRunResult[], files: string[], root: string, nuxtRoot: string | null): Promise<NuxtRoute[] | null> {
  const routeUrl = results
    .flatMap((r) => r.requests.map((q) => q.url))
    .find((u) => /virtual:nuxt:.*routes\.mjs/.test(decodeURIComponentSafe(u)));
  if (!routeUrl) return null;
  const fetchText = async (u: string) => {
    try {
      const res = await fetch(new URL(u, baseURL));
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  };
  const source = await fetchText(routeUrl);
  if (source === null) return null;
  const routes = [...source.matchAll(/path:\s*"([^"]+)"[\s\S]*?component:\s*\(\)\s*=>\s*import\("([^"]+)"\)/g)].map((m) => ({
    path: m[1]!,
    component: m[2]!,
  }));
  if (routes.length === 0) return null;
  const cache = new Map<string, string | null>();
  const closure = async (start: string): Promise<string[]> => {
    const seen = new Set<string>();
    const found = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const url = queue.shift()!.split('?')[0]!;
      if (seen.has(url)) continue;
      seen.add(url);
      const mapped = moduleFiles(new URL(url, baseURL).href, files, root, nuxtRoot);
      if (mapped.files.length === 0) continue;
      mapped.files.forEach((f) => found.add(f));
      if (!cache.has(url)) cache.set(url, await fetchText(url));
      for (const m of (cache.get(url) ?? '').matchAll(IMPORT)) {
        const spec = m[1] ?? m[2]!;
        if (spec.startsWith('/')) queue.push(spec);
      }
    }
    return [...found].sort();
  };
  const out: NuxtRoute[] = [];
  for (const r of routes) out.push({ ...r, closure: await closure(r.component) });
  return out;
}

function decodeURIComponentSafe(u: string): string {
  try {
    return decodeURIComponent(u);
  } catch {
    return u;
  }
}

// "/plants/:id()" and catch-alls against a page key such as /plants/{}.
export function routeMatches(routePath: string, pageKey: string): boolean {
  const page = pageKey.split('#')[0]!;
  const pattern = routePath
    .split('/')
    .map((seg) => {
      if (/^:[^/]*\(\.\*\)\*?$/.test(seg)) return '.*';
      if (seg.startsWith(':')) return '[^/]+';
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${pattern || '/'}$`).test(page) || (pattern.endsWith('/.*') && new RegExp(`^${pattern.slice(0, -3)}$`).test(page));
}

// The route Nuxt would pick for a path: of the matching routes, the one with
// the most static segments, then dynamic segments before catch-alls.
export function resolveRoute(routes: string[], page: string): string | null {
  const rank = (r: string) => r.split('/').reduce((n, seg) => n + (seg === '' ? 0 : !seg.startsWith(':') ? 100 : /\(\.\*\)/.test(seg) ? 0 : 1), 0);
  const matching = routes.filter((r) => routeMatches(r, page)).sort((a, b) => rank(b) - rank(a) || (a < b ? -1 : 1));
  return matching[0] ?? null;
}

// Two paths are the same page when Nuxt resolves both to one route, or, with no route table, when they are equal.
export function samePage(routes: string[] | null, a: string, b: string): boolean {
  if (a === b) return true;
  if (!routes) return false;
  const ra = resolveRoute(routes, a);
  return ra !== null && ra === resolveRoute(routes, b);
}

export interface FlowReach {
  flow: string;
  passed: boolean;
  // Repository files the flow reached, with the rule that reached each.
  via: Map<string, 'module' | 'page'>;
  loaded: Set<string>;
  // module-rule file -> the step that first loaded it.
  firstLoad: Map<string, number>;
}

export interface TracingResult {
  modules: boolean;
  pages: boolean;
  reach: FlowReach[];
  appWide: string[];
  notes: Note[];
  // Nuxt's routes with their import closures, or null without page tracing.
  routes: NuxtRoute[] | null;
}

export async function traceReach(options: {
  baseURL: string;
  root: string;
  nuxtRoot: string | null;
  // Set when target.url is set with no proven Nuxt root.
  noProvenRoot: boolean;
  flows: { name: string; passed: boolean; runs: FlowRunResult[] }[];
  diff: DiffFile[];
  files?: string[];
}): Promise<TracingResult> {
  const files = options.files ?? repoFiles(options.root);
  const all = options.flows.flatMap((f) => f.runs);
  const modulesOn = viteSeen(all);
  const notes: Note[] = [];
  let ambiguous = 0;
  const reach: FlowReach[] = [];
  const routes = options.nuxtRoot !== null ? await nuxtRoutes(options.baseURL, all, files, options.root, options.nuxtRoot) : null;
  const pagesOn = routes !== null;

  for (const flow of options.flows) {
    const via = new Map<string, 'module' | 'page'>();
    const loaded = new Set<string>();
    const firstLoad = new Map<string, number>();
    if (modulesOn) {
      for (const run of flow.runs) {
        for (const request of run.requests) {
          if (request.resourceType !== 'script' && request.resourceType !== 'stylesheet' && request.resourceType !== 'fetch') continue;
          const mapped = moduleFiles(request.url, files, options.root, options.nuxtRoot);
          if (mapped.ambiguous) ambiguous++;
          for (const f of mapped.files) {
            loaded.add(f);
            if (!firstLoad.has(f) || request.step < firstLoad.get(f)!) firstLoad.set(f, request.step);
          }
        }
      }
    }
    const visitedPaths = new Set(flow.runs.flatMap((r) => r.steps.map((s) => s.path).filter((p): p is string => p !== null)));
    if (routes) {
      const visited = routes.filter((r) => [...visitedPaths].some((p) => routeMatches(r.path, p)));
      const unvisited = routes.filter((r) => !visited.includes(r));
      const visitedFiles = new Set(visited.flatMap((r) => r.closure));
      const onlyUnvisited = new Set(unvisited.flatMap((r) => r.closure).filter((f) => !visitedFiles.has(f)));
      for (const f of loaded) if (!onlyUnvisited.has(f)) via.set(f, 'module');
      for (const f of visitedFiles) if (!via.has(f)) via.set(f, 'page');
    } else {
      for (const f of loaded) via.set(f, 'module');
    }
    reach.push({ flow: flow.name, passed: flow.passed, via, loaded, firstLoad });
  }

  if (!modulesOn) notes.push({ id: 'tracing', text: 'Module tracing: unavailable (no Vite dev server seen)' });
  if (!pagesOn) {
    const why = options.noProvenRoot ? 'no proven Nuxt root for target.url' : 'no Nuxt route module';
    notes.push({ id: 'tracing', text: `Page tracing: unavailable (${why})` });
  }
  if (ambiguous > 0) notes.push({ id: 'tracing', text: `ambiguous module paths: ${ambiguous}` });

  // App-wide (16.6): dependency and config files, and changed files every passing
  // saved flow loaded when there are at least two of them.
  const changed = options.diff.filter((f) => f.status !== 'deleted' || f.class === 'dependency' || f.class === 'config');
  const passing = reach.filter((r) => r.passed);
  const appWide = changed
    .filter((f) => f.class === 'dependency' || f.class === 'config' ||
      // Loaded means reached by the module rule after the Nuxt exclusion.
      (passing.length >= 2 && passing.every((r) => r.via.get(f.path) === 'module')))
    .map((f) => f.path)
    .sort();
  if (appWide.length > 0 && options.flows.length > 0) {
    const named = appWide.length > 3 ? `${appWide.slice(0, 3).join(', ')} and ${appWide.length - 3} more` : appWide.join(', ');
    notes.push({ id: 'app-wide-change', text: `App-wide change (${named}): ${options.flows.length} saved flows in scope at the lowest priority` });
  }
  return { modules: modulesOn, pages: pagesOn, reach, appWide, notes, routes };
}

// diff-map.json's files[].via and flows[] from the tracing result.
export function reachedVia(tracing: TracingResult, diff: DiffFile[]): Map<string, { rule: string; flow: string }[]> {
  const out = new Map<string, { rule: string; flow: string }[]>();
  for (const file of diff) {
    const via: { rule: string; flow: string }[] = [];
    for (const r of tracing.reach) {
      const rule = r.via.get(file.path);
      if (rule && file.class !== 'tool') via.push({ rule, flow: r.flow });
      else if (tracing.appWide.includes(file.path)) via.push({ rule: 'app-wide', flow: r.flow });
    }
    out.set(file.path, via);
  }
  return out;
}

