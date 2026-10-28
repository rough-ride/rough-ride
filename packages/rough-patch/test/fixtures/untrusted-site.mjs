// A fixture app for the untrusted-run guards (44.5): a delete of a record the
// flow never saw, a create then delete of its own record, and a link to another site.
import { createServer } from 'node:http';

const PAGE = `<!doctype html><body><h1>Items</h1>
  <button id="foreign">Delete 42</button>
  <button id="own">Create and delete</button>
  <a href="http://example.invalid/">Elsewhere</a>
  <p id="out"></p>
  <script>
    const out = document.getElementById('out');
    document.getElementById('foreign').onclick = () =>
      fetch('/api/items/42', { method: 'DELETE' }).then(() => (out.textContent = 'Deleted 42'), () => (out.textContent = 'Blocked'));
    document.getElementById('own').onclick = async () => {
      const { id } = await fetch('/api/items', { method: 'POST', body: '{}' }).then((r) => r.json());
      await fetch('/api/items/' + id, { method: 'DELETE' });
      out.textContent = 'Deleted ' + id;
    };
  </script></body>`;

export function startUntrustedSite() {
  const hits = {};
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const key = `${req.method} ${url.pathname}`;
    hits[key] = (hits[key] ?? 0) + 1;
    if (key === 'POST /api/items') {
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'abc123' }));
    }
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    res.setHeader('content-type', 'text/html');
    res.end(PAGE);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, hits, close: () => server.close() })));
}
