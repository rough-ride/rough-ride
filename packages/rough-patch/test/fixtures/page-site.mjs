// A fixture single-page app for refresh, back and signed-out-reload: in-app
// links use history.pushState, and the server answers every page path with the
// same shell unless ?mode= (kept in a cookie) asks for a broken server render.
import { createServer } from 'node:http';

const SHELL = (mode) => `<!doctype html><body><nav><a href="/" data-link>Home</a> <a href="/new" data-link>New</a></nav><main id="main"></main>
<script>
  const mode = ${JSON.stringify(mode)};
  const main = document.getElementById('main');
  const render = () => {
    const p = location.pathname;
    if (p === '/') { window.store = { name: 'Ada' }; main.innerHTML = '<h1>Home</h1>'; }
    else if (p === '/new') {
      main.innerHTML = '<h1>New</h1><p>Hello ' + (mode === 'stateful' ? window.store?.name : 'Ada') + '</p>';
      if (mode === 'beforeunload') window.onbeforeunload = (e) => { e.preventDefault(); e.returnValue = ''; };
    } else if (p === '/me') {
      main.innerHTML = '<h1>Me</h1><p id="who">loading</p>';
      fetch('/api/me', { credentials: 'include', headers: localStorage.tok ? { authorization: 'Bearer ' + localStorage.tok } : {} })
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((j) => { document.getElementById('who').textContent = 'Signed in as ' + j.name; }, (s) => { document.getElementById('who').textContent = 'Signed out (' + s + ')'; });
    } else main.innerHTML = '<h1>Other</h1>';
    window.readyFlag = true;
  };
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (!a) return;
    e.preventDefault();
    if (mode === 'replace' && a.getAttribute('href') === '/new') history.replaceState({}, '', '/new');
    else history.pushState({}, '', a.getAttribute('href'));
    render();
  });
  window.addEventListener('popstate', render);
  render();
</script></body>`;

export function startPageSite() {
  const posts = { count: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const mode = url.searchParams.get('mode') ?? /mode=([a-z0-9-]+)/.exec(req.headers.cookie ?? '')?.[1] ?? 'plain';
    if (url.searchParams.has('mode')) res.setHeader('set-cookie', `mode=${mode}; Path=/`);
    if (url.pathname === '/api/me') {
      const signedIn = /sid=sid-0123456789abcdef/.test(req.headers.cookie ?? '') || /Bearer/.test(req.headers.authorization ?? '');
      res.writeHead(signedIn ? 200 : 401, { 'content-type': 'application/json' });
      return res.end(signedIn ? '{"name":"Ada"}' : '{"detail":"Not authenticated"}');
    }
    if (url.pathname === '/posted' && req.method === 'POST') {
      posts.count++;
      res.setHeader('content-type', 'text/html');
      return res.end('<!doctype html><body><h1>Posted</h1></body>');
    }
    if (url.pathname === '/form') {
      res.setHeader('content-type', 'text/html');
      return res.end('<!doctype html><body><h1>Form</h1><form method="post" action="/posted"><button>Send</button></form></body>');
    }
    // A server render that only breaks on a direct load of /new.
    if (url.pathname === '/new' && mode === 'crash500') {
      res.statusCode = 500;
      return res.end('server error');
    }
    if (url.pathname === '/new' && mode === 'loop') {
      res.writeHead(302, { location: '/new' });
      return res.end();
    }
    res.setHeader('content-type', 'text/html');
    res.end(SHELL(mode));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, posts, close: () => server.close() })));
}
