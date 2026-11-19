import { createHmac, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { callLLM, LLMError } from '../src/lib/api';
import { db, hash, hour, token, transaction, getSetting, setSetting } from './db';
import { adjustQuota, listOrders, plans, savePlan, account, pricePerStory, saveStoryPrice } from './commerce';
import { clientIp, field, int, json, rate, readBody, RequestError } from './http';
import { paymentsEnabled } from './payments';
import { availableModels, fetchVendorModels, findModel, listModels, listModelVendors, modelConfig, modelSettings, saveManagedTier, saveModel, saveVendorKey, toggleTier } from './models';

const derive = promisify(scrypt);

function decodeBase32(text: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const upper = text.toUpperCase().replace(/=+$/, '');
  if (!/^[A-Z2-7]{26,128}$/.test(upper)) return null;
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const c of upper) {
    buffer = (buffer << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 255); }
  }
  return Buffer.from(bytes);
}

function matchingTotp(secret: Buffer, input: string) {
  const counter = Math.floor(Date.now() / 30_000);
  for (const value of [counter, counter - 1, counter + 1]) {
    const message = Buffer.alloc(8);
    message.writeBigUInt64BE(BigInt(value));
    const mac = createHmac('sha1', secret).update(message).digest();
    const offset = mac[mac.length - 1] & 15;
    const candidate = String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
    if (timingSafeEqual(Buffer.from(input), Buffer.from(candidate))) return value;
  }
  return null;
}

function adminCookie(value: string, lifetime: number) {
  const secure = process.env.NF_SECURE_COOKIE === '1' ? '; Secure' : '';
  return `nf_admin=${value}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${lifetime}${secure}`;
}

function adminLoginConfig() {
  const password = /^([a-f\d]{32}):([a-f\d]{128})$/i.exec(process.env.NF_ADMIN_PASSWORD_HASH || '');
  const passwordOnly = process.env.NF_LOCAL_ADMIN_PASSWORD_ONLY === '1';
  const secret = passwordOnly ? null : decodeBase32(process.env.NF_ADMIN_TOTP_SECRET || '');
  return { password, passwordOnly, secret, configured: Boolean(password && (passwordOnly || secret)) };
}

function requireLocalAdmin(req: IncomingMessage) {
  const directAddress = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1';
  const localHost = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(req.headers.host || '');
  const forwarded = Object.keys(req.headers).some((name) => name === 'forwarded' || name.startsWith('x-forwarded-') || name === 'x-real-ip');
  const origin = req.headers.origin;
  if (!directAddress || !localHost || forwarded || (origin && origin !== 'http://' + req.headers.host) ||
      process.env.NF_TRUST_PROXY === '1' || process.env.NF_SECURE_COOKIE === '1') {
    throw new RequestError(403, 'admin_local_only');
  }
}

async function login(req: IncomingMessage, res: ServerResponse, config: ReturnType<typeof adminLoginConfig>) {
  if (!config.configured || !config.password) throw new RequestError(503, 'admin_unconfigured');
  rate('admin-login', clientIp(req), 15 * 60_000, 8);
  const { password, otp } = await readBody(req);
  if (typeof password !== 'string' || !password || password.length > 256) throw new RequestError(401, 'admin_credentials');
  const actual = await derive(password, Buffer.from(config.password[1], 'hex'), 64) as Buffer;
  if (!timingSafeEqual(actual, Buffer.from(config.password[2], 'hex'))) throw new RequestError(401, 'admin_credentials');
  const session = token();
  transaction(() => {
    if (config.secret) {
      const counter = typeof otp === 'string' && /^\d{6}$/.test(otp) ? matchingTotp(config.secret, otp) : null;
      const key = 'admin_totp_' + hash(config.secret.toString('hex'));
      if (counter === null || counter <= getSetting(key, 0)) throw new RequestError(401, 'admin_credentials');
      setSetting(key, counter);
    }
    db.prepare('DELETE FROM admin_sessions WHERE expires < ?').run(Date.now());
    db.prepare('INSERT INTO admin_sessions VALUES (?, ?)').run(hash(session), Date.now() + 8 * hour);
  });
  res.setHeader('Set-Cookie', adminCookie(session, 8 * 3600));
  return json(res, 200, { ok: true });
}

function stats(since: number, until: number) {
  const totals = db.prepare(`SELECT COUNT(*) AS total, SUM(status = 'success') AS success,
    SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, SUM(cost_cents) AS cost_cents,
    COUNT(cost_cents) AS metered, SUM(charge_cents) AS wallet_charge_cents
    FROM generations WHERE started >= ? AND started < ?`).get(since, until);
  function percentile(p: number) {
    return db.prepare(`SELECT latency_ms FROM generations WHERE started >= ? AND started < ? AND latency_ms IS NOT NULL
      ORDER BY latency_ms LIMIT 1 OFFSET MAX(0, (SELECT CAST((COUNT(*) * ? + 99) / 100 AS INTEGER) - 1 FROM generations
      WHERE started >= ? AND started < ? AND latency_ms IS NOT NULL))`).get(since, until, p, since, until)?.latency_ms ?? null;
  }
  const failures = db.prepare(`SELECT COALESCE(failure_code, status) AS status, COUNT(*) AS count FROM generations
    WHERE started >= ? AND started < ? AND status NOT IN ('running','success')
    GROUP BY COALESCE(failure_code, status) ORDER BY count DESC LIMIT 5`).all(since, until);
  return { ...totals, p50: percentile(50), p95: percentile(95), failures };
}

