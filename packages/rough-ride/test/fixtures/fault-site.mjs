// A fixture app for the full fault set: a counting JSON API on the page's own
// origin and on a second origin, and one probe page whose "Send" button calls
// any of them and prints what it received. `state` flips live responses.
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

const BODIES = {
  '/api/list': () => '[{"id":7,"title":"a"}]',
  '/api/page': () => '{"items":[{"id":7}],"total":1}',
  '/api/notes/7': () => '{"id":7,"tags":[{"id":1}]}',
  '/api/me': () => '{"id":7}',
  '/api/public': () => '{"ok":true}',
  '/api/cacheable': () => '{"cached":true}',
};

// fetch options per mode; the page shows `status|content-type|body` or `error <name>`.
const PROBE = `
  const q = new URLSearchParams(location.search);
  const target = (q.get('cross') === '1' ? 'http://127.0.0.1:' + q.get('port') : '') + q.get('u');
  const mode = q.get('mode') || 'plain';
  const out = document.getElementById('out');
  const once = async (extra = {}) => {
    const init = { method: q.get('m') || 'GET', credentials: 'include', ...extra };
    if (init.method !== 'GET') init.body = 'x';
    if (mode === 'auth') init.headers = { authorization: 'Bearer ' + localStorage.getItem('tok') };
    const r = await fetch(target, init);
    return r.status + '|' + r.headers.get('content-type') + '|' + (await r.text());
  };
  document.getElementById('send').onclick = async () => {
    let text;
    try {
      if (mode === 'retry') text = await once().then((t) => (t.startsWith('2') ? t : once()));
      else if (mode === 'abort1s') {
        const c = new AbortController();
        setTimeout(() => c.abort(), 1000);
        try { text = await once({ signal: c.signal }); }
        catch (e) { text = 'gave up ' + e.name + ' then ' + (await once().catch((e2) => 'error ' + e2.name)); }
      } else if (mode === 'auth') {
        const first = await once();
        const pub = await fetch('/api/public', { credentials: 'include' }).then((r) => r.status);
        const again = await once();
        text = first + ' || public ' + pub + ' || ' + again;
      } else text = await once();
    } catch (e) { text = 'error ' + e.name; }
    out.textContent = text;
  };`;

export function startFaultSite() {
  const hits = {};
  const log = [];
  const state = { list: 'normal' };
  const api = (req, res, cross) => {
    const url = new URL(req.url, 'http://x');
    if (cross) {
      res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('access-control-allow-headers', 'authorization');
      if (req.method === 'OPTIONS') return res.end();
    }
    const key = `${cross ? 'cross ' : ''}${req.method} ${url.pathname}`;
    hits[key] = (hits[key] ?? 0) + 1;
    log.push({ key, at: Date.now(), cookie: req.headers.cookie ?? null, authorization: req.headers.authorization ?? null });
    if (url.pathname === '/api/list' && state.list === 'redirect') {
      res.writeHead(302, { location: '/api/page', 'content-type': 'text/plain' });
      return res.end('moved');
    }
    if (url.pathname === '/api/list' && state.list === 'empty') {
      res.setHeader('content-type', 'application/json');
      return res.end('[]');
    }
    if (url.pathname === '/api/list' && state.list === 'destroy') return req.socket.destroy();
    if (url.pathname === '/api/gz') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'x-real': 'kept' });
      return res.end(gzipSync('[{"id":1}]'));
    }
    if (url.pathname === '/api/text') {
      res.setHeader('content-type', 'text/plain');
      return res.end('plain words');
    }
    if (url.pathname === '/api/blank') {
      res.setHeader('content-type', 'application/json');
      return res.end('');
    }
    const body = BODIES[url.pathname];
    if (!body) {
      res.statusCode = 404;
      return res.end('nf');
    }
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/cacheable') res.setHeader('cache-control', 'public, max-age=3600');
    if (url.pathname === '/api/list') res.setHeader('set-cookie', 'seen=1; Path=/');
    res.end(body());
  };
  let crossPort = 0;
  const cross = createServer((req, res) => api(req, res, true));
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return api(req, res, false);
    if (url.pathname === '/sw.js') {
      res.setHeader('content-type', 'text/javascript');
      return res.end(`self.addEventListener('fetch', (e) => e.respondWith(caches.open('c').then(async (c) => (await c.match(e.request)) || fetch(e.request).then((r) => { c.put(e.request, r.clone()); return r; }))));`);
    }
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/probe') {
      return res.end(`<!doctype html><body><h1>Probe</h1><button id="send">Send</button><pre id="out"></pre><script>${PROBE.replace("q.get('port')", String(crossPort))}</script></body>`);
    }
    if (url.pathname === '/sw') {
      return res.end(`<!doctype html><body><h1>SW</h1><button id="send">Send</button><p id="out"></p><script>
        navigator.serviceWorker?.register('/sw.js').catch(() => {});
        fetch('/api/cacheable').then(() => fetch('/api/cacheable'));
        document.getElementById('send').onclick = () => fetch('/api/cacheable').then((r) => r.text()).then((t) => { document.getElementById('out').textContent = 'got ' + t; });
      </script></body>`);
    }
    res.statusCode = 404;
    res.end('nf');
  });
  return new Promise((resolve) => {
    cross.listen(0, '127.0.0.1', () => {
      crossPort = cross.address().port;
      server.listen(0, '127.0.0.1', () =>
        resolve({ url: `http://127.0.0.1:${server.address().port}`, crossPort, hits, log, state, close: () => { server.close(); cross.close(); } }));
    });
  });
}
