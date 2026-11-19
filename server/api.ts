import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db, day, hash, hour, token, transaction } from './db';
import { clientIp, json, rate, readBody, RequestError } from './http';
import { handleAdmin } from './admin';
import { requestCode, verifyPhone } from './auth';
import { account, charge, createOrder, listOrders, plans, pricePerStory, publicOrder, quote, readOrder } from './commerce';
import type { Billing } from './commerce';
import { checkoutOrder, handleStripeEvent, paymentsEnabled, statusForOrder } from './payments';
import { availableModels, modelConfig, modelSettings } from './models';
import { countWords } from '../src/lib/text';
import { LLMError } from '../src/lib/api';
import { generateStory } from './generate';
import { StoryAnalysisError } from './story-context';
import { extractRecording } from './ocr/upload';

const maxRun = 15 * 60_000;
const active = new Map<string, { actor: string; controller: AbortController }>();
const goals = { short: 4000, medium: 6000, long: 8000 } as const;
interface Identity { actor: string; ip: string; guest: boolean; quota: number; userId?: string }
function identify(req: IncomingMessage, res: ServerResponse): Identity {
  const ip = clientIp(req);
  if (req.headers.authorization) {
    const bearer = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization)?.[1];
    const actor = bearer && hash(bearer);
    const session = actor && db.prepare(`SELECT s.quota, s.user_id, u.status FROM sessions s
      LEFT JOIN users u ON s.user_id = u.id WHERE s.hash = ? AND s.expires > ?`).get(actor, Date.now());
    if (!actor || !session) throw new RequestError(401, 'login_required');
    if (session.user_id && session.status !== 'active') throw new RequestError(403, 'account_blocked');
    const userId = session.user_id ? String(session.user_id) : undefined;
    return { actor: userId ?? actor, userId, ip, guest: false, quota: Number(session.quota) };
  }
  const saved = /(?:^|;\s*)nf_guest=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  const guestToken = saved || token();
  if (!saved) {
    res.setHeader('Set-Cookie', `nf_guest=${guestToken}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=31536000${process.env.NF_SECURE_COOKIE === '1' ? '; Secure' : ''}`);
  }
  return { actor: hash(guestToken), ip, guest: true, quota: 1 };
}

function remaining(user: Identity) {
  if (user.userId) return account(user.userId).remaining;
  const used = db.prepare('SELECT COUNT(*) AS n FROM generations WHERE actor = ? AND charged = 1').get(user.actor);
  if (user.guest) {
    if (!modelSettings().guestFree) return 0;
    const ipUsed = db.prepare('SELECT 1 FROM generations WHERE ip = ? AND is_guest = 1 AND charged = 1 AND started > ? LIMIT 1')
      .get(user.ip, Date.now() - day);
    if (ipUsed) return 0;
  }
  return Math.max(0, user.quota - Number(used?.n));
}

function readerAccount(user: Identity) {
  const settings = modelSettings();
  const models = availableModels();
  const tiers = (user.guest ? models.slice(0, 1) : models).map((model) => ({
    id: model.id, label: model.label, maxOutput: model.max_output, priceCents: model.price_cents ?? pricePerStory(),
  }));
  return {
    ...(user.userId ? account(user.userId) : { remaining: remaining(user), balanceCents: 0, storyPriceCents: pricePerStory(), entitlements: [] }),
    guest: user.guest, phoneVerified: Boolean(user.userId),
    announcement: settings.announcement, paused: settings.paused || settings.envPaused,
    tiers,
  };
}

function reserve(user: Identity, id: string, started: number, chars: number, modelId: string, maxCharge: unknown, priceCents: number): Billing {
  db.prepare("UPDATE generations SET status = 'failed' WHERE status = 'running' AND started < ?").run(started - maxRun - 5000);
  return transaction(() => {
    const pending = db.prepare(`
      SELECT 1 FROM generations
      WHERE status = 'running' AND (actor = ? OR (? = 1 AND is_guest = 1 AND ip = ?)) LIMIT 1
    `).get(user.actor, Number(user.guest), user.ip);
    const recentIp = db.prepare('SELECT COUNT(*) AS n FROM generations WHERE ip = ? AND started > ?').get(user.ip, started - hour);
    const recentActor = db.prepare('SELECT COUNT(*) AS n FROM generations WHERE actor = ? AND started > ?').get(user.actor, started - day);
    if (pending || Number(recentIp?.n) >= 20 || Number(recentActor?.n) >= 50) throw new RequestError(429, 'rate_limited');
    if (!user.userId && remaining(user) <= 0) throw new RequestError(402, 'quota_exhausted');
    const billing = user.userId ? quote(user.userId, maxCharge, priceCents) : { kind: 'legacy' as const };
    db.prepare(`INSERT INTO generations(id, actor, ip, started, status, is_guest, chars_in, model_tier)
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`).run(id, user.actor, user.ip, started, Number(user.guest), chars, modelId);
    return billing;
  });
}

