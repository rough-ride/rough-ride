// A start command with a grandchild: writes both pids and the environment
// names the runner must pass through, then serves 200 on the given port.
// Usage: node tree.mjs <out file> <port>
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [out, port] = process.argv.slice(2);
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
const names = Object.keys(process.env).filter((k) =>
  /^(https?_proxy|all_proxy|no_proxy)$/i.test(k) || k === 'NODE_USE_ENV_PROXY' || k === 'NODE_OPTIONS' || k.startsWith('NUXT_'));
writeFileSync(out, JSON.stringify({ pid: process.pid, grandchild: grandchild.pid, cwd: process.cwd(), env: Object.fromEntries(names.map((k) => [k, process.env[k]])) }));
createServer((req, res) => res.end('ok')).listen(Number(port), '127.0.0.1');
