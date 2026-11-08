#!/usr/bin/env node
// Static server for the generated review site. Loopback only.
//
//   node scripts/review-site/serve.mjs [--port N]
//
// Serves build/review-site, which generate.mjs produces first (npm run
// review:site runs both). Default port 8777; REVIEW_PORT overrides.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = path.join(ROOT, 'build', 'review-site');

const portIdx = process.argv.indexOf('--port');
const PORT = Number(portIdx > -1 ? process.argv[portIdx + 1] : (process.env.REVIEW_PORT || 8777));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

if (!fs.existsSync(path.join(SITE, 'data.json'))) {
  console.error(`review-site: ${path.relative(ROOT, SITE)}/data.json is missing — run \`node scripts/review-site/generate.mjs\` first.`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(SITE, rel);
  if (!file.startsWith(SITE + path.sep) && file !== path.join(SITE, 'index.html')) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`review-site: http://127.0.0.1:${PORT}/`);
});
