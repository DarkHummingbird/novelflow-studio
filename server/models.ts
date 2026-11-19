import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { ApiConfig } from '../src/types';
import { db, getSetting } from './db';
import { isModelVendor } from '../src/lib/model-vendors';
import type { CatalogModel, ModelVendor } from '../src/lib/model-vendors';
import { field, int, RequestError } from './http';

type Model = {
  id: string; label: string; provider: ApiConfig['provider']; endpoint: string; model: string;
  max_tokens: number; temperature: number; active: number; encrypted_key: string | null;
  vendor: ModelVendor | null; price_cents: number | null;
  input_cost: number; output_cost: number; max_output: number;
};

const openai = 'https://api.openai.com';
const gemini = 'https://generativelanguage.googleapis.com';
const deepseek = 'https://api.deepseek.com';
const vendorEndpoints = { deepseek, gemini: gemini + '/v1beta' } as const;

function storedVendorKey(vendor: ModelVendor) {
  return db.prepare('SELECT encrypted_key FROM model_vendor_keys WHERE vendor = ?').get(vendor)?.encrypted_key;
}

function vendorEnvironmentKey(vendor: ModelVendor) {
  const model = envModel();
  const expectedProtocol = vendor === 'gemini' ? 'gemini' : 'openai';
  return model.provider === expectedProtocol && URL.parse(model.endpoint)?.origin === new URL(vendorEndpoints[vendor]).origin
    ? process.env.NF_PROVIDER_KEY?.trim() : undefined;
}

function vendorKey(vendor: ModelVendor) {
  const value = storedVendorKey(vendor);
  return typeof value === 'string' ? unseal(value, 'vendor:' + vendor) : vendorEnvironmentKey(vendor);
}

export function listModelVendors() {
  return Object.fromEntries((['deepseek', 'gemini'] as const).map((vendor) => [
    vendor, { configured: vendorKeyConfigured(vendor) },
  ]));
}

function vendorKeyConfigured(vendor: ModelVendor) {
  return Boolean(storedVendorKey(vendor) || vendorEnvironmentKey(vendor));
}

export function saveVendorKey(body: Record<string, unknown>) {
  if (!isModelVendor(body.vendor)) throw new RequestError(400, 'invalid_input');
  const key = field(body.apiKey, 1024);
  if (/\s/.test(key)) throw new RequestError(400, 'invalid_input');
  db.prepare(`INSERT INTO model_vendor_keys VALUES (?, ?) ON CONFLICT(vendor)
    DO UPDATE SET encrypted_key = excluded.encrypted_key`).run(body.vendor, seal(key, 'vendor:' + body.vendor));
}

async function fetchCatalogPage(vendor: ModelVendor, key: string, pageToken = '') {
  const url = new URL(vendorEndpoints[vendor] + '/models');
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  if (vendor === 'gemini') url.searchParams.set('pageSize', '100');
  const headers: Record<string, string> = vendor === 'gemini' ? { 'x-goog-api-key': key } : { Authorization: 'Bearer ' + key };
  let response: Response;
  try { response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(8_000) }); }
  catch { throw new RequestError(502, 'vendor_unreachable'); }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 400 || response.status === 401 || response.status === 403) throw new RequestError(422, 'vendor_key_invalid');
    if (response.status === 429) throw new RequestError(429, 'vendor_rate_limited');
    throw new RequestError(502, 'vendor_unreachable');
  }
  return await response.json().catch(() => { throw new RequestError(502, 'vendor_unreachable'); });
}

function acceptsModel(vendor: ModelVendor, id: unknown): id is string {
  if (typeof id !== 'string' || id.length > 100 || !/^[a-z0-9][a-z0-9._-]+$/i.test(id)) return false;
  return vendor === 'deepseek' ? id.startsWith('deepseek-')
    : id.startsWith('gemini-') && !/(?:^|-)(?:embedding|tts|live|image|robotics|audio|computer-use)(?:-|$)/.test(id);
}

