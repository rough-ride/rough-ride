// The portability lint (spec part 7 section 29.4) and the hint lint (29.10 step 6).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { allApps, BENCHMARK, CATEGORY_SLUGS, filesUnder, NEVER_MATERIALISED, type App } from './apps.mts';

const OTHER_MANAGERS = ['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'poetry.lock', 'Pipfile', 'Pipfile.lock'];
const DOCKER = /^(Dockerfile.*|docker-compose.*\.ya?ml|compose.*\.ya?ml|\.dockerignore)$/;
const TEXT = /\.(m?[jt]sx?|cjs|vue|py|json|ya?ml|toml|html|css|md|txt|env.*)$/;

export function portabilityProblems(app: App): string[] {
  const base = path.join(app.dir, 'base');
  const files = filesUnder(base);
  const names = files.map((f) => path.posix.basename(f));
  const problems: string[] = [];
  const at = (msg: string) => problems.push(`${app.id}: ${msg}`);

  if (!names.includes('package-lock.json')) at('no committed package-lock.json');
  for (const pyproject of files.filter((f) => path.posix.basename(f) === 'pyproject.toml')) {
    const lock = path.posix.join(path.posix.dirname(pyproject), 'uv.lock');
    if (!files.includes(lock)) at(`${pyproject} has no committed uv.lock beside it`);
  }
  for (const f of files) {
    const name = path.posix.basename(f);
    if (OTHER_MANAGERS.includes(name)) at(`${f}: only npm and uv are allowed`);
    if (DOCKER.test(name)) at(`${f}: no Docker`);
    if (NEVER_MATERIALISED.includes(name) || f.startsWith('.claude/')) at(`${f}: never belongs in base/`);
  }
  for (const f of files.filter((x) => path.posix.basename(x) === 'package.json')) {
    const scripts = (JSON.parse(readFileSync(path.join(base, f), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
    for (const [name, command] of Object.entries(scripts)) {
      if (/(^|[\s;])[A-Za-z_][A-Za-z0-9_]*=\S/.test(command)) at(`${f} script ${name}: inline VAR=x is POSIX-only`);
      if (/(^|[^&])&([^&]|$)/.test(command)) at(`${f} script ${name}: & is POSIX-only`);
      if (/\brm\s+-rf\b/.test(command)) at(`${f} script ${name}: rm -rf is POSIX-only`);
    }
  }
  const own = new Set([app.yaml.ports.web, app.yaml.ports.api]);
  const portPatterns = [/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/g, /--port[= ](\d{2,5})/g, /\bport\s*[:=]\s*(\d{2,5})/gi, /\.listen\((\d{2,5})/g, /PORT\s*=\s*(\d{2,5})/g];
  for (const f of files.filter((x) => TEXT.test(x) && !/(package-lock\.json|uv\.lock)$/.test(x))) {
    const text = readFileSync(path.join(base, f), 'utf8');
    for (const pattern of portPatterns) {
      for (const m of text.matchAll(pattern)) {
        const port = Number(m[1]);
        if (!own.has(port)) at(`${f}: port ${port} is not this app's ${[...own].join(' or ')}`);
      }
    }
  }
  if (app.yaml.stack === 'nuxt-fastapi') {
    const config = path.join(base, '.rough-ride', 'config.yaml');
    const keys = existsSync(config) ? Object.keys((parse(readFileSync(config, 'utf8')) as Record<string, unknown>) ?? {}) : [];
    const extra = keys.filter((k) => k !== 'schema' && k !== 'reset');
    if (extra.length > 0) at(`base/.rough-ride/config.yaml holds ${extra.join(', ')}; a Nuxt + FastAPI base holds only schema and reset`);
  }
  return problems;
}

export function hintWords(apps: App[]): string[] {
  const listed = readFileSync(path.join(BENCHMARK, 'hint-words.txt'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  const bugIds = apps.flatMap((a) => a.features.flatMap((f) => f.bugs.map((b) => b.id)));
  return [...new Set([...listed, ...CATEGORY_SLUGS, ...bugIds])];
}

function wordPattern(word: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'i');
}

function scan(label: string, lines: { n: number; text: string }[], words: string[], allow: Set<string>): string[] {
  const hits: string[] = [];
  for (const { n, text } of lines) {
    for (const word of words) {
      if (allow.has(word.toLowerCase())) continue;
      if (wordPattern(word).test(text)) hits.push(`${label} line ${n}: hint word "${word}"`);
    }
  }
  return hits;
}

function addedLines(patch: string): { n: number; text: string }[] {
  return patch
    .split('\n')
    .map((text, i) => ({ n: i + 1, text }))
    .filter((l) => l.text.startsWith('+') && !l.text.startsWith('+++'))
    .map((l) => ({ n: l.n, text: l.text.slice(1) }));
}

const numbered = (text: string) => text.split('\n').map((t, i) => ({ n: i + 1, text: t }));

// Whole words, case-insensitive, in both patches' added lines, request.md and
// the materialised commit (base/). A bug's manifest allowWords exempt its words.
export function hintProblems(app: App, words: string[]): string[] {
  const problems: string[] = [];
  // app.yaml allowWords cover the whole app: a garden app says "planted".
  const appAllow = (app.yaml.allowWords as string[] | undefined ?? []).map((w) => w.toLowerCase());
  const rel = (p: string) => path.relative(BENCHMARK, p).split(path.sep).join('/');
  for (const feature of app.features) {
    const featureAllow = new Set([...appAllow, ...feature.bugs.flatMap((b) => (b.manifest.allowWords ?? []).map((w) => w.toLowerCase()))]);
    const patch = path.join(feature.dir, 'feature.patch');
    problems.push(...scan(rel(patch), addedLines(readFileSync(patch, 'utf8')), words, featureAllow));
    const request = path.join(feature.dir, 'request.md');
    problems.push(...scan(rel(request), numbered(readFileSync(request, 'utf8')), words, featureAllow));
    for (const bug of feature.bugs) {
      const allow = new Set([...appAllow, ...(bug.manifest.allowWords ?? []).map((w) => w.toLowerCase())]);
      const bugPatch = path.join(bug.dir, 'bug.patch');
      problems.push(...scan(rel(bugPatch), addedLines(readFileSync(bugPatch, 'utf8')), words, allow));
    }
  }
  const base = path.join(app.dir, 'base');
  for (const f of filesUnder(base).filter((x) => TEXT.test(x) && !/(package-lock\.json|uv\.lock)$/.test(x))) {
    problems.push(...scan(rel(path.join(base, f)), numbered(readFileSync(path.join(base, f), 'utf8')), words, new Set(appAllow)));
  }
  return problems;
}

export function lint(ids: string[]): string[] {
  const apps = allApps();
  const chosen = ids.length === 0 ? apps : apps.filter((a) => ids.includes(a.id));
  const words = hintWords(apps);
  return chosen.flatMap((app) => [...portabilityProblems(app), ...hintProblems(app, words)]);
}
