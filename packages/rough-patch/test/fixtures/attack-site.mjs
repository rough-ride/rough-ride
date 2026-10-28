// A fixture app for fault-attack tests: one "Save" button whose error handling
// is picked by ?mode=, an API that counts hits, and a second origin.
import { createServer } from 'node:http';

const SCRIPTS = {
  // A toast shown 1 s after the failure and hidden 2 s later.
  toast: `catch(() => setTimeout(() => { out.textContent = 'Could not save'; setTimeout(() => (out.textContent = ''), 2000); }, 1000))`,
  none: `catch(() => {})`,
  // Text shown while waiting, removed when the request fails.
  early: `catch(() => { out.textContent = ''; })`,
  alert: `catch(() => { alertBox.textContent = 'Saving failed'; })`,
  broken: `catch((e) => { out.textContent = 'Saved ' + e.missing; })`,
  correct: `catch(() => { out.textContent = 'Could not save, try again'; })`,
  throw: `catch(() => { throw new Error('boom after failure'); })`,
  spinner: `catch(() => { spinner.className = 'loading'; })`,
  // The button stays disabled after a failure (re-enabled only on success).
  disable: `catch(() => {})`,
  'always-disable': `catch(() => {})`,
  retry: `catch(() => {})`,
};

function page(mode) {
  const before = mode === 'early' ? `out.textContent = 'Saving now';` : '';
  const disable = mode === 'disable' || mode === 'always-disable' ? `btn.disabled = true;` : '';
  const send = mode === 'retry'
    ? `const tryIt = (left, wait) => fetch('/api/save', { method: 'POST', body: 'x' }).then((r) => { if (!r.ok) throw 0; out.textContent = 'Saved'; }).catch(() => left ? setTimeout(() => tryIt(left - 1, wait * 2), wait) : (out.textContent = 'Could not save'));
       tryIt(3, 1000);`
    : `fetch('/api/save', { method: 'POST', body: 'x' }).then((r) => { if (!r.ok) throw new Error('status ' + r.status); out.textContent = 'Saved'; ${mode === 'disable' ? 'btn.disabled = false;' : ''} }).${SCRIPTS[mode] ?? SCRIPTS.none};`;
  const onerror = mode === 'throw-replaced' ? `window.onerror = function () {}; window.addEventListener = function () {};` : '';
  const finalSend = mode === 'throw-replaced' ? `fetch('/api/save', { method: 'POST', body: 'x' }).then((r) => { if (!r.ok) throw 0; }).catch(() => { setTimeout(() => { throw new Error('thrown past onerror'); }, 0); });` : send;
  return `<!doctype html><html><body>
    <h1>Save page</h1>
    <button id="btn">Save</button>
    <p id="out"></p><p id="alertBox" role="alert"></p><span id="spinner"></span>
    <script>
      ${onerror}
      const btn = document.getElementById('btn'), out = document.getElementById('out'), alertBox = document.getElementById('alertBox'), spinner = document.getElementById('spinner');
      btn.onclick = () => { ${before} ${disable} ${finalSend} };
    </script></body></html>`;
}

export function startAttackSite() {
  const hits = { save: 0, item: 0, cross: 0 };
  let crossPort = 0;
  const cross = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
    res.setHeader('access-control-allow-credentials', 'true');
    if (req.method === 'OPTIONS') return res.end();
    hits.cross++;
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/save') {
      hits.save++;
      res.setHeader('content-type', 'application/json');
      return res.end('{"ok":true}');
    }
    if (url.pathname === '/api/flaky') return req.socket.destroy();
    if (url.pathname === '/flaky') {
      return res.end(`<!doctype html><body><h1>Flaky</h1><script>fetch('/api/flaky').catch(() => {});</script></body>`);
    }
    if (url.pathname === '/api/item') {
      hits.item++;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ q: url.searchParams.get('q') }));
    }
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/save') return res.end(page(url.searchParams.get('mode') ?? 'none'));
    if (url.pathname === '/twice') {
      // Polls before the step, then sends two GETs on click; reports both statuses.
      return res.end(`<!doctype html><body><h1>Twice</h1><button>Load</button><p id="out"></p><a href="/other">Other</a><script>
        fetch('/api/item?poll=1');
        document.querySelector('button').onclick = async () => {
          const a = await fetch('/api/item?n=1').then((r) => r.status, () => 'failed');
          const b = await fetch('/api/item?n=2').then((r) => r.status, () => 'failed');
          document.getElementById('out').textContent = 'loaded ' + a + ' ' + b;
        };</script></body>`);
    }
    if (url.pathname === '/other') {
      return res.end(`<!doctype html><body><h1>Other</h1><p id="out"></p><script>
        fetch('/api/item?q=x').then((r) => { document.getElementById('out').textContent = 'other ' + r.status; });</script></body>`);
    }
    if (url.pathname === '/bytes') {
      // Shows exactly what the page received from a same-origin and a cross-origin write.
      return res.end(`<!doctype html><body><h1>Bytes</h1><button>Send</button><pre id="out"></pre><script>
        document.querySelector('button').onclick = async () => {
          const show = async (u) => { try { const r = await fetch(u, { method: 'POST', body: 'x', credentials: 'include' }); return r.status + '|' + r.headers.get('content-type') + '|' + (await r.text()); } catch (e) { return 'error ' + e.message; } };
          document.getElementById('out').textContent = (await show('/api/save')) + ' || ' + (await show('http://127.0.0.1:${'${'}crossPort}/api/cross'));
        };</script></body>`.replace('${crossPort}', String(crossPort)));
    }
    res.statusCode = 404;
    res.end('nf');
  });
  return new Promise((resolve) => {
    cross.listen(0, '127.0.0.1', () => {
      crossPort = cross.address().port;
      server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, crossPort, hits, close: () => { server.close(); cross.close(); } }));
    });
  });
}
