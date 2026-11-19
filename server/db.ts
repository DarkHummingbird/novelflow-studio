import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const databasePath = process.env.NF_DB_PATH || 'data/novelflow.sqlite';
if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
export const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS sessions (
    hash TEXT PRIMARY KEY, quota INTEGER NOT NULL, expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS generations (
    id TEXT PRIMARY KEY, actor TEXT NOT NULL, ip TEXT NOT NULL,
    started INTEGER NOT NULL, status TEXT NOT NULL, charged INTEGER NOT NULL DEFAULT 0,
    is_guest INTEGER NOT NULL, chars_in INTEGER NOT NULL, chars_out INTEGER,
    tokens_in INTEGER, tokens_out INTEGER, latency_ms INTEGER, gate_json TEXT
  );
  CREATE INDEX IF NOT EXISTS gen_actor_time ON generations(actor, started);
  CREATE INDEX IF NOT EXISTS gen_ip_time ON generations(ip, started);
`);

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('hex');
export const hour = 3_600_000;
export const day = hour * 24;
export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, phone TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'active',
    wallet_cents INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS login_codes (
    phone TEXT PRIMARY KEY, hash TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS rate_windows (
    scope TEXT NOT NULL, subject TEXT NOT NULL, bucket INTEGER NOT NULL, attempts INTEGER NOT NULL,
    PRIMARY KEY (scope, subject)
  );
  CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL,
    period_days INTEGER NOT NULL, quota INTEGER NOT NULL, overage_cents INTEGER NOT NULL,
    wallet_cents INTEGER NOT NULL, active INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS entitlements (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
    expires INTEGER, quota_left INTEGER NOT NULL, overage_cents INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS entitlements_user ON entitlements(user_id, expires);
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), sku TEXT NOT NULL,
    name TEXT NOT NULL, amount_cents INTEGER NOT NULL, status TEXT NOT NULL,
    created INTEGER NOT NULL, fulfilled INTEGER
  );
  CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id, created);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS admin_sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS model_vendor_keys (
    vendor TEXT PRIMARY KEY, encrypted_key TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, provider TEXT NOT NULL, endpoint TEXT NOT NULL,
    model TEXT NOT NULL, max_tokens INTEGER NOT NULL, temperature REAL NOT NULL,
    active INTEGER NOT NULL, encrypted_key TEXT, input_cost REAL NOT NULL, output_cost REAL NOT NULL,
    max_output INTEGER NOT NULL DEFAULT 9000
  );
`);

// Preserve P0 sessions and the historical quota ledger.
function addColumn(table: string, column: string, type: string) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
addColumn('sessions', 'user_id', 'TEXT REFERENCES users(id)');
addColumn('generations', 'cost_cents', 'REAL');
addColumn('generations', 'charge_cents', 'INTEGER NOT NULL DEFAULT 0');
addColumn('generations', 'model_tier', 'TEXT');
addColumn('generations', 'failure_code', 'TEXT');
addColumn('models', 'vendor', 'TEXT');
addColumn('models', 'price_cents', 'INTEGER');
addColumn('plans', 'kind', 'TEXT');
addColumn('orders', 'kind', 'TEXT');
addColumn('orders', 'period_days', 'INTEGER NOT NULL DEFAULT 0');
addColumn('orders', 'quota', 'INTEGER NOT NULL DEFAULT 0');
addColumn('orders', 'stripe_session', 'TEXT');
addColumn('orders', 'stripe_intent', 'TEXT');
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS orders_stripe_session ON orders(stripe_session);
  CREATE UNIQUE INDEX IF NOT EXISTS orders_stripe_intent ON orders(stripe_intent);
  UPDATE plans SET kind = 'subscription'
    WHERE kind IS NULL AND period_days > 0 AND quota > 0 AND wallet_cents = 0;
  UPDATE plans SET kind = 'recharge', period_days = 0
    WHERE kind IS NULL AND quota = 0 AND wallet_cents = price_cents AND price_cents > 0;
`);


export function getSetting<T>(key: string, fallback: T): T {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(String(row.value_json)) as T : fallback;
}

export function setSetting(key: string, value: unknown) {
  db.prepare(`INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`)
    .run(key, JSON.stringify(value));
}
