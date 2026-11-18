/**
 * 零依赖静态服务器：把 dist/ 以 http 方式提供。
 * 为什么需要它：浏览器在 file:// 下会禁用 IndexedDB / localStorage，
 * 草稿箱会降级为内存模式。用 http 打开才有完整的自动保存与快照回滚。
 *
 *   npm run start            # 默认 4173
 *   PORT=8080 npm run start
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('dist');
const port = Number(process.env.PORT ?? 4173);

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
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.resolve(root, `.${rel}`);
    if (!file.startsWith(root)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(String(err));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`NovelFlow Studio → http://127.0.0.1:${port}/`);
  console.log('（按 Ctrl+C 退出；此模式下草稿箱使用 IndexedDB，可自动保存与回滚）');
});
