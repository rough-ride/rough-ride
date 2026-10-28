// One version string, x.y.z, in every place it appears (spec part 1 section 5,
// One version string). `version:set` rewrites them all except the marketplace
// entry, whose pin moves only in its own PR after npm serves the version.
// `version-sync` checks them: equal on a PR, equal to X.Y.Z on a vX.Y.Z or
// vX.Y.Z-rc.N tag.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG = path.join(ROOT, 'packages', 'rough-patch');
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// Pinned examples: rough-patch@1.2.3 and rough-patch@x.y.z in docs and templates.
const PINNED = /\brough-patch@(\d+\.\d+\.\d+)\b(?!-)/g;

function docFiles(root) {
  const out = [];
  for (const f of ['README.md', path.join('packages', 'rough-patch', 'README.md')]) if (existsSync(path.join(root, f))) out.push(f);
  for (const dir of ['docs', path.join('packages', 'rough-patch', 'templates'), path.join('packages', 'rough-patch', 'skills'), path.join('packages', 'rough-patch', 'agents')]) {
    if (!existsSync(path.join(root, dir))) continue;
    for (const f of readdirSync(path.join(root, dir), { recursive: true })) {
      if (/\.(md|ya?ml|json|txt)$/.test(String(f))) out.push(path.join(dir, String(f)));
    }
  }
  return out;
}

// Every place the version appears, with the value found there.
export function versionsIn(root = ROOT) {
  const pkgDir = path.join(root, 'packages', 'rough-patch');
  const read = (f) => JSON.parse(readFileSync(path.join(pkgDir, f), 'utf8'));
  const found = [
    { where: 'packages/rough-patch/package.json', value: read('package.json').version },
    { where: 'packages/rough-patch/.claude-plugin/plugin.json', value: read('.claude-plugin/plugin.json').version },
    { where: 'npm-shrinkwrap.json version', value: read('npm-shrinkwrap.json').version },
    { where: 'npm-shrinkwrap.json packages[""].version', value: read('npm-shrinkwrap.json').packages[''].version },
  ];
  for (const f of docFiles(root)) {
    for (const m of readFileSync(path.join(root, f), 'utf8').matchAll(PINNED)) found.push({ where: f.split(path.sep).join('/'), value: m[1] });
  }
  return found;
}

export function syncProblems(found, tag = null) {
  const problems = [];
  const first = found[0].value;
  for (const f of found) if (f.value !== first) problems.push(`${f.where} says ${f.value}, packages/rough-patch/package.json says ${first}`);
  if (tag !== null) {
    const m = /^v(\d+\.\d+\.\d+)(-rc\.\d+)?$/.exec(tag);
    if (!m) problems.push(`${tag} is not a vX.Y.Z or vX.Y.Z-rc.N tag`);
    else for (const f of found) if (f.value !== m[1]) problems.push(`${f.where} says ${f.value}, the tag ${tag} says ${m[1]}`);
  }
  return problems;
}

export function setVersion(version, root = ROOT) {
  if (!SEMVER.test(version)) throw new Error(`${version} is not x.y.z`);
  const pkgDir = path.join(root, 'packages', 'rough-patch');
  const edit = (file, fn) => {
    const full = path.join(pkgDir, file);
    const json = JSON.parse(readFileSync(full, 'utf8'));
    fn(json);
    writeFileSync(full, JSON.stringify(json, null, 2) + '\n');
  };
  edit('package.json', (j) => (j.version = version));
  edit('.claude-plugin/plugin.json', (j) => (j.version = version));
  edit('npm-shrinkwrap.json', (j) => {
    j.version = version;
    j.packages[''].version = version;
  });
  for (const f of docFiles(root)) {
    const full = path.join(root, f);
    const text = readFileSync(full, 'utf8');
    const next = text.replace(PINNED, `rough-patch@${version}`);
    if (next !== text) writeFileSync(full, next);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, arg] = process.argv.slice(2);
  if (command === 'set') {
    setVersion(arg);
    console.log(`version set to ${arg} (the marketplace entry moves in its own PR once npm serves it)`);
  } else if (command === 'sync') {
    const tagIndex = process.argv.indexOf('--tag');
    const problems = syncProblems(versionsIn(), tagIndex === -1 ? null : process.argv[tagIndex + 1]);
    for (const p of problems) console.log(p);
    if (problems.length > 0) process.exit(1);
    console.log('version-sync: ok');
  } else {
    console.error('Usage: node scripts/versions.mjs set <x.y.z> | sync [--tag vX.Y.Z]');
    process.exit(64);
  }
}
