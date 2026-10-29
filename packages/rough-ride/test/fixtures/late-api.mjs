// A start command whose app answers at once while its API starts listening
// <delay ms> later (never with -1). The page calls the API, then shows Ready.
// Usage: node late-api.mjs <web port> <api port> <delay ms>
import { createServer } from 'node:http';

const [webPort, apiPort, delay] = process.argv.slice(2).map(Number);

export const PAGE = (api) => `<!doctype html><html><body><h1>Sign in</h1><p id="out"></p><script>
  fetch('http://127.0.0.1:${api}/api/me').then((r) => r.text(), () => 'down')
    .then((t) => { document.getElementById('out').textContent = 'Ready ' + t; });</script></body></html>`;

if (webPort) {
  createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(PAGE(apiPort));
  }).listen(webPort, '127.0.0.1');
  const api = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('content-type', 'application/json');
    res.end('{"user":"demo"}');
  });
  if (delay >= 0) setTimeout(() => api.listen(apiPort, '127.0.0.1'), delay);
}
