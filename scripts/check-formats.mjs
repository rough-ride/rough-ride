// The `formats` CI job (spec part 2 section 7.10). On a PR it compares each
// schema file with the latest release tag's copy; on a release tag (--tag
// vX.Y.Z or vX.Y.Z-rc.N) it checks the versions against the tag. Both modes
// check that every schema URL and template agrees with formats.mts.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG = path.join(ROOT, 'packages', 'rough-ride');
const FILES = { config: 'config', flow: 'flow', tests: 'test', accepted: 'accepted', plan: 'plan' };

export function compare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

export function readFormats(text) {
  const formats = {};
  for (const kind of Object.keys(FILES)) {
    const m = new RegExp(`${kind}: \\{ current: '([0-9.]+)', floor: '([0-9.]+)' \\}`).exec(text);
    if (!m) throw new Error(`formats.mts has no entry for ${kind}`);
    formats[kind] = { current: m[1], floor: m[2] };
  }
  return formats;
}

// Changes that break files written for the old schema: a removed property, a
// changed type, a removed enum value, a new required entry, a changed pattern
// or minimum, and (flows only) a changed default.
export function schemaBreaks(before, after, kind, at = '') {
  const breaks = [];
  if (!before || typeof before !== 'object') return breaks;
  if (!after || typeof after !== 'object') return [`${at || '/'} removed`];
  if (JSON.stringify(before.type) !== JSON.stringify(after.type)) breaks.push(`${at || '/'} type changed`);
  for (const value of before.enum ?? []) {
    if (!(after.enum ?? []).includes(value)) breaks.push(`${at || '/'} enum value ${JSON.stringify(value)} removed`);
  }
  for (const key of after.required ?? []) {
    if (!(before.required ?? []).includes(key)) breaks.push(`${at}/${key} newly required`);
  }
  for (const word of ['pattern', 'minimum', 'const']) {
    if (before[word] !== after[word] && before[word] !== undefined) breaks.push(`${at || '/'} ${word} changed`);
  }
  if (kind === 'flow' && JSON.stringify(before.default) !== JSON.stringify(after.default) && before.default !== undefined) {
    breaks.push(`${at || '/'} default changed`);
  }
  for (const [key, child] of Object.entries(before.properties ?? {})) {
    if (!after.properties?.[key]) breaks.push(`${at}/${key} removed`);
    else breaks.push(...schemaBreaks(child, after.properties[key], kind, `${at}/${key}`));
  }
  if (before.items) breaks.push(...schemaBreaks(before.items, after.items, kind, `${at}[]`));
  (before.oneOf ?? []).forEach((child, i) => {
    const match = (after.oneOf ?? []).find((c) => JSON.stringify(c) === JSON.stringify(child));
    if (!match) breaks.push(...schemaBreaks(child, after.oneOf?.[i], kind, `${at}|${i}`));
  });
  return breaks;
}

// Problems with one kind on a PR, given its schema at the latest tag.
export function prProblems({ kind, formats, tagVersion, before, after, upgraders, fixtureVersions }) {
  if (before === null || JSON.stringify(before) === JSON.stringify(after)) return [];
  const { current, floor } = formats[kind];
  const problems = [];
  if (compare(current, tagVersion) <= 0) {
    problems.push(`${kind}: ${FILES[kind]}.schema.json changed since v${tagVersion}, so its current (${current}) must be above ${tagVersion}.`);
  }
  const breaks = schemaBreaks(before, after, kind);
  if (breaks.length > 0) {
    if (floor !== current) problems.push(`${kind}: breaking change (${breaks.join('; ')}) needs floor moved to ${current}.`);
    if (!upgraders.some((u) => u.kind === kind && u.to === current)) {
      problems.push(`${kind}: breaking change needs an upgrader to ${current} in src/upgraders.`);
    }
    const missing = fixtureVersions.past.filter((v) => !fixtureVersions.have.includes(v));
    if (missing.length > 0) problems.push(`${kind}: fixtures missing for ${missing.join(', ')}.`);
  }
  return problems;
}

// Problems on a release tag: no current or floor above it, every kind changed
// since the previous tag at exactly X.Y.Z, and no schema change in a patch tag.
export function tagProblems({ tag, formats, changedKinds }) {
  const m = /^v([0-9]+)\.([0-9]+)\.([0-9]+)(-rc\.[0-9]+)?$/.exec(tag);
  if (!m) return [`${tag} is not a release tag.`];
  const version = `${m[1]}.${m[2]}.${m[3]}`;
  const problems = [];
  for (const [kind, { current, floor }] of Object.entries(formats)) {
    if (compare(current, version) > 0 || compare(floor, version) > 0) {
      problems.push(`${kind}: current ${current} or floor ${floor} is above ${version}.`);
    }
  }
  for (const kind of changedKinds) {
    if (m[3] !== '0') problems.push(`${kind}: patch release ${version} changes ${FILES[kind]}.schema.json.`);
    else if (formats[kind].current !== version) problems.push(`${kind}: changed since the previous tag, so current must be ${version}.`);
  }
  return problems;
}

