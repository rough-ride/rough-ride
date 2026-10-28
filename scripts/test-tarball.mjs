// test-tarball (spec part 1 section 4, Packaging checks in CI), on one machine.
// Usage: node scripts/test-tarball.mjs <rough-patch-x.y.z.tgz> [--step5]
//   1. install the tarball into a scratch project; `npx --no -- rough-patch --version`
//   2. unpack it, `npm ci --omit=dev --ignore-scripts`, `claude plugin validate --strict` (when claude is on PATH)
//   3. hook scripts with fixture stdin (once hooks/hooks.json exists, ticket 37)
//   4. the MCP entry answers `initialize`
//   5. with --step5: `quick` against the dev-split Nuxt app (scripts/release-step5.mjs)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tgz = path.resolve(process.argv[2] ?? '');
const windows = process.platform === 'win32';
if (!existsSync(tgz)) {
  console.error('Usage: node scripts/test-tarball.mjs <rough-patch-x.y.z.tgz> [--step5]');
  process.exit(64);
}
const version = JSON.parse(spawnSync('tar', ['-xzOf', tgz, 'package/package.json'], { encoding: 'utf8' }).stdout).version;

function step(name, fn) {
  process.stdout.write(`== ${name}\n`);
  fn();
}

function sh(command, args, cwd, { allowFail = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: windows });
  if (result.status !== 0 && !allowFail) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status} in ${cwd}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

step('1. install the tarball into a scratch project and run the version check', () => {
  const project = mkdtempSync(path.join(tmpdir(), 'rp-project-'));
  writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'scratch', private: true }));
  sh('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', tgz], project);
  const out = sh('npx', ['--no', '--', 'rough-patch', '--version'], project).stdout.trim();
  if (!new RegExp(`^rough-patch ${version.replaceAll('.', '\\.')} \\| Playwright 1\\.64\\.1 \\| Node \\d+\\.\\d+\\.\\d+$`).test(out)) {
    throw new Error(`unexpected --version output: ${out}`);
  }
  console.log(out);
});

const unpacked = mkdtempSync(path.join(tmpdir(), 'rp-unpacked-'));
step('2. unpack, install runtime packages from the shrinkwrap, validate the plugin', () => {
  sh('tar', ['-xzf', tgz, '-C', unpacked], ROOT);
  sh('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], path.join(unpacked, 'package'));
  if (sh('claude', ['--version'], unpacked, { allowFail: true }).status === 0) {
    const validate = sh('claude', ['plugin', 'validate', '--strict', path.join(unpacked, 'package')], unpacked, { allowFail: true });
    process.stdout.write(validate.stdout);
    if (validate.status !== 0) throw new Error('claude plugin validate --strict failed');
  } else {
    console.log('claude is not on PATH: plugin validation skipped');
  }
});

step('3. hook scripts with fixture stdin', () => {
  const hooks = path.join(unpacked, 'package', 'hooks', 'hooks.json');
  if (!existsSync(hooks)) {
    console.log('no hooks/hooks.json yet (ticket 37): skipped');
    return;
  }
  const result = sh(process.execPath, [path.join(ROOT, 'scripts', 'hook-fixtures.mjs'), path.join(unpacked, 'package')], ROOT, { allowFail: true });
  process.stdout.write(result.stdout);
  if (result.status !== 0) throw new Error('hook fixtures failed');
});

step('4. the MCP entry answers initialize', () => {
  // From a scratch folder, so the repository's own .npmrc (min-release-age) doesn't apply.
  const out = sh(process.execPath, [path.join(ROOT, 'scripts', 'mcp-initialize.mjs'), path.join(unpacked, 'package')], mkdtempSync(path.join(tmpdir(), 'rp-mcp-')));
  console.log(out.stdout.trim().split('\n').at(-1));
});

if (process.argv.includes('--step5')) {
  step('5. quick against the dev-split Nuxt app', () => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'release-step5.mjs'), path.join(unpacked, 'package', 'dist', 'cli.mjs')], { stdio: 'inherit', cwd: ROOT });
    if (result.status !== 0) throw new Error('step 5 failed');
  });
}
console.log('test-tarball: ok');
