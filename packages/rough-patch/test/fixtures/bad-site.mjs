// A fixture app for bad inputs: a notes form (required title, textarea body)
// whose API answer and Save handler are picked by ?mode=, an OpenAPI document,
// a cross-origin API, and a search page.
import { createServer } from 'node:http';

const OPENAPI = {
  openapi: '3.1.0',
  paths: {
    '/api/notes': {
      post: {
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/NoteIn' } } } },
        responses: { 201: { content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
  },
  components: {
    schemas: {
      NoteIn: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          body: { anyOf: [{ type: 'string', maxLength: 5000 }, { type: 'null' }] },
        },
      },
    },
  },
};

function page(mode, crossPort) {
  const target = mode === 'cors500' || mode === 'cross' ? `http://127.0.0.1:${crossPort}/api/notes?mode=${mode}` : `/api/notes?mode=${mode}`;
  const handler = {
    // Returns early on anything but short titles, without a word.
    silent: `if (title.value.length > 20 || title.value.trim() === '') return;`,
    // Calls checkValidity() itself and returns; nothing is shown.
    checkonly: `if (!f.checkValidity()) return;`,
    // Shows its own message and returns.
    appblock: `if (title.value.trim() === '' || title.value.length > 20) { msg.textContent = 'Title is too long or empty'; return; }`,
    clear: '',
  }[mode] ?? '';
  return `<!doctype html><body><h1>New note</h1>
    <form id="f" ${mode === 'checkonly' ? 'novalidate' : ''}>
      <label>Title <input id="title" name="title" ${mode === 'checkonly' ? 'required' : 'required'}></label>
      <label>Body <textarea id="body" name="body"></textarea></label>
      <button id="save">Save</button>
    </form>
    <p id="msg" role="status"></p><p id="out"></p>
    <script>
      const f = document.getElementById('f'), title = document.getElementById('title'), body = document.getElementById('body');
      const msg = document.getElementById('msg'), out = document.getElementById('out');
      f.onsubmit = async (e) => {
        e.preventDefault();
        ${handler}
        const sent = { title: title.value, body: body.value };
        ${mode === 'clear' ? "title.value = ''; body.value = '';" : ''}
        try {
          const r = await fetch('${target}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sent) });
          if (r.status === 422) { msg.textContent = 'Please check the title and body'; return; }
          if (!r.ok) { msg.textContent = 'Could not save'; return; }
          out.textContent = 'Saved ' + sent.title.slice(0, 30);
        } catch { msg.textContent = 'Could not reach the server'; }
      };
    </script></body>`;
}

export function startBadSite() {
  const hits = {};
  let crossPort = 0;
  const notes = (req, res, mode, cross) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      hits[mode] = (hits[mode] ?? 0) + 1;
      let body = {};
      try {
        body = JSON.parse(data);
      } catch {
        body = {};
      }
      const title = String(body.title ?? '');
      const bad = title.trim() === '' || title.length > 200 || String(body.body ?? '').length > 5000 || /[^\x20-\x7e]|['"<>%#\\]/.test(title);
      const json = (status, value) => {
        // cors500's error answer has no CORS headers, so the page can't read its status.
        res.writeHead(status, { 'content-type': 'application/json', ...(cross && !(mode === 'cors500' && status >= 500) ? { 'access-control-allow-origin': '*' } : {}) });
        res.end(JSON.stringify(value));
      };
      if (!bad) return json(201, { id: 1, title });
      if (mode === 'crash' || mode === 'cors500') return json(500, { detail: 'boom' });
      if (mode === 'netfail') return req.socket.destroy();
      if (/^\d{3}$/.test(mode)) return json(Number(mode), { detail: 'no' });
      return json(422, { detail: 'invalid' });
    });
  };
  const cross = createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST' });
      return res.end();
    }
    notes(req, res, new URL(req.url, 'http://x').searchParams.get('mode') ?? 'cross', true);
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/openapi.json') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(OPENAPI));
    }
    if (url.pathname === '/api/notes') return notes(req, res, url.searchParams.get('mode') ?? 'plain', false);
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/notes/new') return res.end(page(url.searchParams.get('mode') ?? 'plain', crossPort));
    if (url.pathname === '/search') {
      return res.end(`<!doctype html><body><h1>Search</h1><label>Find <input type="search" id="q"></label><p id="out">ready</p></body>`);
    }
    if (url.pathname === '/shadow') {
      return res.end(`<!doctype html><body><h1>Shadow</h1><div id="host"></div><script>
        const root = document.getElementById('host').attachShadow({ mode: 'open' });
        root.innerHTML = '<form><input required aria-label="Code"><button>Go</button></form>';
        root.querySelector('form').onsubmit = (e) => e.preventDefault();
      </script></body>`);
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
