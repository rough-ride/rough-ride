// A fixture app for recovery: a form whose failure handling is picked by
// ?mode=. Saving shows "Saved <title>"; the API counts hits.
import { createServer } from 'node:http';

const ON_FAIL = {
  // Message, values kept, Save still there.
  keep: `out.textContent = 'Could not save';`,
  // Saves the title, then clears the field before the answer (the cleared-form bug).
  clear: `out.textContent = 'Could not save';`,
  // Save goes away and a "Try again" button appears.
  swap: `btn.hidden = true; again.hidden = false; out.textContent = 'Could not save';`,
  // Save goes away with no way to retry.
  dead: `btn.hidden = true; out.textContent = 'Could not save';`,
  // Trailing spaces added to the title, and the password emptied.
  spaces: `title.value = title.value + '   '; pass.value = ''; out.textContent = 'Could not save';`,
  // Navigates away from the form.
  away: `location.href = '/elsewhere';`,
};

function page(mode) {
  return `<!doctype html><body><h1>Form</h1>
    <form id="f"><label>Title <input id="title" name="title" required></label>
    <label>Password <input id="pass" type="password"></label>
    <div><label>Notes <div id="notes" contenteditable="true" role="textbox" aria-label="Notes"></div></label></div>
    <button id="btn">Save</button></form>
    <button id="again" hidden>Try again</button>
    <p id="out"></p>
    <script>
      const f = document.getElementById('f'), btn = document.getElementById('btn'), again = document.getElementById('again');
      const title = document.getElementById('title'), pass = document.getElementById('pass'), out = document.getElementById('out');
      const save = async () => {
        const value = title.value;
        ${mode === 'clear' ? "title.value = '';" : ''}
        try {
          const r = await fetch('/api/save', { method: 'POST', body: JSON.stringify({ title: value }) });
          if (!r.ok) throw new Error('status ' + r.status);
          out.textContent = 'Saved ' + value;
          again.hidden = true; btn.hidden = false;
        } catch { ${ON_FAIL[mode] ?? ON_FAIL.keep} }
      };
      f.onsubmit = (e) => { e.preventDefault(); save(); };
      again.onclick = save;
    </script></body>`;
}

export function startRecoverySite() {
  const hits = { save: 0, list: 0 };
  const log = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/save') {
      hits.save++;
      log.push({ at: Date.now(), key: 'POST /api/save' });
      res.setHeader('content-type', 'application/json');
      return res.end('{"ok":true}');
    }
    if (url.pathname === '/api/list') {
      hits.list++;
      res.setHeader('content-type', 'application/json');
      return res.end('[{"id":1,"title":"a"}]');
    }
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/elsewhere') return res.end('<!doctype html><body><h1>Elsewhere</h1></body>');
    if (url.pathname === '/list') {
      // Shows the first title; an empty list shows nothing.
      return res.end(`<!doctype html><body><h1>List</h1><button>Load</button><p id="out"></p><script>
        document.querySelector('button').onclick = () => fetch('/api/list').then((r) => r.json()).then((j) => { document.getElementById('out').textContent = 'First: ' + (j[0] ? j[0].title : 'none'); }, () => { document.getElementById('out').textContent = 'Load failed'; });
      </script></body>`);
    }
    if (url.pathname === '/form') return res.end(page(url.searchParams.get('mode') ?? 'keep'));
    res.statusCode = 404;
    res.end('nf');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, hits, log, close: () => server.close() })));
}
