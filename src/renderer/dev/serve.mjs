/**
 * Static dev server for the harness. Zero dependencies, loopback only.
 *
 *   node src/renderer/build.mjs
 *   node src/renderer/dev/serve.mjs
 *   -> http://127.0.0.1:4173/dev/harness.html
 *
 * This exists because ES modules cannot be loaded over file://. It serves the
 * renderer directory and nothing above it. The app itself never talks to it.
 */

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const requested = decodeURIComponent(url.pathname);
  const target = resolve(ROOT, '.' + normalize(requested).replace(/^([/\\])+/, sep));

  // Never serve outside the renderer directory.
  if (!target.startsWith(ROOT + sep) && target !== ROOT) {
    res.writeHead(403).end('forbidden');
    return;
  }

  let file = target;
  const stat = statSync(file, { throwIfNoEntry: false });
  if (stat && stat.isDirectory()) file = join(file, 'index.html');
  if (!statSync(file, { throwIfNoEntry: false })) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('bulunamadı');
    return;
  }

  res.writeHead(200, {
    'content-type': TYPES[extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`harness: http://127.0.0.1:${PORT}/dev/harness.html`);
});
