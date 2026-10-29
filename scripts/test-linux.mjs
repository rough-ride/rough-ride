// Runs the runner's test suite on Linux in Microsoft's Playwright image, on
// this machine, with no network writes. Needs docker (or podman behind it).
// --init gives the container a PID 1 that reaps orphaned processes.
// Usage: node scripts/test-linux.mjs [node version, default 22.22.0]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const IMAGE = 'mcr.microsoft.com/playwright:v1.64.1-noble';
const node = process.argv[2] ?? '22.22.0';
const root = fileURLToPath(new URL('..', import.meta.url));

// COPYFILE_DISABLE and --no-xattrs keep macOS from adding ._* files to the copy.
const tar = spawn('tar', ['--no-xattrs', '--exclude', 'node_modules', '--exclude', 'dist', '-cf', '-', 'packages', 'scripts', 'benchmark', '.claude-plugin', 'LICENSE', 'README.md', 'package.json', 'package-lock.json', '.npmrc'], {
  cwd: root,
  env: { ...process.env, COPYFILE_DISABLE: '1' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const script = [
  'mkdir /work && cd /work && tar xf - 2>/dev/null',
  'npm ci --silent && npm ci --silent --prefix packages/rough-ride && npm run build --silent',
  `npx -y -p node@${node} -- node --test "packages/rough-ride/test/*.test.mjs"`,
  `npx -y -p node@${node} -- node --test "benchmark/bench/test/*.test.mts"`,
].join(' && ');
const docker = spawn('docker', ['run', '--rm', '-i', '--init', IMAGE, 'bash', '-c', script], { stdio: ['pipe', 'inherit', 'inherit'] });
tar.stdout.pipe(docker.stdin);
docker.on('exit', (code) => process.exit(code ?? 1));
