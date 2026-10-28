// A stand-in Nuxt dev server: listens on <host>:<port> (0 picks a free port),
// then writes <dir>/.nuxt/nuxt.lock the way Nuxt 4.6 does and serves it at
// /_nuxt/@fs<cwd>/.nuxt/nuxt.lock. Usage: node fake-nuxt.mjs <dir> [host] [port]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const [dir, host = '::1', port = '0'] = process.argv.slice(2);
const lockFile = path.join(dir, '.nuxt', 'nuxt.lock');
const server = createServer((req, res) => {
  const cwd = dir.replace(/\\/g, '/');
  const lockPath = `/_nuxt/@fs${cwd.startsWith('/') ? '' : '/'}${encodeURI(cwd)}/.nuxt/nuxt.lock`;
  if (req.url === lockPath) res.end(readFileSync(lockFile));
  else res.end('ok');
});
server.listen(Number(port), host, () => {
  mkdirSync(path.dirname(lockFile), { recursive: true });
  const lock = { pid: process.pid, startedAt: Date.now(), interactive: false, command: 'dev', cwd: dir, port: server.address().port, hostname: host };
  writeFileSync(lockFile, JSON.stringify(lock, null, 2));
});
