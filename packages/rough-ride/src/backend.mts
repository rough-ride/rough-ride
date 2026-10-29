// Backend changes become changed endpoints (spec part 4 section 16.5). The
// runner never imports or runs the app's Python: everything is a text scan.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Diff, DiffFile } from './diff.mjs';
import { git } from './git.mjs';
import { operations, referencedSchemas, schemaName, type OpenApiDoc } from './openapi.mjs';
import { DROPPED } from './target.mjs';

export type EndpointRule = 'fastapi-function' | 'fastapi-dependency' | 'fastapi-schema' | 'nuxt-server-route';

export interface ChangedEndpoint {
  // `METHOD template`.
  endpoint: string;
  file: string;
  rule: EndpointRule;
  symbol: string | null;
}

export interface BackendResult {
  endpoints: ChangedEndpoint[];
  // Files whose changes are app-wide: module-level Python in an endpoint file,
  // Nuxt server middleware and plugins.
  appWide: string[];
  // Changed backend files no rule links to an endpoint, with the why.
  untraced: Map<string, string>;
}

interface Block {
  kind: 'def' | 'class';
  name: string;
  indent: number;
  line: number;
}

const BLOCK = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/;

function lines(text: string): string[] {
  return text.replace(/\r/g, '').split('\n');
}

// The chain of enclosing def and class blocks for a line, innermost first. A
// decorator line belongs to the block below it.
export function enclosing(source: string[], lineNo: number): Block[] {
  let target = lineNo - 1;
  while (target < source.length && /^\s*@/.test(source[target] ?? '')) target++;
  const indentOf = (line: string) => line.length - line.trimStart().length;
  const blank = (line: string | undefined) => line === undefined || line.trim() === '' || line.trimStart().startsWith('#');
  const chain: Block[] = [];
  const own = BLOCK.exec(source[target] ?? '');
  if (own) chain.push({ kind: own[2] as 'def' | 'class', name: own[3]!, indent: own[1]!.length, line: target + 1 });
  let limit = own ? own[1]!.length : Infinity;
  // A block encloses the line only when no line between them closed its body,
  // so continuation lines inside a module-level call stay module-level.
  let lowest = own || blank(source[target]) ? Infinity : indentOf(source[target]!);
  for (let i = target - 1; i >= 0; i--) {
    const text = source[i]!;
    const m = BLOCK.exec(text);
    if (m && m[1]!.length < limit && m[1]!.length < lowest) {
      chain.push({ kind: m[2] as 'def' | 'class', name: m[3]!, indent: m[1]!.length, line: i + 1 });
      limit = m[1]!.length;
      if (limit === 0) break;
      continue;
    }
    if (!blank(text) && !/^\s*@/.test(text)) lowest = Math.min(lowest, indentOf(text) + (m ? 0 : 0));
  }
  return chain;
}

// New-file line numbers touched by the diff (pure deletions give the line
// after them). Every line of an untracked file counts.
export function changedLines(root: string, diff: Diff, file: DiffFile): number[] {
  if (file.untracked) return lines(readFileSync(path.join(root, file.raw), 'utf8')).map((_, i) => i + 1);
  const patch = git(['diff', '-U0', '--no-color', '--no-ext-diff', '--ignore-cr-at-eol', diff.base.sha, '--', file.raw], root).stdout;
  const out: number[] = [];
  for (const m of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) out.push(Math.max(1, start));
    for (let i = 0; i < count; i++) out.push(start + i);
  }
  return out;
}

