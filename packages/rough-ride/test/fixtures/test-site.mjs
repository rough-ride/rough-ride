// A small non-Nuxt site for flow-run tests. startSite() resolves with its URL.
import { createServer } from 'node:http';

const PAGES = {
  '/': `<h1>Home</h1><button>Go</button><button>Go</button><a href="/admin/users">Admin</a>
        <button id="alert" onclick="alert('hi')">Alert</button><p id="after"></p>
        <script>document.getElementById('alert').addEventListener('click', () => { document.getElementById('after').textContent = 'after alert'; });</script>`,
  '/admin/users': '<h1>Users</h1>',
  '/sw': `<h1>SW</h1><p id="out">waiting</p><script>
    navigator.serviceWorker.register('/sw.js').then(() => new Promise((r) => setTimeout(r, 500)))
      .then(() => { document.getElementById('out').textContent = 'controller: ' + (navigator.serviceWorker.controller ? 'yes' : 'none'); })
      .catch((e) => { document.getElementById('out').textContent = 'controller: none (' + e.name + ')'; });</script>`,
  '/twice': `<h1>Twice</h1><p id="out"></p><script>
    (async () => { await fetch('/data'); await fetch('/data'); document.getElementById('out').textContent = 'done'; })();</script>`,
  '/info': `<p id="out"></p><script>document.getElementById('out').textContent =
    ['webdriver ' + navigator.webdriver, 'tz ' + Intl.DateTimeFormat().resolvedOptions().timeZone, 'lang ' + navigator.language].join(' | ');</script>`,
  '/ready': `<h1>Ready</h1><script>setTimeout(() => { window.appReady = true; document.body.insertAdjacentHTML('beforeend', '<label>Name <input></label>'); }, 300);</script>`,
  '/late': `<h1>Late</h1><label>Name <input id="n"></label><script>
    setTimeout(() => { document.body.insertAdjacentHTML('beforeend', '<p>Loaded later</p>'); }, 200);</script>`,
};

export function startSite({ apiDown } = {}) {
  let hits = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/data') {
      hits++;
      res.setHeader('cache-control', 'max-age=3600');
      res.end('{"ok":true}');
      return;
    }
    if (url.pathname === '/hits') return res.end(String(hits));
    if (url.pathname === '/sw.js') {
      res.setHeader('content-type', 'text/javascript');
      return res.end("self.addEventListener('fetch', () => {});");
    }
    if (url.pathname === '/api-down') {
      res.setHeader('content-type', 'text/html');
      return res.end(`<h1>Down</h1><script>fetch('http://127.0.0.1:${apiDown}/api/x').catch(() => {});</script>`);
    }
    const page = PAGES[url.pathname];
    res.statusCode = page ? 200 : 404;
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><html><body>${page ?? 'not found'}</body></html>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, server, hits: () => hits })));
}
