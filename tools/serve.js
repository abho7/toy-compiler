// A static file server for the playground and the report.
//
// It exists so the browser pages can be checked locally against exactly what
// GitHub Pages will serve: a directory resolves to its index.html, and the
// modules under src/ are served with the right type so the same source runs in
// the browser as under node --test.
//
//   node tools/serve.js [port]

import { createReadStream, statSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? 8099);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.mc': 'text/plain; charset=utf-8',
};

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  let path = join(ROOT, relative);

  // Refuse anything outside the repository, checked before the directory rule
  // below so no resolution can walk out of the tree.
  if (!path.startsWith(ROOT + sep) && path !== ROOT) {
    res.writeHead(403).end('outside the repository');
    return;
  }
  // A directory serves its index.html, as GitHub Pages does, so that / here
  // and / when deployed are the same page.
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
  if (!existsSync(path) || statSync(path).isDirectory()) {
    res.writeHead(404).end(`not found: ${relative}`);
    return;
  }

  res.writeHead(200, {
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    'content-length': statSync(path).size,
    'cache-control': 'no-cache',
  });
  createReadStream(path).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`serving ${ROOT} at http://127.0.0.1:${port}/`);
  console.log(`  report:     http://127.0.0.1:${port}/`);
  console.log(`  playground: http://127.0.0.1:${port}/web/playground.html`);
});
