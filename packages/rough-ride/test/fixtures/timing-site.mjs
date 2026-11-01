// A fixture app for double-submit: one button per page, each sending a
// different pattern of writes. The API counts and answers like a small backend.
import { createServer } from 'node:http';

const SCRIPTS = {
  // A create with no guard: every click posts.
  noguard: `btn.onclick = () => fetch('/api/notes', { method: 'POST', body: '{}' }).then((r) => r.json()).then((j) => (out.textContent = 'Saved ' + j.id));`,
  // The button disables itself while saving.
  guard: `btn.onclick = () => { if (btn.disabled) return; btn.disabled = true; fetch('/api/notes', { method: 'POST', body: '{}' }).then((r) => r.json()).then((j) => { out.textContent = 'Saved ' + j.id; btn.disabled = false; }); };`,
  // Enter in the Title field submits the form, unguarded.
  press: `document.querySelector('form').onsubmit = (e) => { e.preventDefault(); fetch('/api/notes', { method: 'POST', body: '{}' }).then((r) => r.json()).then((j) => (out.textContent = 'Saved ' + j.id)); };`,
  // A POST toggle without ARIA state: answers differ only in a boolean.
  toggle: `btn.onclick = () => fetch('/api/star', { method: 'POST' }).then((r) => r.json()).then((j) => (out.textContent = j.starred ? 'Starred' : 'Not starred'));`,
  // The same toggle whose answers also carry a changing counter.
  'toggle-count': `btn.onclick = () => fetch('/api/star?count=1', { method: 'POST' }).then((r) => r.json()).then((j) => (out.textContent = 'Stars ' + j.count));`,
  // A toggle with aria-pressed: skipped.
  'toggle-aria': `btn.setAttribute('aria-pressed', 'false'); btn.onclick = () => fetch('/api/star', { method: 'POST' });`,
  patch: `btn.onclick = () => fetch('/api/notes/1', { method: 'PATCH', body: '{}' }).then(() => (out.textContent = 'Updated'));`,
  // Two equal 2xx answers for one key.
  equal: `btn.onclick = () => fetch('/api/ping', { method: 'POST' }).then(() => (out.textContent = 'Pinged'));`,
  // A guarded create plus an unguarded analytics POST with equal answers.
  analytics: `let busy = false; btn.onclick = () => { fetch('/api/events', { method: 'POST', body: '{}' }); if (busy) return; busy = true; fetch('/api/notes', { method: 'POST', body: '{}' }).then((r) => r.json()).then((j) => (out.textContent = 'Saved ' + j.id)); };`,
  // First click POSTs, the second DELETEs: a key the baseline never sent.
  fav: `let on = false; btn.onclick = () => { on = !on; fetch('/api/fav', { method: on ? 'POST' : 'DELETE' }).then(() => (out.textContent = on ? 'Faved' : 'Unfaved')); };`,
  // The duplicate gets a 500.
  dup500: `btn.onclick = () => fetch('/api/once', { method: 'POST' }).then((r) => (out.textContent = 'Done ' + r.status));`,
  // A PUT first, then the create.
  putpost: `btn.onclick = async () => { await fetch('/api/prefs', { method: 'PUT', body: '{}' }); const j = await fetch('/api/notes', { method: 'POST', body: '{}' }).then((r) => r.json()); out.textContent = 'Saved ' + j.id; };`,
};

export function startTimingSite() {
  const hits = {};
  let nextId = 1;
  let starred = false;
  let count = 0;
  let onceTaken = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const key = `${req.method} ${url.pathname}`;
    hits[key] = (hits[key] ?? 0) + 1;
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.startsWith('/api/')) {
      // A short delay, so a doubled click overlaps the first request.
      return setTimeout(() => {
        if (key === 'POST /api/notes') return json(201, { id: nextId++, title: 'x' });
        if (key === 'POST /api/star') {
          starred = !starred;
          count++;
          return json(200, url.searchParams.has('count') ? { id: 1, starred, count } : { id: 1, starred });
        }
        if (key === 'POST /api/once') {
          // The duplicate's 500 answers 300 ms after the first request's 200, so it always lands last.
          if (onceTaken) return void setTimeout(() => json(500, { detail: 'busy' }), 300);
          onceTaken = true;
          setTimeout(() => (onceTaken = false), 1000);
          return json(200, { ok: true });
        }
        if (key === 'POST /api/ping' || key === 'POST /api/events') return json(200, { ok: true });
        return json(200, { ok: true });
      }, 150);
    }
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/submit') return res.end('<!doctype html><body><h1>Submitted</h1></body>');
    if (url.pathname === '/docpost') {
      return res.end('<!doctype html><body><h1>Doc</h1><form method="post" action="/submit"><button>Send</button></form></body>');
    }
    const mode = url.pathname.slice(1);
    if (!SCRIPTS[mode]) {
      res.statusCode = 404;
      return res.end('nf');
    }
    res.end(`<!doctype html><body><h1>Page</h1><form><label>Title <input name="title"></label></form>
      <button id="btn">Save</button><p id="out"></p>
      <script>const btn = document.getElementById('btn'), out = document.getElementById('out'); ${SCRIPTS[mode]}</script></body>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, hits, close: () => server.close() })));
}
