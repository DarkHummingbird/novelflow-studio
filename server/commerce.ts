import { randomUUID } from 'node:crypto';
import { db, day, getSetting, setSetting, transaction } from './db';
import { field, int, RequestError } from './http';

export type ProductKind = 'subscription' | 'recharge';
interface Product {
  id: string;
  kind: ProductKind;
  name: string;
  price_cents: number;
  period_days: number;
  quota: number;
  active: number;
}

export interface PaymentOrder {
  id: string;
  user_id: string;
  sku: string;
  kind: ProductKind;
  name: string;
  amount_cents: number;
  period_days: number;
  quota: number;
  status: 'pending' | 'fulfilled' | 'closed';
  created: number;
  fulfilled: number | null;
  stripe_session: string | null;
  stripe_intent: string | null;
}

export function plans(all = false) {
  return db.prepare(`SELECT id, kind, name, price_cents, period_days, quota, active FROM plans
    WHERE kind IN ('subscription','recharge') ${all ? '' : 'AND active = 1'} ORDER BY price_cents, id`).all() as unknown as Product[];
}

export function savePlan(body: Record<string, unknown>) {
  const id = field(body.id, 56);
  const kind = body.kind;
  if (!/^[a-z\d][a-z\d-]*$/.test(id) || (kind !== 'subscription' && kind !== 'recharge') ||
      typeof body.active !== 'boolean') throw new RequestError(400, 'invalid_input');
  const name = field(body.name, 60);
  const price = int(body.price_cents, 1, 10_000_000);
  const days = kind === 'subscription' ? int(body.period_days, 1, 365) : 0;
  const quota = kind === 'subscription' ? int(body.quota, 1, 10_000) : 0;
  db.prepare(`INSERT INTO plans(id, name, price_cents, period_days, quota, overage_cents, wallet_cents, active, kind)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, price_cents = excluded.price_cents,
    period_days = excluded.period_days, quota = excluded.quota, overage_cents = 0,
    wallet_cents = excluded.wallet_cents, active = excluded.active, kind = excluded.kind`)
    .run(id, name, price, days, quota, kind === 'recharge' ? price : 0, Number(body.active), kind);
}

export function pricePerStory() {
  return getSetting('story_price_cents', 0);
}

export function saveStoryPrice(input: unknown) {
  setSetting('story_price_cents', int(input, 1, 100_000));
}

export function listOrders(userId?: string) {
  const query = `SELECT o.id, o.sku, o.kind, o.name, o.amount_cents, o.status, o.created, o.fulfilled
    ${userId ? '' : ', u.phone'} FROM orders o JOIN users u ON u.id = o.user_id`;
  const historical = "(o.kind IS NOT NULL OR o.status = 'fulfilled')";
  return userId
    ? db.prepare(query + ` WHERE o.user_id = ? AND ${historical} ORDER BY o.created DESC LIMIT 100`).all(userId)
    : db.prepare(query + ` WHERE ${historical} ORDER BY o.created DESC LIMIT 200`).all();
}

export function readOrder(id: string) {
  return db.prepare('SELECT * FROM orders WHERE id = ? AND kind IS NOT NULL').get(id) as unknown as PaymentOrder | undefined;
}

export function publicOrder(order: PaymentOrder) {
  const { id, sku, kind, name, amount_cents, status, created, fulfilled } = order;
  return { id, sku, kind, name, amount_cents, status, created, fulfilled };
}

