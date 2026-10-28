// A fixture app on a stand-in Vite dev server: the page loads /src/save.js as
// a module, so a flow on it reaches the repository's src/save.js, and its Save
// button swallows a failed request, so a 500 attack is a finding.
// startCiSite() resolves with its URL and how often save.js was served;
// `script(n)` may serve another save.js for the nth load.
import { createServer } from 'node:http';

export const SAVE_JS = `document.getElementById('save').onclick = () => {
  fetch('/api/save', { method: 'POST', body: 'x' })
    .then((r) => { if (!r.ok) throw new Error('status ' + r.status); document.getElementById('out').textContent = 'Saved'; })
    .catch(() => {});
};
`;

const PAGE = `<!doctype html><html><body><h1>Notes</h1><button id="save">Save</button><p id="out"></p>
<script type="module" src="/@vite/client"></script>
<script type="module" src="/src/save.js"></script></body></html>`;

export function startCiSite({ onModule = () => {}, script = () => SAVE_JS } = {}) {
  let served = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/@vite/client') {
      res.setHeader('content-type', 'text/javascript');
      return res.end('export {};\n');
    }
    if (url.pathname === '/src/save.js') {
      served++;
      onModule(served);
      res.setHeader('content-type', 'text/javascript');
      res.setHeader('cache-control', 'no-store');
      return res.end(script(served));
    }
    if (url.pathname === '/api/save') {
      res.setHeader('content-type', 'application/json');
      return res.end('{"ok":true}');
    }
    res.setHeader('content-type', 'text/html');
    res.end(PAGE);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, server, served: () => served })));
}