async function generate(req: IncomingMessage, res: ServerResponse, user: Identity) {
  const { text, length, maxCharge, tierId } = await readBody(req);
  if (typeof text !== 'string' || typeof length !== 'string' || !Object.hasOwn(goals, length)) {
    throw new RequestError(400, 'invalid_input');
  }
  const chars = countWords(text);
  if (chars < 1 || chars > 8000) throw new RequestError(400, 'invalid_input');
  const settings = modelSettings();
  const models = availableModels();
  if (settings.paused || settings.envPaused || !models.length) throw new RequestError(503, 'unavailable');
  const candidates = user.guest ? models.slice(0, 1) : models;
  const model = tierId === undefined ? candidates[0] : candidates.find((candidate) => candidate.id === tierId);
  if (!model) throw new RequestError(409, 'tier_unavailable');
  const config = modelConfig(model);
  if (!config) throw new RequestError(503, 'unavailable');
  const goal = goals[length as keyof typeof goals];
  if (goal > model.max_output) throw new RequestError(400, 'length_unavailable');
  const id = randomUUID();
  const started = Date.now();
  const controller = new AbortController();
  const billing = reserve(user, id, started, chars, model.id, maxCharge, model.price_cents ?? pricePerStory());
  active.set(id, { actor: user.actor, controller });
  const deadline = new Error('Generation deadline');
  const timeout = setTimeout(() => controller.abort(deadline), maxRun);
  const disconnect = () => controller.abort();
  res.once('close', disconnect);

  const send = (message: object) => {
    if (!res.destroyed) res.write(`data: ${JSON.stringify(message)}\n\n`);
  };

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let tokensIn = 0;
  let tokensOut = 0;
  let missingUsage = false;
  const cost = () => missingUsage || !(tokensIn || tokensOut) || !(model.input_cost || model.output_cost) ? null
    : (tokensIn * model.input_cost + tokensOut * model.output_cost) / 10_000;
  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    send({ type: 'meta', id });
    heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15_000);
    const result = await generateStory(text, goal, config, controller.signal, send, model.max_output, (usage) => {
      missingUsage ||= usage?.prompt_tokens === undefined || usage?.completion_tokens === undefined;
      tokensIn += usage?.prompt_tokens ?? 0;
      tokensOut += usage?.completion_tokens ?? 0;
    });
    controller.signal.throwIfAborted();
    const chargedCents = result.charged && billing.kind === 'wallet' ? billing.cents : 0;
    transaction(() => {
      if (user.userId && db.prepare('SELECT status FROM users WHERE id = ?').get(user.userId)?.status !== 'active') {
        throw new Error('Account blocked');
      }
      const update = db.prepare(`
        UPDATE generations SET status = ?, charged = ?, chars_out = ?, tokens_in = ?, tokens_out = ?,
          latency_ms = ?, gate_json = ?, cost_cents = ?, charge_cents = ? WHERE id = ? AND status = 'running'
      `).run(result.charged ? 'success' : 'degraded', Number(result.charged), countWords(result.text),
        tokensIn, tokensOut, Date.now() - started, JSON.stringify(result.gates.map((gate) => gate.gates)), cost(), chargedCents, id);
      if (!update.changes) throw new Error('Generation reservation expired');
      if (result.charged) charge(billing);
    });
    send({ type: 'done', text: result.text, charged: result.charged, chargedCents, account: readerAccount(user), remaining: remaining(user) });
  } catch (error) {
    const timeout = controller.signal.reason === deadline || (error instanceof LLMError && error.status === 408);
    const cancelled = controller.signal.aborted && !timeout;
    const upstreamStatus = error instanceof LLMError ? error.status : undefined;
    const analysisFailed = error instanceof StoryAnalysisError;
    const failure = timeout ? 'timeout'
      : cancelled ? 'cancelled' : upstreamStatus === 429 ? 'upstream_rate'
      : upstreamStatus === 401 || upstreamStatus === 403 ? 'upstream_auth'
      : upstreamStatus !== undefined ? 'upstream_failed' : analysisFailed ? 'analysis_failed' : 'failed';
    db.prepare(`UPDATE generations SET status = ?, latency_ms = ?, tokens_in = ?, tokens_out = ?, failure_code = ?
      WHERE id = ? AND status = 'running'`)
      .run(cancelled ? 'cancelled' : 'failed', Date.now() - started, tokensIn, tokensOut, failure, id);
    send({ type: 'error', code: cancelled ? 'cancelled' : analysisFailed ? 'analysis_failed' : 'unavailable' });
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    active.delete(id);
    res.off('close', disconnect);
    res.end();
  }
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, path: string) {
  try {
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'not_found');
    const url = new URL(req.url ?? path, 'http://localhost');
    if (path.startsWith('/api/admin/')) return await handleAdmin(req, res, path, url);
    if (req.method === 'POST' && path === '/api/payments/stripe/webhook') {
      await handleStripeEvent(req);
      return json(res, 200, { received: true });
    }
    if (req.method === 'GET' && path === '/api/plans') {
      return json(res, 200, { plans: plans(), storyPriceCents: pricePerStory(), paymentsEnabled: paymentsEnabled() });
    }
    if (req.method === 'POST' && path === '/api/auth/logout') {
      const bearer = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
      if (bearer) db.prepare('DELETE FROM sessions WHERE hash = ?').run(hash(bearer));
      return json(res, 200, { ok: true });
    }
    const user = identify(req, res);
    if (req.method === 'GET' && path === '/api/me') return json(res, 200, readerAccount(user));
    if (req.method === 'POST' && path === '/api/auth/request-code') {
      await requestCode((await readBody(req)).phone, user.ip);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/auth/verify') {
      const { code, phone } = await readBody(req);
      const session = verifyPhone(phone, code, user.ip, !user.guest && !user.userId
        ? { actor: user.actor, remaining: remaining(user) } : undefined);
      return json(res, 200, { session });
    }
    if (path === '/api/orders' && (req.method === 'GET' || req.method === 'POST')) {
      if (!user.userId) throw new RequestError(401, 'phone_required');
      if (req.method === 'GET') return json(res, 200, { orders: listOrders(user.userId), account: readerAccount(user) });
      if (!paymentsEnabled()) throw new RequestError(503, 'payment_unavailable');
      rate('orders', user.userId, hour, 30);
      const order = createOrder(user.userId, await readBody(req));
      const checkout = await checkoutOrder(order);
      return json(res, 201, { ...checkout, order: publicOrder(checkout.order), account: readerAccount(user) });
    }
    const payment = /^\/api\/orders\/([0-9a-f-]{36})(\/checkout)?$/.exec(path);
    if (payment && (req.method === 'GET' && !payment[2] || req.method === 'POST' && payment[2])) {
      if (!user.userId) throw new RequestError(401, 'phone_required');
      rate('orders-status', user.userId, hour, 120);
      const order = readOrder(payment[1]);
      if (!order || order.user_id !== user.userId) throw new RequestError(404, 'not_found');
      if (req.method === 'POST') await readBody(req);
      const result = req.method === 'POST' ? await checkoutOrder(order)
        : { order: await statusForOrder(order), checkoutUrl: null };
      return json(res, 200, { ...result, order: publicOrder(result.order), account: readerAccount(user) });
    }
    if (req.method === 'POST' && path === '/api/ocr') return await extractRecording(req, res, user.ip);
    if (req.method === 'POST' && path === '/api/generate') return await generate(req, res, user);
    const match = /^\/api\/generate\/([a-f0-9-]+)\/cancel$/.exec(path);
    if (req.method === 'POST' && match) {
      const run = active.get(match[1]);
      if (run?.actor !== user.actor) throw new RequestError(404, 'not_found');
      run.controller.abort();
      return json(res, 200, { cancelled: true });
    }
    return json(res, 404, { code: 'not_found' });
  } catch (error) {
    if (!res.headersSent && !res.destroyed) {
      if (error instanceof RequestError) return json(res, error.status, { code: error.code });
      return json(res, 500, { code: 'unavailable' });
    }
    res.end();
  }
}