export async function fetchVendorModels(vendor: unknown): Promise<CatalogModel[]> {
  if (!isModelVendor(vendor)) throw new RequestError(400, 'invalid_input');
  const key = vendorKey(vendor);
  if (!key) throw new RequestError(400, 'model_unconfigured');
  const results = new Map<string, CatalogModel>();
  let next = '';
  for (let page = 0; page < 4; page++) {
    const data = await fetchCatalogPage(vendor, key, next);
    if (vendor === 'deepseek') {
      if (!Array.isArray(data?.data)) throw new RequestError(502, 'vendor_unreachable');
      for (const row of data.data) {
        if (acceptsModel(vendor, row?.id) && (!Array.isArray(row.output_modalities) || row.output_modalities.includes('text'))) {
          results.set(row.id, { id: row.id, label: typeof row.name === 'string' ? row.name.slice(0, 100) : row.id });
        }
      }
      break;
    }
    if (!Array.isArray(data?.models)) throw new RequestError(502, 'vendor_unreachable');
    for (const row of data.models) {
      const id = typeof row?.name === 'string' ? row.name.replace(/^models\//, '') : undefined;
      if (acceptsModel(vendor, id) && Array.isArray(row.supportedGenerationMethods) &&
          row.supportedGenerationMethods.includes('generateContent')) {
        results.set(id, { id, label: typeof row.displayName === 'string' ? row.displayName.slice(0, 100) : id });
      }
    }
    next = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
    if (!next) break;
  }
  return [...results.values()];
}

export function modelSettings() {
  return {
    defaultModel: getSetting('default_model', 'env'),
    paused: getSetting('paused', false),
    guestFree: getSetting('guest_free', true),
    announcement: getSetting('announcement', ''),
    envPaused: process.env.NF_GENERATION_PAUSED === '1',
  };
}

function secret() {
  const value = process.env.NF_SETTINGS_SECRET ?? '';
  if (!/^[a-f\d]{64}$/i.test(value)) throw new RequestError(503, 'settings_secret_required');
  return Buffer.from(value, 'hex');
}

function seal(key: string, id: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret(), iv);
  cipher.setAAD(Buffer.from(id));
  return [iv, Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]), cipher.getAuthTag()]
    .map((part) => part.toString('base64')).join('.');
}

function unseal(pack: string, id: string) {
  const [iv, encrypted, tag] = pack.split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', secret(), iv);
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function byId(id: string) {
  return db.prepare('SELECT * FROM models WHERE id = ?').get(id) as unknown as Model | undefined;
}

function envModel(): Model {
  const provider = process.env.NF_PROVIDER === 'gemini' ? 'gemini' : 'openai';
  return {
    id: 'env', label: '环境变量默认档', provider,
    endpoint: process.env.NF_UPSTREAM?.trim() || (provider === 'gemini' ? gemini + '/v1beta' : deepseek + '/v1'),
    vendor: null, price_cents: null,
    model: process.env.NF_MODEL?.trim() || '', max_tokens: Number(process.env.NF_MAX_TOKENS || 8192),
    temperature: 0.7, active: 1, encrypted_key: null, max_output: 9000,
    input_cost: Math.max(0, Number(process.env.NF_INPUT_COST_PER_MILLION) || 0),
    output_cost: Math.max(0, Number(process.env.NF_OUTPUT_COST_PER_MILLION) || 0),
  };
}

export function findModel(id: string) {
  return id === 'env' ? envModel() : byId(id);
}

function allModels() {
  return [envModel(), ...db.prepare('SELECT * FROM models ORDER BY rowid').all() as unknown as Model[]];
}

function inheritedEnvKey(model: Model) {
  const env = envModel();
  const origin = URL.parse(model.endpoint)?.origin;
  return (model.id === 'env' || (origin && origin === URL.parse(env.endpoint)?.origin && model.provider === env.provider))
    ? process.env.NF_PROVIDER_KEY?.trim() : undefined;
}

function modelKeyConfigured(model: Model) {
  return Boolean(model.vendor ? vendorKeyConfigured(model.vendor) : model.encrypted_key || inheritedEnvKey(model));
}

export function listModels() {
  return allModels().map((row) => ({
    id: row.id, label: row.label, vendor: row.vendor, model: row.model, active: row.active,
    price_cents: row.price_cents, input_cost: row.input_cost, output_cost: row.output_cost, key_configured: modelKeyConfigured(row),
  }));
}

export function availableModels() {
  const models = allModels().filter((model) => model.active && model.model && model.max_tokens > 0 && modelKeyConfigured(model));
  const requested = modelSettings().defaultModel;
  const first = models.find((model) => model.id === requested) ?? models[0];
  return first ? [first, ...models.filter((model) => model.id !== first.id)] : [];
}

export function modelConfig(model: Model): ApiConfig | null {
  const apiKey = model.vendor ? vendorKey(model.vendor)
    : model.encrypted_key ? unseal(model.encrypted_key, model.id) : inheritedEnvKey(model);
  if (!apiKey || !model.model || !Number.isSafeInteger(model.max_tokens) || model.max_tokens < 1) return null;
  return {
    apiKey, model: model.model, provider: model.provider, baseUrl: model.endpoint,
    maxTokens: model.max_tokens, temperature: model.temperature, persistKey: false,
    ...(model.vendor === 'deepseek' ? { deepseekThinking: 'disabled' as const } : {}),
    ...(model.vendor === 'gemini' && /^gemini-4-/.test(model.model) ? { geminiThinkingLevel: 'LOW' as const } : {}),
  };
}

function costRate(value: unknown, fallback: number) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100_000_000) {
    throw new RequestError(400, 'invalid_input');
  }
  return value;
}