// Every schema URL in the repo's own files names a kind's current tag.
export function urlProblems(name, text, formats) {
  const problems = [];
  const re = /rough-ride\/rough-ride\/([^/\s]+)\/packages\/rough-ride\/src\/schemas\/([a-z]+)\.schema\.json/g;
  for (const m of text.matchAll(re)) {
    const kind = Object.keys(FILES).find((k) => FILES[k] === m[2]);
    if (!kind) continue;
    if (m[1] !== `v${formats[kind].current}`) problems.push(`${name}: ${m[2]} schema URL names ${m[1]}, expected v${formats[kind].current}.`);
  }
  for (const m of text.matchAll(/^schema: ([0-9.]+)$/gm)) {
    if (name.endsWith('templates/config.yaml') && m[1] !== formats.config.current) {
      problems.push(`${name}: schema ${m[1]}, expected ${formats.config.current}.`);
    }
  }
  return problems;
}

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function filesUnder(dir, keep) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String).filter(keep).map((p) => path.join(dir, p));
}

function main(argv) {
  const formats = readFormats(readFileSync(path.join(PKG, 'src', 'formats.mts'), 'utf8'));
  const problems = [];
  const schemaPath = (kind) => `packages/rough-ride/src/schemas/${FILES[kind]}.schema.json`;
  const schemaAt = (ref, kind) => {
    const text = git('show', `${ref}:${schemaPath(kind)}`);
    return text === null ? null : JSON.parse(text);
  };
  const upgradersText = existsSync(path.join(PKG, 'src', 'upgraders'))
    ? filesUnder(path.join(PKG, 'src', 'upgraders'), (p) => p.endsWith('.mts')).map((f) => readFileSync(f, 'utf8')).join('\n')
    : '';
  const upgraders = [...upgradersText.matchAll(/kind: '([a-z]+)',\s*to: '([0-9.]+)'/g)].map((m) => ({ kind: m[1], to: m[2] }));

  const tagIndex = argv.indexOf('--tag');
  if (tagIndex !== -1) {
    const tag = argv[tagIndex + 1];
    const previous = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', `${tag}^`)?.trim();
    const changedKinds = Object.keys(FILES).filter(
      (kind) => previous && JSON.stringify(schemaAt(previous, kind)) !== JSON.stringify(schemaAt(tag, kind)),
    );
    problems.push(...tagProblems({ tag, formats, changedKinds }));
  } else {
    const latest = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*')?.trim();
    if (latest) {
      const tagVersion = latest.replace(/^v/, '').replace(/-rc\.[0-9]+$/, '');
      for (const kind of Object.keys(FILES)) {
        const after = JSON.parse(readFileSync(path.join(ROOT, schemaPath(kind)), 'utf8'));
        const fixtureDir = path.join(PKG, 'test', 'fixtures', 'formats', kind);
        const have = existsSync(fixtureDir) ? readdirSync(fixtureDir) : [];
        const tags = (git('tag', '--list', 'v[0-9]*.[0-9]*.0') ?? '').split('\n').filter(Boolean);
        const past = [...new Set(tags.map((t) => schemaAt(t, kind)?.properties?.schema && t.slice(1)).filter(Boolean))];
        problems.push(...prProblems({ kind, formats, tagVersion, before: schemaAt(latest, kind), after, upgraders, fixtureVersions: { past, have } }));
      }
    }
  }

  for (const kind of Object.keys(FILES)) {
    const schema = JSON.parse(readFileSync(path.join(ROOT, schemaPath(kind)), 'utf8'));
    problems.push(...urlProblems(schemaPath(kind), schema.$id, formats));
  }
  const scanned = [
    path.join(ROOT, 'README.md'),
    ...filesUnder(path.join(ROOT, 'docs'), (p) => p.endsWith('.md')),
    ...filesUnder(path.join(PKG, 'templates'), (p) => p.endsWith('.yaml')),
  ].filter(existsSync);
  for (const file of scanned) {
    problems.push(...urlProblems(path.relative(ROOT, file).split(path.sep).join('/'), readFileSync(file, 'utf8'), formats));
  }

  // Committed files the runner reads in this repository lie inside [floor, current].
  const committed = filesUnder(path.join(ROOT, 'benchmark', 'apps'), (p) => /\.rough-ride[\\/].*\.yaml$|features[\\/][^\\/]+[\\/]flows[\\/].*\.yaml$/.test(p));
  for (const file of committed) {
    const value = /^schema:\s*["']?([0-9.]+)/m.exec(readFileSync(file, 'utf8'))?.[1];
    const kind = /[\\/]flows[\\/]/.test(file) ? 'flow' : /[\\/]tests[\\/]/.test(file) ? 'tests' : /accepted\.yaml$/.test(file) ? 'accepted' : 'config';
    if (value && (compare(value, formats[kind].floor) < 0 || compare(value, formats[kind].current) > 0)) {
      problems.push(`${path.relative(ROOT, file)}: schema ${value} is outside [${formats[kind].floor}, ${formats[kind].current}].`);
    }
  }

  for (const problem of problems) console.log(problem);
  if (problems.length > 0) process.exit(1);
  console.log('formats: ok');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
