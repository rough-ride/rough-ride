// Reading benchmark apps from benchmark/apps/ (spec part 7 section 29.11).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const BENCHMARK = fileURLToPath(new URL('..', import.meta.url));
export const APPS = path.join(BENCHMARK, 'apps');

export const CATEGORY_SLUGS = [
  'silent-failure', 'missing-input-guard', 'empty-data', 'state-lost', 'no-recovery',
  'double-submit', 'overflow-375', 'out-of-order', 'session-expiry',
];

// Files that never reach a materialised folder.
export const NEVER_MATERIALISED = [
  'manifest.yaml', 'reference.spec.ts', 'decoys.yaml', 'hardening.md', 'harvest.md', 'provenance.md',
  'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md',
];

export interface AppYaml {
  id: string;
  product: string;
  stack: string;
  stratum: string;
  split: string;
  ports: { web: number; api: number };
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface Manifest {
  id: string;
  category: string;
  allowWords?: string[];
  [key: string]: unknown;
}

export interface App {
  id: string;
  dir: string;
  yaml: AppYaml;
  features: { id: string; dir: string; bugs: { id: string; dir: string; manifest: Manifest }[] }[];
}

const dirs = (dir: string) =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [];

export function loadApp(id: string): App {
  const dir = path.join(APPS, id);
  if (!existsSync(path.join(dir, 'app.yaml'))) throw new Error(`no benchmark app named ${id}`);
  const yaml = parse(readFileSync(path.join(dir, 'app.yaml'), 'utf8')) as AppYaml;
  const features = dirs(path.join(dir, 'features')).map((f) => {
    const fdir = path.join(dir, 'features', f);
    const bugs = dirs(path.join(fdir, 'bugs')).map((b) => {
      const bdir = path.join(fdir, 'bugs', b);
      return { id: b, dir: bdir, manifest: parse(readFileSync(path.join(bdir, 'manifest.yaml'), 'utf8')) as Manifest };
    });
    return { id: f, dir: fdir, bugs };
  });
  return { id, dir, yaml, features };
}

export function allApps(): App[] {
  return dirs(APPS).map(loadApp);
}

// `Fixture Notes` -> `fixture-notes`.
export function productSlug(product: string): string {
  return product.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Every file under `dir`, relative with `/`, skipping installed dependencies.
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (['node_modules', '.venv', '.git', '.nuxt', '.output', '__pycache__'].includes(entry.name)) continue;
        walk(child);
      } else out.push(child);
    }
  };
  walk('');
  return out.sort();
}
