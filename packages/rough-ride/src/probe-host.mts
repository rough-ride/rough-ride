// Runs one probe script for /rough-ride:hunt (experimental):
//   node dist/probe-host.mjs <run dir> <probe file>
// A probe is an ES module whose default export receives `rr`, a small API over
// one signed-in browser context: faults on requests, an observation of what the
// page shows, and named expectations. The last stdout line is the result JSON.
// Every request leaves this machine only to loopback hosts; anything else is
// aborted, as in the rest of rough-ride.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserContext, Page, Request, Route } from 'playwright-core';

interface Check { name: string; pass: boolean; detail: string }
type FaultSpec = number | 'malformed' | 'empty' | 'empty-list' | 'empty-object' | 'hang' | 'reset' | { delay: number } | { status: number; body?: string } | { json: unknown };

const PROBE_TIMEOUT_MS = 100_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLoopback(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return true;
    return LOOPBACK.has(u.hostname) || u.hostname.endsWith('.localhost');
  } catch {
    return false;
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

async function main(runDir: string, file: string): Promise<void> {
  const context = JSON.parse(readFileSync(path.join(runDir, 'context.json'), 'utf8')) as { target: string; browser: string };
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: context.browser, headless: true });
  const sessionFile = path.join(runDir, 'session.json');
  const checks: Check[] = [];
  const notes: { label: string; value: unknown }[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requests: { method: string; url: string; status: number | null; fault: string | null }[] = [];
  const faulted = new WeakMap<Request, string>();
  const blocked: string[] = [];

  const ctx: BrowserContext = await browser.newContext({
    baseURL: context.target,
    viewport: { width: 1280, height: 800 },
    ...(existsSync(sessionFile) ? { storageState: sessionFile } : {}),
  });
  await ctx.route('**/*', (route: Route) => {
    if (isLoopback(route.request().url())) return route.fallback();
    blocked.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  const watch = (page: Page) => {
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(clip(m.text(), 300)); });
    page.on('pageerror', (e) => pageErrors.push(clip(String(e?.message ?? e), 300)));
    page.on('response', (r) => {
      const req = r.request();
      if (['xhr', 'fetch'].includes(req.resourceType())) requests.push({ method: req.method(), url: r.url(), status: r.status(), fault: faulted.get(req) ?? null });
    });
    page.on('requestfailed', (req) => {
      if (['xhr', 'fetch'].includes(req.resourceType())) requests.push({ method: req.method(), url: req.url(), status: null, fault: faulted.get(req) ?? req.failure()?.errorText ?? 'failed' });
    });
  };
  ctx.on('page', watch);

  const page = await ctx.newPage();

  const rr = {
    web: context.target,
    page,
    context: ctx,
    async newPage(viewport?: { width: number; height: number }) {
      const p = await ctx.newPage();
      if (viewport) await p.setViewportSize(viewport);
      return p;
    },
    // Load settled: the load event, a quiet network (at most 5 s), and a Nuxt or
    // other client app mounted, when the page has one.
    async ready(p: Page = page) {
      await p.waitForLoadState('load').catch(() => {});
      await p.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await p.waitForFunction(() => {
        const nuxt = document.querySelector('#__nuxt') as (Element & { __vue_app__?: unknown }) | null;
        return nuxt ? Boolean(nuxt.__vue_app__) : true;
      }, undefined, { timeout: 10_000 }).catch(() => {});
      await p.waitForTimeout(300);
    },
    async goto(url: string, p: Page = page) {
      await p.goto(url);
      await rr.ready(p);
      return p;
    },
    async saveSession() {
      await ctx.storageState({ path: sessionFile });
    },
    // Makes matching requests fail, hang, slow down or answer with other data.
    // `times` limits how many requests it hits (default: all), `method` filters.
    async fault(pattern: string | RegExp, spec: FaultSpec, opts: { method?: string; times?: number } = {}) {
      let hits = 0;
      const label = typeof spec === 'object' ? JSON.stringify(spec) : String(spec);
      const handler = async (route: Route) => {
        const req = route.request();
        if (opts.method && req.method() !== opts.method.toUpperCase()) return route.fallback();
        if (opts.times !== undefined && hits >= opts.times) return route.fallback();
        hits += 1;
        faulted.set(req, label);
        if (spec === 'hang') return; // never answered
        if (spec === 'reset') return route.abort('connectionreset');
        if (typeof spec === 'number') return route.fulfill({ status: spec, contentType: 'application/json', body: JSON.stringify({ detail: `Injected ${spec}` }) });
        if (spec === 'malformed') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"oops": [1, 2' });
        if (spec === 'empty') return route.fulfill({ status: 200, contentType: 'application/json', body: '' });
        if (spec === 'empty-list') return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
        if (spec === 'empty-object') return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        if ('delay' in spec) { await new Promise((r) => setTimeout(r, spec.delay)); return route.fallback(); }
        if ('json' in spec) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(spec.json) });
        return route.fulfill({ status: spec.status, contentType: 'application/json', body: spec.body ?? JSON.stringify({ detail: `Injected ${spec.status}` }) });
      };
      await ctx.route(pattern, handler);
      return { hits: () => hits, clear: () => ctx.unroute(pattern, handler) };
    },
    async offline(on: boolean) {
      await ctx.setOffline(on);
    },
    // What a person sees: headings, alerts, visible text lines, disabled
    // controls (with any reason given), sideways overflow, plus the errors and
    // API requests seen so far.
    async observe(p: Page = page) {
      const view = await p.evaluate(() => {
        const visible = (el: Element) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const name = (el: Element) => (el.getAttribute('aria-label') || (el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute('name') || '').trim().replace(/\s+/g, ' ');
        const lines = (document.body?.innerText ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
        return {
          url: location.pathname + location.search,
          title: document.title,
          headings: [...document.querySelectorAll('h1,h2,h3')].filter(visible).map((h) => (h as HTMLElement).innerText.trim()),
          alerts: [...document.querySelectorAll('[role=alert],[role=status],[aria-live]')].filter(visible).map((a) => (a as HTMLElement).innerText.trim()).filter(Boolean),
          text: lines.slice(0, 150),
          disabled: [...document.querySelectorAll('button:disabled,input:disabled,select:disabled,textarea:disabled,[aria-disabled=true]')]
            .filter(visible).map((el) => ({ name: name(el), reason: el.getAttribute('title') || el.getAttribute('aria-describedby') || null })),
          fields: [...document.querySelectorAll('input,textarea,select')].filter(visible).map((el) => ({ label: (el as HTMLInputElement).labels?.[0]?.innerText?.trim() ?? el.getAttribute('name'), value: (el as HTMLInputElement).value })),
          overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
        };
      });
      return { ...view, text: view.text.map((l: string) => clip(l, 200)), consoleErrors: [...consoleErrors], pageErrors: [...pageErrors], requests: requests.slice(-30) };
    },
    // A named expectation. A finding names the probe and the expectation that
    // fails; confirmation re-runs the probe and needs the same one to fail.
    expect(name: string, ok: unknown, detail: unknown = '') {
      checks.push({ name, pass: Boolean(ok), detail: clip(typeof detail === 'string' ? detail : JSON.stringify(detail), 600) });
      return Boolean(ok);
    },
    note(label: string, value: unknown) {
      notes.push({ label, value: typeof value === 'string' ? clip(value, 2000) : value });
    },
    // A request in the page's context (cookies included); a path is relative to the web origin.
    async request(method: string, url: string, body?: unknown) {
      if (!isLoopback(new URL(url, context.target).toString())) throw new Error('rr.request reaches loopback hosts only');
      const res = await ctx.request.fetch(url, { method, ...(body === undefined ? {} : { data: body }), failOnStatusCode: false });
      const text = await res.text();
      let json: unknown = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status(), json, text: clip(text, 4000) };
    },
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  };

  let error: string | null = null;
  const timer = setTimeout(() => { error = `probe timed out after ${PROBE_TIMEOUT_MS / 1000} s`; void browser.close().catch(() => {}); }, PROBE_TIMEOUT_MS);
  try {
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.default !== 'function') throw new Error('a probe must `export default async function (rr) { ... }`');
    await mod.default(rr);
  } catch (e) {
    error ??= clip(String((e as Error)?.stack ?? e).split('\n').slice(0, 4).join(' | '), 800);
  } finally {
    clearTimeout(timer);
  }
  let final: unknown = null;
  try { final = await rr.observe(); } catch {}
  await browser.close().catch(() => {});
  const result = { checks, notes, error, blocked: blocked.slice(0, 5), final };
  writeFileSync(file.replace(/\.mjs$/, '.result.json'), JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const [runDir, file] = process.argv.slice(2);
if (!runDir || !file) {
  process.stderr.write('usage: probe-host.mjs <run dir> <probe file>\n');
  process.exit(64);
}
main(runDir, file).then(() => process.exit(0), (e) => {
  process.stdout.write(`${JSON.stringify({ checks: [], notes: [], error: String(e?.message ?? e), blocked: [], final: null })}\n`);
  process.exit(0);
});
