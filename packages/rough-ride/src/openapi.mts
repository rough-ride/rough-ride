// OpenAPI documents and request keys (spec part 4 section 16.4).

import { isFrameworkInternal, isLoopbackHostname, type FlowRunResult } from './flowrun.mjs';

export interface OpenApiDoc {
  origin: string;
  url: string;
  // The document as parsed; only paths, components and operationIds are read.
  doc: {
    openapi: string;
    paths?: Record<string, Record<string, { operationId?: string; parameters?: unknown; requestBody?: unknown; responses?: unknown }>>;
    components?: { schemas?: Record<string, unknown> };
  };
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

// The loopback origins (and the allowed remote target) the footprints sent
// fetch or XHR requests to.
export function apiOrigins(results: FlowRunResult[], remoteTarget: string | null): string[] {
  const origins = new Set<string>();
  for (const r of results) {
    for (const q of r.requests) {
      if (q.resourceType !== 'fetch' && q.resourceType !== 'xhr') continue;
      try {
        const u = new URL(q.url);
        if (isLoopbackHostname(u.hostname) || u.hostname === remoteTarget) origins.add(u.origin);
      } catch {
        // Not a URL with an origin.
      }
    }
  }
  return [...origins].sort();
}

async function tryDoc(url: string): Promise<OpenApiDoc['doc'] | null> {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (!res.ok || !/json/.test(res.headers.get('content-type') ?? '')) return null;
    const doc = (await res.json()) as OpenApiDoc['doc'];
    return doc && typeof doc.openapi === 'string' ? doc : null;
  } catch {
    return null;
  }
}

// GET <origin>/openapi.json, then <origin>/<first path segment>/openapi.json.
export async function fetchOpenApi(origins: string[], results: FlowRunResult[]): Promise<OpenApiDoc[]> {
  const docs: OpenApiDoc[] = [];
  for (const origin of origins) {
    const direct = `${origin}/openapi.json`;
    let doc = await tryDoc(direct);
    let url = direct;
    if (!doc) {
      const first = results
        .flatMap((r) => r.requests)
        .filter((q) => q.url.startsWith(origin) && !isFrameworkInternal(q.url))
        .map((q) => new URL(q.url).pathname.split('/')[1])
        .find((s) => s);
      if (first) {
        url = `${origin}/${first}/openapi.json`;
        doc = await tryDoc(url);
      }
    }
    if (doc) docs.push({ origin, url, doc });
  }
  return docs;
}

function templateRegex(template: string): RegExp {
  const body = template.split('/').map((seg) => (/^\{[^}]+\}$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
  return new RegExp(`^${body}$`);
}

export interface Keyed {
  template: string;
  prefixMatch: boolean;
}

// The exact OpenAPI template, then one that matches after dropping leading
// request segments the template lacks (prefixMatch), else null.
export function matchTemplate(docs: OpenApiDoc[], url: string, method: string): Keyed | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const doc = docs.find((d) => d.origin === u.origin);
  if (!doc?.doc.paths) return null;
  const candidates = Object.entries(doc.doc.paths).filter(([, ops]) => method.toLowerCase() in ops);
  const pathname = decodeURIComponent(u.pathname);
  for (const [template] of candidates) if (templateRegex(template).test(pathname)) return { template, prefixMatch: false };
  const segments = pathname.split('/').filter(Boolean);
  for (let drop = 1; drop < segments.length; drop++) {
    const rest = `/${segments.slice(drop).join('/')}`;
    for (const [template] of candidates) if (templateRegex(template).test(rest)) return { template, prefixMatch: true };
  }
  return null;
}

// Re-keys a flow run's fetch and XHR requests with OpenAPI templates, then
// counts #n per template again. Returns the prefix-matched templates.
export function rekey(result: FlowRunResult, docs: OpenApiDoc[]): Set<string> {
  const counts = new Map<string, number>();
  const prefix = new Set<string>();
  for (const q of result.requests) {
    if (q.resourceType !== 'fetch' && q.resourceType !== 'xhr') continue;
    const keyed = matchTemplate(docs, q.url, q.method);
    let template: string;
    if (keyed) {
      template = `${q.method} ${keyed.template}`;
      if (keyed.prefixMatch) prefix.add(template);
    } else {
      template = q.key.replace(/ #\d+$/, '');
    }
    const n = (counts.get(template) ?? 0) + 1;
    counts.set(template, n);
    q.key = `${template} #${n}`;
  }
  return prefix;
}

export interface Operation {
  method: string;
  template: string;
  operationId: string | null;
  // The endpoint function's name, or null for a custom operationId.
  functionName: string | null;
  op: Record<string, unknown>;
}

// FastAPI's default operationId is `<name><path with non-word chars as _>_<method>`.
export function operations(doc: OpenApiDoc): Operation[] {
  const out: Operation[] = [];
  for (const [template, ops] of Object.entries(doc.doc.paths ?? {})) {
    for (const method of Object.keys(ops).filter((m) => METHODS.includes(m))) {
      const op = ops[method]!;
      const suffix = `${template.replace(/\W/g, '_')}_${method}`;
      const id = op.operationId ?? null;
      const functionName = id !== null && id.endsWith(suffix) && id.length > suffix.length ? id.slice(0, -suffix.length) : null;
      out.push({ method: method.toUpperCase(), template, operationId: id, functionName, op: op as Record<string, unknown> });
    }
  }
  return out;
}

// Schema names an operation references, directly or through other schemas.
export function referencedSchemas(doc: OpenApiDoc, op: Record<string, unknown>): Set<string> {
  const schemas = doc.doc.components?.schemas ?? {};
  const found = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value)) {
      if (k === '$ref' && typeof v === 'string' && v.startsWith('#/components/schemas/')) {
        const name = v.slice('#/components/schemas/'.length);
        if (!found.has(name)) {
          found.add(name);
          walk(schemas[name]);
        }
      } else walk(v);
    }
  };
  walk({ parameters: op.parameters, requestBody: op.requestBody, responses: op.responses });
  return found;
}

// `NoteIn-Input`, `app__NoteIn` -> `NoteIn`.
export function schemaName(name: string): string {
  return name.replace(/-(Input|Output)$/, '').replace(/^.*__/, '');
}

