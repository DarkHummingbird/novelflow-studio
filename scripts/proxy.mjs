/**
 * 本地 OpenAI 兼容代理 —— 解决浏览器直连第三方 API 的 CORS 问题，
 * 并让真实 API Key 只留在服务端（浏览器里填任意占位串即可）。
 *
 *   NF_KEY=sk-xxx NF_UPSTREAM=https://api.deepseek.com/v1 NF_MODEL=deepseek-chat node scripts/proxy.mjs
 *   # 然后在产品里填：Base URL = http://127.0.0.1:8787/v1，API Key = local
 *
 * 环境变量：
 *   NF_KEY       上游密钥（必填；不会写日志、不会回传给浏览器）
 *   NF_UPSTREAM  上游 Base URL（默认 https://api.deepseek.com/v1）
 *   NF_MODEL     强制改写模型名（可选）
 *   NF_PORT      本地端口（默认 8787）
 */
import { createServer } from 'node:http';
import { Readable } from 'node:stream';

const PORT = Number(process.env.NF_PORT ?? 8787);
const UPSTREAM = (process.env.NF_UPSTREAM ?? 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const KEY = (process.env.NF_KEY ?? '').trim();
const MODEL = (process.env.NF_MODEL ?? '').trim();

if (!KEY) {
  console.error('缺少 NF_KEY（上游 API Key）。示例：NF_KEY=sk-xxx node scripts/proxy.mjs');
  process.exit(1);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization,content-type,x-goog-api-key',
  'Access-Control-Max-Age': '86400',
};

function json(res, status, payload) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    json(res, 200, { object: 'list', data: [{ id: MODEL || 'deepseek-chat', object: 'model' }] });
    return;
  }

  if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
    json(res, 404, { error: { message: `不支持的路径：${url.pathname}（只代理 /v1/chat/completions）` } });
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    json(res, 400, { error: { message: '请求体不是合法 JSON' } });
    return;
  }
  if (MODEL) body.model = MODEL;

  const started = Date.now();
  try {
    const upstream = await fetch(`${UPSTREAM}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      console.warn(`[proxy] ${upstream.status} ${text.slice(0, 160)}`);
      res.writeHead(upstream.status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(text || JSON.stringify({ error: { message: `upstream ${upstream.status}` } }));
      return;
    }

    res.writeHead(200, {
      ...CORS,
      'Content-Type': upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });

    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
      res.on('close', () => {
        console.log(`[proxy] ${body.stream ? 'stream' : 'json'} ${Date.now() - started}ms model=${body.model}`);
      });
    } else {
      res.end();
    }
  } catch (err) {
    console.warn('[proxy] 上游请求失败：', err instanceof Error ? err.message : String(err));
    json(res, 502, { error: { message: `上游请求失败：${err instanceof Error ? err.message : String(err)}` } });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`NovelFlow 代理已启动 → http://127.0.0.1:${PORT}/v1`);
  console.log(`上游：${UPSTREAM}${MODEL ? ` · 模型固定为 ${MODEL}` : ''} · Key 仅在服务端`);
});
