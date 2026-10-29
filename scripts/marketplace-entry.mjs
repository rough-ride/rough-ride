// The marketplace-entry check: the pinned source.version is an exact x.y.z,
// npm serves that version, and the registry tarball's plugin.json says it too.
// The npm lookups are skipped with --offline (local tests).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export function entryProblems(marketplace) {
  const entry = marketplace.plugins?.find((p) => p.name === 'rough-ride');
  if (!entry) return ['no rough-ride entry in .claude-plugin/marketplace.json'];
  const version = entry.source?.version;
  if (version === undefined) return ['source.version is missing'];
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return [`source.version ${version} is not an exact x.y.z (no ranges, no dist-tags)`];
  if ('version' in entry) return ['the entry has its own version field; only source.version pins it'];
  return [];
}

function npmChecks(version) {
  const sh = (args, cwd) => execFileSync('npm', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' }).trim();
  const served = sh(['view', `rough-ride@${version}`, 'version'], ROOT);
  if (served !== version) return [`npm does not serve rough-ride@${version}`];
  const dir = mkdtempSync(path.join(tmpdir(), 'rp-entry-'));
  sh(['pack', `rough-ride@${version}`, '--silent'], dir);
  const plugin = JSON.parse(execFileSync('tar', ['-xzOf', path.join(dir, `rough-ride-${version}.tgz`), 'package/.claude-plugin/plugin.json'], { encoding: 'utf8' }));
  return plugin.version === version ? [] : [`the registry tarball's plugin.json says ${plugin.version}, not ${version}`];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const marketplace = JSON.parse(readFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  let problems = entryProblems(marketplace);
  if (problems.length === 0 && !process.argv.includes('--offline')) problems = npmChecks(marketplace.plugins.find((p) => p.name === 'rough-ride').source.version);
  for (const p of problems) console.log(p);
  if (problems.length > 0) process.exit(1);
  console.log('marketplace-entry: ok');
}