// Endpoint function names whose signature names Depends(F) or Security(F),
// directly, through a module-level Annotated alias, or through another
// dependency that names F, followed transitively.
export function dependents(sources: Map<string, string>, changedFunctions: Set<string>): Set<string> {
  const aliases = new Map<string, string>();
  const signatures = new Map<string, string>();
  for (const text of sources.values()) {
    for (const m of text.matchAll(/^([A-Za-z_]\w*)\s*=\s*Annotated\[[^\n]*?(?:Depends|Security)\(\s*([A-Za-z_][\w.]*)/gm)) aliases.set(m[1]!, m[2]!.split('.').at(-1)!);
    for (const m of text.matchAll(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([\s\S]*?)\)\s*(?:->[^:]*)?:/gm)) signatures.set(m[1]!, m[2]!);
  }
  const names = (signature: string): string[] => {
    const out: string[] = [];
    for (const m of signature.matchAll(/(?:Depends|Security)\(\s*([A-Za-z_][\w.]*)/g)) out.push(m[1]!.split('.').at(-1)!);
    for (const [alias, target] of aliases) if (new RegExp(`\\b${alias}\\b`).test(signature)) out.push(target);
    return out;
  };
  const reached = new Set(changedFunctions);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [fn, signature] of signatures) {
      if (reached.has(fn)) continue;
      if (names(signature).some((n) => reached.has(n))) {
        reached.add(fn);
        grew = true;
      }
    }
  }
  return reached;
}

// Classes whose base list names a changed class also count, transitively.
export function subclasses(sources: Map<string, string>, changed: Set<string>): Set<string> {
  const bases = new Map<string, string[]>();
  for (const text of sources.values()) {
    for (const m of text.matchAll(/^\s*class\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/gm)) bases.set(m[1]!, m[2]!.split(',').map((b) => b.trim().split('.').at(-1)!));
  }
  const out = new Set(changed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [cls, list] of bases) {
      if (!out.has(cls) && list.some((b) => out.has(b))) {
        out.add(cls);
        grew = true;
      }
    }
  }
  return out;
}

