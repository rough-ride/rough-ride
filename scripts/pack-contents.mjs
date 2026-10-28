// The `pack-contents` CI job (spec part 1 section 4, Packaging checks in CI):
// what `npm pack` would put in the tarball must match the package's rules.
// Usage: node scripts/pack-contents.mjs [package dir, default packages/rough-patch]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ALLOWED_PREFIXES = ['.claude-plugin/plugin.json', 'skills/', 'agents/', 'hooks/', 'dist/', 'templates/'];
const ALLOWED_FILES = ['npm-shrinkwrap.json', 'package.json', 'README.md', 'LICENSE'];
const ALLOWED_LICENCES = ['Apache-2.0', 'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'MIT-0'];
const MAX_UNPACKED = 2 * 1024 * 1024;
const MAX_PATH = 120;

// `pack` is npm pack's view: {files: [{path}], unpackedSize}.
export function packProblems(dir, pack, rootDir = ROOT) {
  const problems = [];
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const { path: file } of pack.files) {
    const allowed = ALLOWED_FILES.includes(file) || ALLOWED_PREFIXES.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));
    if (!allowed || file.endsWith('.map')) problems.push(`packed path outside the files allowlist: ${file}`);
    if (file.length > MAX_PATH) problems.push(`packed path longer than ${MAX_PATH} characters: ${file}`);
    const dist = /^dist\/(.+)\.mjs$/.exec(file);
    if (dist && !existsSync(path.join(dir, 'src', `${dist[1]}.mts`))) problems.push(`${file} has no matching src/${dist[1]}.mts`);
    const schema = /^dist\/(schemas\/.+\.json)$/.exec(file);
    if (schema && !existsSync(path.join(dir, 'src', schema[1]))) problems.push(`${file} has no matching src/${schema[1]}`);
  }
  if (pack.unpackedSize > MAX_UNPACKED) problems.push(`unpacked size ${pack.unpackedSize} bytes is over 2 MB`);
  if (pkg.bundleDependencies || pkg.bundledDependencies) problems.push('bundleDependencies is set');

  const shrinkwrapFile = path.join(dir, 'npm-shrinkwrap.json');
  if (!existsSync(shrinkwrapFile)) problems.push('npm-shrinkwrap.json is missing');
  else {
    const shrinkwrap = JSON.parse(readFileSync(shrinkwrapFile, 'utf8'));
    const declared = JSON.stringify(pkg.dependencies ?? {});
    const locked = JSON.stringify(shrinkwrap.packages?.['']?.dependencies ?? {});
    if (declared !== locked) problems.push(`npm-shrinkwrap.json lists ${locked} but package.json lists ${declared}`);
    for (const [key, entry] of Object.entries(shrinkwrap.packages ?? {})) {
      if (key === '' || !key.startsWith('node_modules/')) continue;
      if (!ALLOWED_LICENCES.includes(entry.license)) problems.push(`${key} has licence ${entry.license ?? 'none'}, outside the allowed list`);
      const version = pkg.dependencies?.[key.slice('node_modules/'.length)];
      if (version !== undefined && version !== entry.version) problems.push(`${key} is ${entry.version} in the shrinkwrap but ${version} in package.json`);
    }
  }
  for (const name of ['LICENSE', 'README.md']) {
    const mine = path.join(dir, name);
    const root = path.join(rootDir, name);
    if (!existsSync(mine) || !existsSync(root) || !readFileSync(mine).equals(readFileSync(root))) {
      problems.push(`${path.relative(rootDir, mine).split(path.sep).join('/')} differs from the root ${name}`);
    }
  }
  return problems;
}

export function npmPack(dir) {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' });
  return JSON.parse(out)[0];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = path.resolve(process.argv[2] ?? path.join(ROOT, 'packages', 'rough-patch'));
  const problems = packProblems(dir, npmPack(dir));
  for (const p of problems) console.log(p);
  if (problems.length > 0) process.exit(1);
  console.log('pack-contents: ok');
}