export async function handleAdmin(req: IncomingMessage, res: ServerResponse, path: string, url: URL) {
  const config = adminLoginConfig();
  if (config.passwordOnly) requireLocalAdmin(req);
  if (path === '/api/admin/login') {
    if (req.method === 'GET') return json(res, 200, { configured: config.configured, otpRequired: !config.passwordOnly });
    if (req.method === 'POST') return await login(req, res, config);
  }
  const session = /(?:^|;\s*)nf_admin=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  if (!session || !db.prepare('SELECT 1 FROM admin_sessions WHERE hash = ? AND expires > ?').get(hash(session), Date.now())) {
    throw new RequestError(401, 'admin_required');
  }
  if (req.method === 'GET' && path === '/api/admin/dashboard') {
    const timestamp = Number(url.searchParams.get('since'));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const since = Number.isSafeInteger(timestamp) && timestamp > Date.now() - 32 * 86400_000 && timestamp <= Date.now()
      ? timestamp : today.getTime();
    const end = Number(url.searchParams.get('until'));
    const until = Number.isSafeInteger(end) && end > since && end - since <= 26 * hour ? end : since + 24 * hour;
    return json(res, 200, { stats: stats(since, until), settings: modelSettings(), models: listModels(), vendors: listModelVendors(), effectiveDefaultModel: availableModels()[0]?.id ?? null, plans: plans(true), orders: listOrders(), storyPriceCents: pricePerStory(), paymentsEnabled: paymentsEnabled() });
  }
  if (req.method === 'GET' && path === '/api/admin/users') {
    const search = (url.searchParams.get('q') || '').slice(0, 30);
    const rows = db.prepare(`SELECT u.id, u.phone, u.status,
      (SELECT COUNT(*) FROM generations WHERE actor = u.id) AS generations
      FROM users u WHERE instr(u.phone, ?) > 0 OR ? = '' ORDER BY u.created DESC LIMIT 50`).all(search, search);
    return json(res, 200, { users: rows.map((row) => ({ ...row, ...account(String(row.id)) })) });
  }
  if (req.method !== 'POST') throw new RequestError(404, 'not_found');
  const body = await readBody(req);
  switch (path) {
    case '/api/admin/logout':
      db.prepare('DELETE FROM admin_sessions WHERE hash = ?').run(hash(session));
      res.setHeader('Set-Cookie', adminCookie('', 0));
      break;
    case '/api/admin/plans': savePlan(body); break;
    case '/api/admin/story-price': saveStoryPrice(body.priceCents); break;
    case '/api/admin/models': saveModel(body); break;
    case '/api/admin/model-providers': saveVendorKey(body); break;
    case '/api/admin/model-providers/catalog': {
      rate('admin-model-catalog', clientIp(req), hour, 25);
      return json(res, 200, { models: await fetchVendorModels(body.vendor) });
    }
    case '/api/admin/model-tiers': return json(res, 200, { id: saveManagedTier(body) });
    case '/api/admin/model-tiers/toggle': toggleTier(body); break;
    case '/api/admin/model-tiers/default': {
      const id = field(body.id, 56);
      if (!availableModels().some((model) => model.id === id)) throw new RequestError(400, 'model_unconfigured');
      setSetting('default_model', id);
      break;
    }
    case '/api/admin/models/test': {
      rate('admin-model-test', clientIp(req), hour, 20);
      const model = findModel(field(body.id, 56));
      const config = model && modelConfig(model);
      if (!config) throw new RequestError(400, 'model_unconfigured');
      const started = Date.now();
      try { await callLLM(config, { system: '只回复 OK。', user: '连通性测试', redirect: 'error', maxTokens: 1024, timeoutMs: 10_000, signal: AbortSignal.timeout(16_000) }); }
      catch (error) {
        if (error instanceof LLMError) {
          if (error.status === 401 || error.status === 403) throw new RequestError(422, 'vendor_key_invalid');
          if (error.status === 402) throw new RequestError(422, 'vendor_balance');
          if (error.status === 429) throw new RequestError(429, 'vendor_rate_limited');
          if (error.status === 404) throw new RequestError(422, 'vendor_model_missing');
        }
        throw new RequestError(502, 'model_test_failed');
      }
      return json(res, 200, { latencyMs: Date.now() - started });
    }
    case '/api/admin/settings': {
      const model = body.defaultModel === undefined ? undefined : findModel(field(body.defaultModel, 56));
      if ((body.defaultModel !== undefined && !model) || typeof body.paused !== 'boolean' || typeof body.guestFree !== 'boolean' ||
          typeof body.announcement !== 'string' || body.announcement.length > 160) throw new RequestError(400, 'invalid_input');
      transaction(() => {
        if (model) setSetting('default_model', model.id);
        setSetting('paused', body.paused);
        setSetting('guest_free', body.guestFree);
        setSetting('announcement', (body.announcement as string).trim());
      });
      break;
    }
    case '/api/admin/users': {
      const id = field(body.id, 56);
      if (body.status !== 'active' && body.status !== 'blocked') throw new RequestError(400, 'invalid_input');
      const status = body.status;
      const delta = int(body.delta, -10_000, 10_000);
      transaction(() => {
        if (!db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id).changes) throw new RequestError(404, 'not_found');
        if (delta < 0 && db.prepare("SELECT 1 FROM generations WHERE actor = ? AND status = 'running' AND started > ?")
          .get(id, Date.now() - 16 * 60_000)) throw new RequestError(409, 'generation_running');
        adjustQuota(id, delta);
      });
      break;
    }
    default: throw new RequestError(404, 'not_found');
  }
  return json(res, 200, { ok: true });
}
