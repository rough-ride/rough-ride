import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CLI = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
export const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

// A fresh folder outside any git repository.
export function scratchDir() {
  return realpathSync(mkdtempSync(path.join(tmpdir(), 'rough-patch-test-')));
}

export function run(args, { preload, cwd = scratchDir(), env = {} } = {}) {
  const nodeArgs = preload ? ['--import', pathToFileURL(preload).href, CLI, ...args] : [CLI, ...args];
  const result = spawnSync(process.execPath, nodeArgs, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, AI_AGENT: '', CLAUDE_CODE_EXECPATH: '', ...env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}


export function sh(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

// A fresh git repository with a frontend/ and a backend/ folder.
export function gitRepo() {
  const root = scratchDir();
  sh(root, 'init', '-q');
  sh(root, 'config', 'user.email', 'test@example.com');
  sh(root, 'config', 'user.name', 'test');
  mkdirSync(path.join(root, 'frontend'));
  mkdirSync(path.join(root, 'backend'));
  return root;
}

// True when the volume holding `dir` tells Abc from abc.
export function caseSensitive(dir) {
  const probe = path.join(dir, 'Case-Probe');
  writeFileSync(probe, '');
  const sensitive = !existsSync(path.join(dir, 'case-probe'));
  rmSync(probe);
  return sensitive;
}

// Like run(), without blocking this process, for tests whose servers live in it;
// `input`, when given, is written to stdin.
export function runAsync(args, { cwd = scratchDir(), env = {}, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, AI_AGENT: '', CLAUDE_CODE_EXECPATH: '', ...env },
    });
    if (input !== undefined) child.stdin.end(input);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