// `server/api/foo.post.ts` -> `POST /api/foo`; `server/routes/` has no /api prefix.
export function nuxtServerRoute(file: string, nuxtRoot: string): { endpoints: string[] } | 'app-wide' | 'untraced' | null {
  if (!file.startsWith(nuxtRoot)) return null;
  const rel = file.slice(nuxtRoot.length);
  if (/^server\/(middleware|plugins)\//.test(rel)) return 'app-wide';
  if (/^server\/utils\//.test(rel)) return 'untraced';
  const m = /^server\/(api|routes)\/(.+)\.[cm]?[jt]s$/.exec(rel);
  if (!m) return null;
  let route = m[2]!;
  let method: string | null = null;
  const methodMatch = /\.(get|post|put|patch|delete|head|options)$/i.exec(route);
  if (methodMatch) {
    method = methodMatch[1]!.toUpperCase();
    route = route.slice(0, -methodMatch[0].length);
  }
  route = route.replace(/(^|\/)index$/, '').replace(/\[[^\]]+\]/g, '{}');
  const urlPath = `${m[1] === 'api' ? '/api' : ''}/${route}`.replace(/\/$/, '') || '/';
  const methods = method ? [method] : ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  return { endpoints: methods.map((x) => `${x} ${urlPath}`) };
}

const SKIP_NAMES = new Set(['HTTPValidationError', 'ValidationError']);

export function traceBackend(options: { root: string; diff: Diff; docs: OpenApiDoc[]; nuxtRoot: string | null; pythonFiles: string[] }): BackendResult {
  const { root, diff, docs } = options;
  const result: BackendResult = { endpoints: [], appWide: [], untraced: new Map() };
  const sources = new Map<string, string>();
  for (const f of options.pythonFiles) {
    if (f.split('/').some((s) => DROPPED.has(s))) continue;
    try {
      sources.set(f, readFileSync(path.join(root, f), 'utf8'));
    } catch {
      // A deleted file has no source.
    }
  }
  const ops = docs.flatMap((d) => operations(d).map((o) => ({ ...o, doc: d })));
  const endpointFunctions = new Map<string, (typeof ops)[number][]>();
  for (const o of ops) if (o.functionName) endpointFunctions.set(o.functionName, [...(endpointFunctions.get(o.functionName) ?? []), o]);
  const add = (e: ChangedEndpoint) => {
    if (!result.endpoints.some((x) => x.endpoint === e.endpoint && x.file === e.file && x.rule === e.rule)) result.endpoints.push(e);
  };

  for (const file of diff.files) {
    if (file.reason !== null || file.class === 'tool' || file.class === 'not app code') continue;
    if (options.nuxtRoot !== null) {
      const route = nuxtServerRoute(file.path, options.nuxtRoot);
      if (route === 'app-wide') {
        result.appWide.push(file.path);
        continue;
      }
      if (route === 'untraced') {
        result.untraced.set(file.path, 'no rule links it to an endpoint');
        continue;
      }
      if (route) {
        for (const endpoint of route.endpoints) add({ endpoint, file: file.path, rule: 'nuxt-server-route', symbol: null });
        continue;
      }
    }
    if (!file.path.endsWith('.py') || file.path.split('/').some((s) => DROPPED.has(s))) continue;
    if (docs.length === 0) {
      result.untraced.set(file.path, 'no OpenAPI document');
      continue;
    }
    const source = file.status === 'deleted' ? [] : lines(sources.get(file.path) ?? '');
    const changed = file.status === 'deleted' ? [] : changedLines(root, diff, file);
    const fileText = sources.get(file.path) ?? '';
    const definesEndpoint = [...endpointFunctions.keys()].some((name) => new RegExp(`^\\s*(?:async\\s+)?def\\s+${name}\\b`, 'm').test(fileText));
    let linked = false;
    let moduleLevel = false;
    const changedFns = new Set<string>();
    const changedClasses = new Set<string>();
    for (const line of changed) {
      const chain = enclosing(source, line);
      if (chain.length === 0) {
        if ((source[line - 1] ?? '').trim() !== '') moduleLevel = true;
        continue;
      }
      const endpointBlock = chain.find((b) => b.kind === 'def' && endpointFunctions.has(b.name));
      if (endpointBlock) {
        for (const o of endpointFunctions.get(endpointBlock.name)!) add({ endpoint: `${o.method} ${o.template}`, file: file.path, rule: 'fastapi-function', symbol: endpointBlock.name });
        linked = true;
        continue;
      }
      const fn = chain.find((b) => b.kind === 'def');
      if (fn) changedFns.add(fn.name);
      const cls = chain.find((b) => b.kind === 'class');
      if (cls && !fn) changedClasses.add(cls.name);
      else if (cls && fn && chain.indexOf(cls) > chain.indexOf(fn)) changedClasses.add(cls.name);
    }
    if (changedFns.size > 0) {
      const reached = dependents(sources, changedFns);
      for (const [name, list] of endpointFunctions) {
        if (!reached.has(name) || changedFns.has(name)) continue;
        const via = [...changedFns].find((f) => dependents(sources, new Set([f])).has(name)) ?? null;
        for (const o of list) add({ endpoint: `${o.method} ${o.template}`, file: file.path, rule: 'fastapi-dependency', symbol: via });
        linked = true;
      }
    }
    if (changedClasses.size > 0) {
      const classes = subclasses(sources, changedClasses);
      for (const o of ops) {
        const refs = [...referencedSchemas(o.doc, o.op)].map(schemaName).filter((n) => !SKIP_NAMES.has(n));
        const hit = refs.find((r) => classes.has(r));
        if (!hit) continue;
        const symbol = [...changedClasses].find((c) => subclasses(sources, new Set([c])).has(hit)) ?? hit;
        add({ endpoint: `${o.method} ${o.template}`, file: file.path, rule: 'fastapi-schema', symbol });
        linked = true;
      }
    }
    if (moduleLevel && definesEndpoint) {
      result.appWide.push(file.path);
      linked = true;
    }
    if (!linked) {
      const custom = ops.some((o) => o.functionName === null && o.operationId !== null);
      result.untraced.set(file.path, custom && definesEndpoint ? 'custom operationId' : 'no rule links it to an endpoint');
    }
  }
  result.endpoints.sort((a, b) => (a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : a.file < b.file ? -1 : 1));
  return result;
}
