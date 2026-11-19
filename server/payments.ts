import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { db } from './db';
import { fulfillPayment, readOrder } from './commerce';
import type { PaymentOrder } from './commerce';
import { readRawBody, RequestError } from './http';

interface StripeSession {
  id: string;
  object: string;
  mode: string;
  livemode: boolean;
  status: 'open' | 'complete' | 'expired';
  payment_status: string;
  amount_total: number | null;
  currency: string | null;
  client_reference_id: string | null;
  metadata: { app?: string; order_id?: string } | null;
  payment_intent: string | null;
  url: string | null;
}

const project = 'novelflow';
const stripeApi = 'https://api.stripe.com';
const stripeCheckout = 'https://checkout.stripe.com';

function settingUrl(input: string | undefined) {
  const url = input && URL.parse(input);
  return url && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password ? url : null;
}

function isLoopback(url: URL) {
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

function config() {
  const key = process.env.NF_STRIPE_SECRET_KEY?.trim() || '';
  const webhook = process.env.NF_STRIPE_WEBHOOK_SECRET?.trim() || '';
  const match = /^(?:sk|rk)_(test|live)_[A-Za-z0-9_]+$/.exec(key);
  const origin = settingUrl(process.env.NF_PUBLIC_ORIGIN);
  if (!match || !webhook.startsWith('whsec_') || !origin) return null;
  const live = match[1] === 'live';
  if (origin.protocol !== 'https:' && (live || !isLoopback(origin))) return null;
  const fixture = settingUrl(process.env.NF_STRIPE_TEST_ORIGIN);
  const testOrigin = !live && key === 'sk_test_novelflow_local' && fixture && isLoopback(fixture)
    ? fixture.origin : undefined;
  return { key, webhook, origin: origin.origin, live, testOrigin };
}

type Config = NonNullable<ReturnType<typeof config>>;
export const paymentsEnabled = () => Boolean(config());

function requireConfig(): Config {
  const settings = config();
  if (!settings) throw new RequestError(503, 'payment_unavailable');
  return settings;
}

async function stripe(settings: Config, path: string, body?: URLSearchParams, idempotencyKey?: string) {
  const headers = new Headers({ Authorization: 'Bearer ' + settings.key });
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
  let response: Response;
  try {
    response = await fetch((settings.testOrigin ?? stripeApi) + '/v1' + path, {
      method: body ? 'POST' : 'GET', headers, body, signal: AbortSignal.timeout(12_000), redirect: 'error',
    });
  } catch {
    throw new RequestError(503, 'payment_unavailable');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new RequestError(503, 'payment_unavailable');
  }
  return await response.json().catch(() => { throw new RequestError(503, 'payment_unavailable'); }) as StripeSession;
}

function validateSession(settings: Config, session: StripeSession, order: PaymentOrder) {
  if (session?.object !== 'checkout.session' || session.mode !== 'payment' || session.livemode !== settings.live ||
      typeof session.id !== 'string' || !/^cs_[A-Za-z0-9_]{1,200}$/.test(session.id) ||
      session.client_reference_id !== order.id || session.metadata?.app !== project ||
      session.metadata.order_id !== order.id || session.amount_total !== order.amount_cents || session.currency !== 'cny' ||
      (order.stripe_session && order.stripe_session !== session.id)) {
    throw new RequestError(409, 'payment_mismatch');
  }
}

function applySession(settings: Config, session: StripeSession, order: PaymentOrder, failed = false) {
  validateSession(settings, session, order);
  if (session.status === 'complete' && session.payment_status === 'paid') {
    if (typeof session.payment_intent !== 'string' || !/^pi_[A-Za-z0-9_]{1,200}$/.test(session.payment_intent)) {
      throw new RequestError(409, 'payment_mismatch');
    }
    return fulfillPayment(order, session.id, session.payment_intent);
  }
  if (session.status === 'expired' || failed) {
    db.prepare(`UPDATE orders SET status = 'closed', stripe_session = ? WHERE id = ? AND status = 'pending'
      AND (stripe_session IS NULL OR stripe_session = ?)`).run(session.id, order.id, session.id);
  } else {
    db.prepare('UPDATE orders SET stripe_session = ? WHERE id = ? AND stripe_session IS NULL')
      .run(session.id, order.id);
  }
  return readOrder(order.id)!;
}

export async function statusForOrder(order: PaymentOrder) {
  if (order.status !== 'pending' || !order.stripe_session) return order;
  const settings = requireConfig();
  const session = await stripe(settings, '/checkout/sessions/' + encodeURIComponent(order.stripe_session));
  return applySession(settings, session, order);
}

export async function checkoutOrder(order: PaymentOrder) {
  const settings = requireConfig();
  if (order.status !== 'pending') return { order, checkoutUrl: null };
  const returnUrl = new URL('/', settings.origin);
  returnUrl.searchParams.set('payment', order.id);
  const cancelUrl = new URL(returnUrl);
  cancelUrl.searchParams.set('cancelled', '1');
  const body = new URLSearchParams({
    mode: 'payment',
    success_url: returnUrl.href,
    cancel_url: cancelUrl.href,
    client_reference_id: order.id,
    'metadata[app]': project,
    'metadata[order_id]': order.id,
    'adaptive_pricing[enabled]': 'false',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'cny',
    'line_items[0][price_data][unit_amount]': String(order.amount_cents),
    'line_items[0][price_data][product_data][name]': order.name,
    'line_items[0][price_data][product_data][description]': order.kind === 'subscription'
      ? `${order.period_days} 天有效 · 含 ${order.quota} 篇 · 本次一次性购买`
      : '等额充入续章工坊账户余额',
  });
  const session = order.stripe_session
    ? await stripe(settings, '/checkout/sessions/' + encodeURIComponent(order.stripe_session))
    : await stripe(settings, '/checkout/sessions', body, 'novelflow-order-' + order.id);
  const updated = applySession(settings, session, order);
  if (updated.status !== 'pending' || session.status !== 'open') return { order: updated, checkoutUrl: null };
  const url = session.url && URL.parse(session.url);
  if (!url || url.username || url.password ||
      (url.origin !== stripeCheckout && url.origin !== settings.testOrigin)) throw new RequestError(503, 'payment_unavailable');
  return { order: updated, checkoutUrl: url.href };
}

function verified(raw: Buffer, signature: string, secret: string) {
  const fields = signature.split(',').map((item) => item.trim());
  const timestamp = fields.find((item) => /^t=\d+$/.test(item))?.slice(2);
  if (!timestamp || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', secret).update(timestamp + '.').update(raw).digest();
  return fields.some((item) => /^v1=[a-f\d]{64}$/i.test(item) &&
    timingSafeEqual(expected, Buffer.from(item.slice(3), 'hex')));
}

export async function handleStripeEvent(req: IncomingMessage) {
  const settings = requireConfig();
  const raw = await readRawBody(req, 256_000);
  const signature = req.headers['stripe-signature'];
  if (typeof signature !== 'string' || !verified(raw, signature, settings.webhook)) {
    throw new RequestError(400, 'invalid_payment_signature');
  }
  let event: { type?: string; livemode?: boolean; data?: { object?: StripeSession } };
  try { event = JSON.parse(raw.toString('utf8')); } catch { throw new RequestError(400, 'invalid_input'); }
  if (!event || event.livemode !== settings.live) throw new RequestError(400, 'payment_mismatch');
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed', 'checkout.session.expired'].includes(event.type ?? '')) return;
  const session = event.data?.object;
  if (!session || session.metadata?.app !== project || typeof session.metadata.order_id !== 'string') return;
  const order = readOrder(session.metadata.order_id);
  if (!order) return;
  applySession(settings, session, order, event.type === 'checkout.session.async_payment_failed');
}
