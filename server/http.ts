import type { IncomingMessage, ServerResponse } from 'node:http';
import { db, hash } from './db';

export function json(res: ServerResponse, status: number, data: object) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export class RequestError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

export async function readRawBody(req: IncomingMessage, maxBytes = 96_000) {
  if (Number(req.headers['content-length'] ?? 0) > maxBytes) {
    req.resume();
    throw new RequestError(413, 'invalid_input');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBytes) {
      req.resume();
      throw new RequestError(413, 'invalid_input');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new RequestError(415, 'invalid_input');
  const raw = await readRawBody(req);
  try {
    const body: unknown = JSON.parse(raw.toString('utf8'));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // Respond with the same input error for malformed JSON.
  }
  throw new RequestError(400, 'invalid_input');
}

export function clientIp(req: IncomingMessage) {
  // Only trust a forwarding header when the reverse proxy overwrites it.
  const address = process.env.NF_TRUST_PROXY === '1' && req.socket.remoteAddress === '127.0.0.1'
    ? req.headers['x-forwarded-for']?.toString().split(',').at(-1)?.trim() || req.socket.remoteAddress
    : req.socket.remoteAddress;
  return hash(address || 'unknown');
}

export function rate(scope: string, subject: string, interval: number, limit: number) {
  const now = Date.now();
  const row = db.prepare(`
    INSERT INTO rate_windows VALUES (?, ?, ?, 1)
    ON CONFLICT(scope, subject) DO UPDATE SET
      attempts = CASE WHEN ? - bucket < ? THEN attempts + 1 ELSE 1 END,
      bucket = CASE WHEN ? - bucket < ? THEN bucket ELSE excluded.bucket END
    RETURNING attempts
  `).get(scope, subject, now, now, interval, now, interval);
  if (Number(row?.attempts) > limit) throw new RequestError(429, 'rate_limited');
}

export function int(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RequestError(400, 'invalid_input');
  }
  return value;
}

export function field(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new RequestError(400, 'invalid_input');
  return value.trim();
}
