// A very small notes page. Web on 3700, API on 8700.
import { createServer } from 'node:http';

const notes = [{ id: 1, title: 'Welcome' }];

function page() {
  const items = notes.map((n) => `<li>${n.title}</li>`).join('');
  return `<!doctype html><title>Notes</title><h1>Notes</h1><ul>${items}</ul>`;
}

createServer((req, res) => {
  if (req.url === '/api/notes') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(notes));
    return;
  }
  res.setHeader('content-type', 'text/html');
  res.end(page());
}).listen(3700, 'localhost');