export function saveManagedTier(body: Record<string, unknown>) {
  const vendor = body.vendor;
  const model = body.model;
  if (!isModelVendor(vendor) || !acceptsModel(vendor, model)) throw new RequestError(400, 'invalid_input');
  const label = field(body.label, 60);
  const price = body.priceCents == null ? null : int(body.priceCents, 1, 100_000);
  const previous = body.id === undefined ? undefined : byId(field(body.id, 56));
  if (body.id !== undefined && (!previous || !previous.vendor)) throw new RequestError(404, 'not_found');
  if (!vendorKeyConfigured(vendor)) throw new RequestError(400, 'model_unconfigured');
  const inputCost = costRate(body.inputCost, previous?.input_cost ?? 0);
  const outputCost = costRate(body.outputCost, previous?.output_cost ?? 0);
  const id = previous?.id ?? randomUUID();
  db.prepare(`INSERT INTO models(id, label, provider, endpoint, model, max_tokens, temperature, active,
    encrypted_key, input_cost, output_cost, max_output, vendor, price_cents)
    VALUES (?, ?, ?, ?, ?, 8192, ?, ?, NULL, ?, ?, 9000, ?, ?)
    ON CONFLICT(id) DO UPDATE SET label=excluded.label, provider=excluded.provider, endpoint=excluded.endpoint,
    model=excluded.model, temperature=excluded.temperature, vendor=excluded.vendor, price_cents=excluded.price_cents,
    input_cost=excluded.input_cost, output_cost=excluded.output_cost`)
    .run(id, label, vendor === 'gemini' ? 'gemini' : 'openai', vendorEndpoints[vendor],
      model, vendor === 'gemini' ? 1 : 0.7, previous?.active ?? 1, inputCost, outputCost, vendor, price);
  return id;
}

export function toggleTier(body: Record<string, unknown>) {
  const id = field(body.id, 56);
  if (typeof body.active !== 'boolean') throw new RequestError(400, 'invalid_input');
  const update = db.prepare('UPDATE models SET active = ? WHERE id = ?').run(Number(body.active), id);
  if (!update.changes) throw new RequestError(404, 'not_found');
}

export function saveModel(body: Record<string, unknown>) {
  const id = field(body.id, 56);
  if (id === 'env' || !/^[a-z\d][a-z\d-]*$/.test(id)) throw new RequestError(400, 'invalid_input');
  const label = field(body.label, 60);
  const model = field(body.model, 100);
  if (body.provider !== 'openai' && body.provider !== 'gemini') throw new RequestError(400, 'invalid_input');
  const endpoint = field(body.endpoint, 300);
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new RequestError(400, 'invalid_input'); }
  const allowed = [openai, gemini, deepseek, ...(process.env.NF_MODEL_ALLOWED_ORIGINS || '').split(',').map((origin) => origin.trim())];
  if (url.username || url.password || url.hash || url.search || url.protocol !== 'https:' || !allowed.includes(url.origin)) {
    throw new RequestError(400, 'endpoint_not_allowed');
  }
  const maxTokens = int(body.max_tokens, 128, 100_000);
  const maxOutput = int(body.max_output, 4000, 9000);
  const { temperature, input_cost: inputCost, output_cost: outputCost } = body;
  if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2 ||
      typeof inputCost !== 'number' || !Number.isFinite(inputCost) || inputCost < 0 || inputCost > 100_000_000 ||
      typeof outputCost !== 'number' || !Number.isFinite(outputCost) || outputCost < 0 || outputCost > 100_000_000 ||
      typeof body.active !== 'boolean') throw new RequestError(400, 'invalid_input');
  const previous = byId(id);
  if (previous?.vendor) throw new RequestError(400, 'invalid_input');
  const supplied = typeof body.apiKey === 'string' && body.apiKey.trim() ? field(body.apiKey, 1024) : null;
  const envOrigin = new URL(envModel().endpoint).origin;
  if (!supplied && previous?.encrypted_key && (new URL(previous.endpoint).origin !== url.origin || previous.provider !== body.provider)) {
    throw new RequestError(400, 'replacement_key_required');
  }
  const key = supplied ? seal(supplied, id) : previous?.encrypted_key ?? null;
  if (!key && process.env.NF_PROVIDER_KEY && url.origin !== envOrigin) throw new RequestError(400, 'replacement_key_required');
  db.prepare(`INSERT INTO models(id, label, provider, endpoint, model, max_tokens, temperature, active,
    encrypted_key, input_cost, output_cost, max_output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET label=excluded.label, provider=excluded.provider, endpoint=excluded.endpoint,
      model=excluded.model, max_tokens=excluded.max_tokens, temperature=excluded.temperature, active=excluded.active,
      encrypted_key=excluded.encrypted_key, input_cost=excluded.input_cost, output_cost=excluded.output_cost,
      max_output=excluded.max_output`)
    .run(id, label, body.provider, url.href, model, maxTokens, temperature, Number(body.active), key, inputCost, outputCost, maxOutput);
}
