import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { handleApi } from '../dist-server/api.js';

const root = path.resolve('dist');
const port = Number(process.env.PORT ?? 4173);
const routes = new Map([
  ['/', '/index.html'],
  ['/admin', '/admin/index.html'],
  ['/admin/', '/admin/index.html'],
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    const rel = routes.get(pathname) ?? pathname;
    const file = path.resolve(root, `.${rel}`);
    const relative = path.relative(root, file);
    if (relative === '..' || relative.startsWith('..' + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    const data = await readFile(file);
    if (rel.endsWith('.html')) res.setHeader('Content-Security-Policy', "default-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`续章工坊 → http://127.0.0.1:${server.address().port}/`);
  console.log(`管理后台 → http://127.0.0.1:${server.address().port}/admin`);
});