export function createOrder(userId: string, selection: Record<string, unknown>) {
  const { sku, amountCents, periodDays, quota, kind } = selection;
  return transaction(() => {
    const product = typeof sku === 'string' && plans().find((candidate) => candidate.id === sku);
    if (!product) throw new RequestError(404, 'plan_unavailable');
    if (product.kind !== kind || product.price_cents !== amountCents ||
        (product.kind === 'subscription' && (product.period_days !== periodDays || product.quota !== quota))) {
      throw new RequestError(409, 'price_changed');
    }
    const pending = db.prepare(`SELECT id FROM orders WHERE user_id = ? AND sku = ? AND kind = ?
      AND status = 'pending' AND amount_cents = ? AND period_days = ? AND quota = ? LIMIT 1`)
      .get(userId, product.id, product.kind, product.price_cents, product.period_days, product.quota);
    if (pending) return readOrder(String(pending.id))!;
    const id = randomUUID();
    db.prepare(`INSERT INTO orders(id, user_id, sku, name, amount_cents, status, created, kind, period_days, quota)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
      .run(id, userId, product.id, product.name, product.price_cents, Date.now(), product.kind, product.period_days, product.quota);
    return readOrder(id)!;
  });
}

export function fulfillPayment(order: PaymentOrder, sessionId: string, intent: string) {
  return transaction(() => {
    const current = readOrder(order.id);
    if (!current || (current.stripe_session && current.stripe_session !== sessionId) ||
        (current.stripe_intent && current.stripe_intent !== intent)) throw new RequestError(409, 'payment_mismatch');
    if (current.status === 'fulfilled') return current;

    const now = Date.now();
    db.prepare(`UPDATE orders SET status = 'fulfilled', fulfilled = ?, stripe_session = ?, stripe_intent = ? WHERE id = ?`)
      .run(now, sessionId, intent, current.id);
    if (current.kind === 'subscription') {
      db.prepare('INSERT INTO entitlements(id, user_id, name, expires, quota_left) VALUES (?, ?, ?, ?, ?)')
        .run(current.id, current.user_id, current.name, now + current.period_days * day, current.quota);
    } else {
      db.prepare('UPDATE users SET wallet_cents = wallet_cents + ? WHERE id = ?').run(current.amount_cents, current.user_id);
    }
    return readOrder(current.id)!;
  });
}

export function activeEntitlements(userId: string) {
  return db.prepare(`SELECT id, name, expires, quota_left FROM entitlements
    WHERE user_id = ? AND (expires IS NULL OR expires > ?) ORDER BY expires IS NULL, expires, rowid`).all(userId, Date.now());
}

export function account(userId: string) {
  const entitlements = activeEntitlements(userId);
  const remaining = entitlements.reduce((sum, row) => sum + Number(row.quota_left), 0);
  const balanceCents = Number(db.prepare('SELECT wallet_cents FROM users WHERE id = ?').get(userId)?.wallet_cents ?? 0);
  return { remaining, balanceCents, storyPriceCents: pricePerStory(), entitlements };
}

export type Billing = { kind: 'legacy' } | { kind: 'quota'; id: string } | { kind: 'wallet'; userId: string; cents: number };

export function quote(userId: string, maxCharge: unknown, storyPriceCents: number): Billing {
  const bucket = activeEntitlements(userId).find((row) => Number(row.quota_left) > 0);
  if (bucket) return { kind: 'quota', id: String(bucket.id) };
  const { balanceCents } = account(userId);
  if (!storyPriceCents || balanceCents < storyPriceCents) throw new RequestError(402, 'quota_exhausted');
  if (typeof maxCharge !== 'number' || !Number.isSafeInteger(maxCharge) || maxCharge !== storyPriceCents) {
    throw new RequestError(402, 'confirm_price');
  }
  return { kind: 'wallet', userId, cents: storyPriceCents };
}

export function charge(billing: Billing) {
  if (billing.kind === 'legacy') return;
  const update = billing.kind === 'quota'
    ? db.prepare('UPDATE entitlements SET quota_left = quota_left - 1 WHERE id = ? AND quota_left > 0').run(billing.id)
    : db.prepare('UPDATE users SET wallet_cents = wallet_cents - ? WHERE id = ? AND wallet_cents >= ?')
        .run(billing.cents, billing.userId, billing.cents);
  if (!update.changes) throw new Error('Billing reservation lost');
}

export function adjustQuota(userId: string, amount: number) {
  if (!amount) return;
  if (amount > 0) {
    db.prepare('INSERT INTO entitlements(id, user_id, name, quota_left) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), userId, '人工额度调整', amount);
    return;
  }
  let toRemove = -amount;
  for (const row of activeEntitlements(userId)) {
    const removed = Math.min(toRemove, Number(row.quota_left));
    db.prepare('UPDATE entitlements SET quota_left = quota_left - ? WHERE id = ?').run(removed, row.id);
    toRemove -= removed;
    if (!toRemove) return;
  }
  throw new RequestError(409, 'insufficient_quota');
}
