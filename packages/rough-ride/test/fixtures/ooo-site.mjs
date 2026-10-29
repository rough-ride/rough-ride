// A fixture app for out-of-order: a search box (or a category select) that
// fetches as you type and renders result titles. ?mode= picks how the page
// treats a late answer and what the server answers.
import { createServer } from 'node:http';

const SCRIPT = {
  // No guard: whatever answer arrives last wins.
  stale: '',
  // Ignores answers to anything but the latest search.
  guard: 'if (id !== latest) return;',
  html: '',
};

function page(mode) {
  const abort = mode === 'abort';
  return `<!doctype html><body><h1>Search</h1>
    <label>Find <input type="search" id="q"></label>
    <label>Category <select id="cat"><option value="">Any</option><option value="garden">Garden</option><option value="kitchen">Kitchen</option></select></label>
    <ul id="out"></ul>
    <script>
      const out = document.getElementById('out');
      let latest = 0, timer, ctrl;
      const show = (list) => { out.innerHTML = list.length ? list.map((n) => '<li>' + n.title + '</li>').join('') : '<li>No notes found.</li>'; };
      const run = async (param, value) => {
        const id = ++latest;
        ${abort ? 'if (ctrl) ctrl.abort(); ctrl = new AbortController();' : ''}
        try {
          const r = await fetch('/api/search?mode=${mode}&' + param + '=' + encodeURIComponent(value)${abort ? ', { signal: ctrl.signal }' : ''});
          ${mode === 'html' ? "const text = await r.text(); if (id === latest || true) out.innerHTML = text; return;" : ''}
          const list = await r.json();
          ${SCRIPT[mode] ?? ''}
          show(list);
        } catch (e) { if (e.name !== 'AbortError') out.textContent = 'Search failed'; }
      };
      document.getElementById('q').addEventListener('input', (e) => { clearTimeout(timer); const v = e.target.value; timer = setTimeout(() => run('q', v), 100); });
      document.getElementById('cat').addEventListener('change', (e) => run('cat', e.target.value));
    </script></body>`;
}

export function startOooSite() {
  const log = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/search') {
      const q = url.searchParams.get('q');
      const cat = url.searchParams.get('cat');
      const mode = url.searchParams.get('mode');
      log.push({ at: Date.now(), q, cat });
      let list;
      if (mode === 'same') list = [{ title: 'Garden plan' }];
      else if (q !== null) list = q === 'Garden' ? [{ title: 'Garden plan' }] : mode === 'zebra' ? [{ title: 'Zebra stripes' }] : [];
      else list = cat === 'garden' ? [{ title: 'Garden plan' }] : cat === 'kitchen' ? [{ title: 'Kitchen list' }] : [];
      return setTimeout(() => {
        if (mode === 'html') {
          res.setHeader('content-type', 'text/html');
          return res.end(list.map((n) => `<li>${n.title}</li>`).join('') || '<li>No notes found.</li>');
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(list));
      }, 80);
    }
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/search') return res.end(page(url.searchParams.get('mode') ?? 'guard'));
    res.statusCode = 404;
    res.end('nf');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, log, close: () => server.close() })));
}
