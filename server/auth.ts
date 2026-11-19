import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { db, day, hash, hour, token, transaction } from './db';
import { rate, RequestError } from './http';

const codeKey = randomBytes(32);
const digest = (phone: string, code: string) => createHmac('sha256', codeKey).update(phone + ':' + code).digest('hex');

function normalizePhone(input: unknown) {
  const value = typeof input === 'string' ? input.trim() : '';
  const phone = /^1[3-9]\d{9}$/.test(value) ? '+86' + value : value;
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new RequestError(400, 'invalid_phone');
  return phone;
}

async function deliver(phone: string, code: string) {
  const inbox = process.env.NF_SMS_DEV_INBOX;
  if (inbox) {
    await appendFile(inbox, JSON.stringify({ phone, code }) + '\n', { mode: 0o600 });
    return;
  }
  const url = process.env.NF_SMS_WEBHOOK;
  const secret = process.env.NF_SMS_WEBHOOK_TOKEN;
  if (!url || !secret || new URL(url).protocol !== 'https:') throw new Error('SMS gateway unavailable');
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code, expiresIn: 300 }),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error('SMS delivery failed');
}

export async function requestCode(input: unknown, ip: string) {
  const phone = normalizePhone(input);
  rate('sms-ip', ip, hour, 20);
  rate('sms-phone-minute', hash(phone), 60_000, 1);
  rate('sms-phone-hour', hash(phone), hour, 5);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const codeHash = digest(phone, code);
  db.prepare(`INSERT INTO login_codes VALUES (?, ?, ?, 0) ON CONFLICT(phone) DO UPDATE SET
    hash = excluded.hash, expires = excluded.expires, tries = 0`).run(phone, codeHash, Date.now() + 300_000);
  try {
    await deliver(phone, code);
  } catch {
    db.prepare('DELETE FROM login_codes WHERE phone = ? AND hash = ?').run(phone, codeHash);
    throw new RequestError(503, 'sms_unavailable');
  }
}

export function verifyPhone(input: unknown, code: unknown, ip: string, legacy?: { actor: string; remaining: number }) {
  const phone = normalizePhone(input);
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new RequestError(400, 'invalid_code');
  rate('verify-ip', ip, hour, 40);
  const row = db.prepare(`UPDATE login_codes SET tries = tries + 1
    WHERE phone = ? AND expires > ? AND tries < 5 RETURNING hash`).get(phone, Date.now());
  const expected = digest(phone, code);
  if (!row || !timingSafeEqual(Buffer.from(String(row.hash)), Buffer.from(expected))) {
    throw new RequestError(400, 'invalid_code');
  }
  const session = token();
  transaction(() => {
    db.prepare('DELETE FROM login_codes WHERE phone = ?').run(phone);
    db.prepare('INSERT OR IGNORE INTO users(id, phone, created) VALUES (?, ?, ?)').run(randomUUID(), phone, Date.now());
    const user = db.prepare('SELECT id, status FROM users WHERE phone = ?').get(phone);
    if (user?.status !== 'active') throw new RequestError(403, 'account_blocked');
    const id = String(user.id);
    if (legacy) {
      const open = db.prepare("SELECT 1 FROM generations WHERE actor = ? AND status = 'running' AND started > ?")
        .get(legacy.actor, Date.now() - 16 * 60_000);
      if (open) throw new RequestError(409, 'generation_running');
      const removed = db.prepare('DELETE FROM sessions WHERE hash = ? AND user_id IS NULL').run(legacy.actor);
      if (removed.changes && legacy.remaining > 0) {
        db.prepare('INSERT INTO entitlements(id, user_id, name, quota_left) VALUES (?, ?, ?, ?)')
          .run(randomUUID(), id, '内测额度', legacy.remaining);
      }
    }
    db.prepare('INSERT INTO sessions(hash, quota, expires, user_id) VALUES (?, 0, ?, ?)').run(hash(session), Date.now() + 30 * day, id);
  });
  return session;
}
