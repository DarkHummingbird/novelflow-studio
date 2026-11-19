import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, scryptSync } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launch, sleep } from './lib/cdp.mjs';

const temp = await mkdtemp(join(tmpdir(), 'nf-commerce-'));
const inbox = join(temp, 'sms.ndjson');
const password = 'fixture-only-admin-password';
const salt = randomBytes(16);
const phone = '13800138000';
const source = '我。雨。我。雾。我。云。我。桥。我。门。我。灯。';
let modelFailures = 0;
const upstream = createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer fixture-model-key') return res.writeHead(401).end();
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const usage = { prompt_tokens: 100, completion_tokens: 1000 };
  if (!body.stream) {
    let content = 'OK';
    if (body.response_format?.type === 'json_object') {
      const data = JSON.parse(body.messages.at(-1).content);
      if (data.各段目标非空白字数) {
        content = data.前文.includes('测试分析失败') ? 'Invalid analysis' : JSON.stringify({
          mainPlot: '人物正在寻找能够解开疑问的线索。', characters: [], conflict: '',
          currentScene: '场景停在人物即将作出回应的时刻。', pointOfView: '', style: '平实',
          openThreads: ['下一步如何回应'],
          openingBeat: '紧接末句，写出接下来的动作。',
          partPlan: data.各段目标非空白字数.map((_, index) => `推进第 ${index + 1} 项任务`),
        });
      } else {
        content = JSON.stringify({ events: ['人物将钥匙收好。'], characterChanges: [], resolvedThreads: [], openThreads: [] });
      }
    }
    return res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ choices: [{ message: { content } }], usage }));
  }
  const data = JSON.parse(body.messages.at(-1).content);
  let text = '我说：“答案就在这里。”我掀开木匣。我将钥匙握在手里。';
  for (let i = 0; text.length < data.目标非空白字数; i++) {
    text += Array.from(createHash('sha256').update(`${data.当前部分}-${i}`).digest(),
      (value) => String.fromCodePoint(0x5000 + value)).join('') + '。';
  }
  text += '风从窗口吹进来，我把钥匙放回桌面。门要从自己的这一边打开。';
  if (data.前文.includes('降级')) { modelFailures++; text = '仅一小段。'; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (data.前文.includes('等待')) await sleep(1000);
  if (!res.destroyed) {
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }], usage })}\n\ndata: [DONE]\n\n`);
  }
});

const webhookSecret = 'whsec_novelflow_local_fixture';
const checkouts = new Map();
let paymentOrigin;
const paymentGateway = createServer(async (req, res) => {
  const url = new URL(req.url, paymentOrigin);
  const send = (data) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  if (url.pathname.startsWith('/v1/') && req.headers.authorization !== 'Bearer sk_test_novelflow_local') {
    return res.writeHead(401).end();
  }
  if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const data = new URLSearchParams(raw);
    const order = data.get('client_reference_id');
    assert.equal(req.headers['idempotency-key'], 'novelflow-order-' + order);
    assert.equal(data.get('line_items[0][price_data][currency]'), 'cny');
    assert.equal(data.get('mode'), 'payment');
    const prior = [...checkouts.values()].find((item) => item.session.client_reference_id === order);
    if (prior) return send(prior.session);
    const id = 'cs_test_' + randomBytes(8).toString('hex');
    const session = { id, object: 'checkout.session', status: 'open', payment_status: 'unpaid', payment_intent: null,
      mode: 'payment', livemode: false, client_reference_id: order,
      metadata: { app: data.get('metadata[app]'), order_id: data.get('metadata[order_id]') },
      amount_total: Number(data.get('line_items[0][price_data][unit_amount]')), currency: 'cny',
      url: paymentOrigin + '/checkout-test/' + id };
    checkouts.set(id, { session, success: data.get('success_url'), cancel: data.get('cancel_url') });
    return send(session);
  }
  const path = /^\/(v1\/checkout\/sessions|checkout-test|pay-test)\/(cs_test_[a-f0-9]+)$/.exec(url.pathname);
  const checkout = path && checkouts.get(path[2]);
  if (!checkout) return res.writeHead(404).end();
  if (path[1] === 'v1/checkout/sessions') return send(checkout.session);
  if (path[1] === 'checkout-test') return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(`<!doctype html><title>测试收银台</title><h1>测试收银台</h1><form action="/pay-test/${path[2]}" method="post"><button>确认测试支付</button></form>`);
  if (req.method !== 'POST') return res.writeHead(405).end();
  markPaid(checkout.session);
  // The subscription uses a signed notification. The recharge exercises server-side status recovery.
  if (checkout.session.amount_total === 1000) assert.equal((await sendWebhook(checkout.session)).status, 200);
  return res.writeHead(303, { Location: checkout.success }).end();
});

function markPaid(session) {
  Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: 'pi_' + randomBytes(12).toString('hex') });
}

function sendWebhook(session, { signed = true, type = 'checkout.session.completed', age = 0 } = {}) {
  const payload = JSON.stringify({ type, livemode: false, data: { object: session } });
  const timestamp = Math.floor(Date.now() / 1000) - age;
  const signature = createHmac('sha256', webhookSecret).update(timestamp + '.' + payload).digest('hex');
  return fetch(base + '/api/payments/stripe/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${timestamp},v1=${signed ? signature : 'a'.repeat(64)}` },
    body: payload,
  });
}

function checkoutByOrder(order) {
  return [...checkouts.values()].find((item) => item.session.client_reference_id === order);
}

function totp() {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac('sha1', Buffer.alloc(20)).update(message).digest();
  return String((mac.readUInt32BE(mac.at(-1) & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function fill(app, selector, value) {
  assert.equal(await app.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set;
    setter.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`), true, selector);
}

let app;
let admin;
let reader;
let base;
async function startServer() {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  app = spawn(process.execPath, ['scripts/serve.mjs'], {
    env: {
      ...process.env, PORT: String(port), NF_DB_PATH: join(temp, 'state.sqlite'), NF_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, NF_SMS_DEV_INBOX: inbox,
      NF_PROVIDER: 'openai', NF_PROVIDER_KEY: 'fixture-model-key', NF_MODEL: 'fixture-model',
      NF_INPUT_COST_PER_MILLION: '2', NF_OUTPUT_COST_PER_MILLION: '3',
      NF_UPSTREAM: `http://127.0.0.1:${upstream.address().port}/v1`, NF_ADMIN_TOTP_SECRET: 'A'.repeat(32),
      NF_ADMIN_PASSWORD_HASH: salt.toString('hex') + ':' + scryptSync(password, salt, 64).toString('hex'),
      NF_SETTINGS_SECRET: 'a'.repeat(64),
      NF_STRIPE_SECRET_KEY: 'sk_test_novelflow_local', NF_STRIPE_WEBHOOK_SECRET: webhookSecret, NF_STRIPE_TEST_ORIGIN: paymentOrigin,
      NF_GENERATION_PAUSED: '0', NF_SECURE_COOKIE: '0', NF_TRUST_PROXY: '0',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  app.stdout.on('data', (chunk) => { output += chunk.toString(); });
  for (let i = 0; i < 80; i++) {
    const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
    if (match) return match[0];
    if (app.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error('Server did not start');
}

async function request(path, body, headers) {
  return fetch(base + '/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function verifyCode(number) {
  const lines = (await readFile(inbox, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  return lines.findLast((entry) => entry.phone === '+86' + number).code;
}

try {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => paymentGateway.listen(0, '127.0.0.1', resolve));
  paymentOrigin = 'http://127.0.0.1:' + paymentGateway.address().port;
  base = await startServer();
  assert.equal((await request('/admin/dashboard')).status, 401);
  assert.equal((await fetch(base + '/studio')).status, 404);
  assert.equal((await fetch(base + '/novelflow-studio-standalone.html')).status, 404);
  admin = await launch({ url: base + '/admin', port: 9345, width: 1280, height: 900 });
  await admin.waitForText('登录后台');
  const adminOtp = totp();
  await fill(admin, 'input[name=password]', password);
  await fill(admin, 'input[name=otp]', adminOtp);
  await admin.clickByText('登录后台');
  await admin.waitForText('估算模型成本');
  assert.equal((await request('/admin/login', { password, otp: adminOtp })).status, 401);
  const adminCookie = await admin.send('Network.getCookies', { urls: [base + '/api/admin/dashboard'] });
  const cookie = adminCookie.cookies.find((entry) => entry.name === 'nf_admin');
  assert.ok(cookie.httpOnly);
  const adminHeaders = { Cookie: `nf_admin=${cookie.value}` };

  await admin.clickByText('订阅与定价');
  await fill(admin, 'input[name=story_price]', '100');
  await admin.clickByText('保存单篇价格');
  await admin.waitForText('单篇价格已保存');
  await fill(admin, 'input[name=id]', 'monthly');
  await fill(admin, 'input[name=name]', '内测月卡');
  await fill(admin, 'input[name=price_cents]', '1000');
  await fill(admin, 'input[name=period_days]', '30');
  await admin.clickByText('保存商品');
  await admin.waitForText('商品已保存');
  const walletProduct = { id: 'wallet', name: '充值三元', price_cents: 300, kind: 'recharge', active: true };
  assert.equal((await request('/admin/plans', walletProduct, adminHeaders)).status, 200);
  assert.equal((await request('/admin/codes', { sku: 'monthly' }, adminHeaders)).status, 404);
  assert.equal((await request('/admin/models/test', { id: 'env' }, adminHeaders)).status, 200);
  const storedKey = 'fixture-encrypted-only';
  const model = { id: 'fast', label: '极速', provider: 'openai', endpoint: 'https://api.deepseek.com/v1',
    model: 'fixture-fast', max_tokens: 4096, max_output: 8000, temperature: 0.7, active: true,
    apiKey: storedKey, input_cost: 2, output_cost: 3 };
  assert.equal((await request('/admin/models', model, adminHeaders)).status, 200);
  assert.ok(!(await (await request('/admin/dashboard', undefined, adminHeaders)).text()).includes(storedKey));
  assert.ok(!(await readFile(join(temp, 'state.sqlite-wal'))).includes(Buffer.from(storedKey)));

  reader = await launch({ url: base, port: 9346, width: 1280, height: 900 });
  await reader.waitForText('剩 1 篇免费');
  await reader.waitForText('上传小说录屏');
  if (process.env.NF_TEST_RECORDING) {
    const root = await reader.send('DOM.getDocument');
    const input = await reader.send('DOM.querySelector', { nodeId: root.root.nodeId, selector: '[aria-label="小说录屏"]' });
    await reader.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [process.env.NF_TEST_RECORDING] });
    await reader.waitForText('识别完成', 240_000);
    const recognized = await reader.evaluate('document.querySelector("#reader-source").value');
    assert.ok(recognized.trim().length >= 30, 'Recording OCR should produce substantive text');
    if (process.env.NF_TEST_OCR_FIRST) assert.ok(recognized.includes(process.env.NF_TEST_OCR_FIRST));
    if (process.env.NF_TEST_OCR_LAST) assert.ok(recognized.includes(process.env.NF_TEST_OCR_LAST));
    assert.equal(await reader.evaluate('document.querySelector("button.reader-primary").disabled'), true);
    await reader.clickByText('确认前文');
    await reader.clickByText('开始续写');
    await reader.waitForText('下载 TXT');
    console.log('✓ 实际录屏上传、抽帧识别、核对与续写通过');
  }
  await reader.clickByText('订阅与充值');
  await reader.waitForText('30 天有效 · 含 1 篇');
  await fill(reader, '#reader-phone', phone);
  await reader.clickByText('发送验证码');
  await reader.waitForText('验证码已发送');
  const otp = await verifyCode(phone);
  await fill(reader, '#reader-otp', otp);
  await reader.evaluate('document.querySelector("dialog form").requestSubmit()');
  const signedIn = await reader.waitForText('已登录，可以购买订阅或充值');
  assert.ok(!signedIn.includes('兑换码'));
  await reader.waitForText('余额 ¥0.00');
  const bearer = await reader.evaluate('localStorage.getItem("novelflow-reader-session")');
  const user = { Authorization: 'Bearer ' + bearer };
  const getAccount = async () => (await request('/me', undefined, user)).json();
  assert.equal((await request('/auth/verify', { phone, code: otp })).status, 400);
  assert.equal((await request('/orders', { sku: 'monthly', kind: 'subscription', amountCents: 1, periodDays: 30, quota: 1 }, user)).status, 409);
  assert.equal((await request('/orders', { sku: 'monthly', kind: 'subscription', amountCents: 1000, periodDays: 7, quota: 1 }, user)).status, 409);
  assert.equal((await request('/redeem', {}, user)).status, 404);
  await reader.clickByText('购买订阅');
  await reader.waitForText('测试收银台');
  const subscription = [...checkouts.values()].find((item) => item.session.amount_total === 1000).session;
  const orderId = subscription.client_reference_id;
  assert.equal((await getAccount()).remaining, 0);
  const sameOrder = await (await request('/orders', { sku: 'monthly', kind: 'subscription', amountCents: 1000, periodDays: 30, quota: 1 }, user)).json();
  assert.equal(sameOrder.order.id, orderId);
  assert.equal((await sendWebhook({ ...subscription, amount_total: 200 })).status, 409);
  assert.equal((await sendWebhook(subscription)).status, 200);
  assert.equal((await getAccount()).remaining, 0);
  await reader.clickByText('确认测试支付');
  await reader.waitForText('订阅已生效');
  assert.equal((await sendWebhook(subscription)).status, 200);
  const subscribed = await getAccount();
  assert.equal(subscribed.remaining, 1);
  assert.equal(subscribed.balanceCents, 0);
  assert.ok(Math.abs(subscribed.entitlements[0].expires - Date.now() - 30 * 86400_000) < 60_000);

  await reader.evaluate('document.querySelector(".commerce-product-group[aria-label=余额充值] article button").click()');
  await reader.waitForText('测试收银台');
  const recharge = [...checkouts.values()].find((item) => item.session.amount_total === 300).session;
  assert.equal((await sendWebhook({ ...recharge, status: 'complete', payment_status: 'paid', payment_intent: 'pi_forged' }, { signed: false })).status, 400);
  assert.equal((await sendWebhook(recharge, { age: 360 })).status, 400);
  assert.equal((await getAccount()).balanceCents, 0);
  await reader.clickByText('确认测试支付');
  await reader.waitForText('充值已到账');
  assert.equal((await sendWebhook(recharge)).status, 200);
  await reader.waitForText('余额 ¥3.00');
  assert.equal((await getAccount()).balanceCents, 300);
  await reader.clickByText('关闭');
  await reader.waitForText('剩余 1 篇');

  const textFile = join(temp, '前文.txt');
  await writeFile(textFile, source);
  const page = await reader.send('DOM.getDocument');
  const picker = await reader.send('DOM.querySelector', { nodeId: page.root.nodeId, selector: '[aria-label="TXT 文件"]' });
  await reader.send('DOM.setFileInputFiles', { nodeId: picker.nodeId, files: [textFile] });
  await reader.waitForText('已导入 TXT');
  assert.equal(await reader.evaluate('document.querySelector("#reader-source").value'), source);
  await reader.clickByText('开始续写');
  await reader.waitForText('主线剧情');
  await reader.waitForText('剩余 0 篇');
  await reader.waitForText('下载 TXT');
  assert.equal((await request('/generate', { text: source, length: 'short' }, user)).status, 402);
  const invalidPlan = await (await request('/generate', { text: source + '测试分析失败', length: 'short', maxCharge: 100 }, user)).text();
  assert.match(invalidPlan, /"code":"analysis_failed"/);
  assert.doesNotMatch(invalidPlan, /"type":"delta"/);
  assert.equal((await (await request('/me', undefined, user)).json()).balanceCents, 300);
  await reader.clickByText('开始续写 · ¥1.00');
  await reader.waitForText('已从余额扣除 ¥1.00');
  const bad = await (await request('/generate', { text: source + '降级', length: 'short', maxCharge: 100 }, user)).text();
  assert.match(bad, /"charged":false/);
  assert.ok(modelFailures >= 2);
  const running = await request('/generate', { text: source + '等待', length: 'short', maxCharge: 100 }, user);
  const stream = running.body.getReader();
  const meta = new TextDecoder().decode((await stream.read()).value).split('\n')[0];
  const generation = JSON.parse(meta.slice(6)).id;
  assert.equal((await request('/generate', { text: source, length: 'short', maxCharge: 100 }, user)).status, 429);
  assert.equal((await request(`/generate/${generation}/cancel`, {}, user)).status, 200);
  await stream.cancel();

  const anotherPhone = '13800138001';
  assert.equal((await request('/auth/request-code', { phone: anotherPhone })).status, 200);
  const second = await (await request('/auth/verify', { phone: anotherPhone, code: await verifyCode(anotherPhone) })).json();
  const secondUser = { Authorization: 'Bearer ' + second.session };
  assert.equal((await request(`/orders/${orderId}`, undefined, secondUser)).status, 404);
  const walletResponse = await (await request('/orders', { sku: 'wallet', kind: 'recharge', amountCents: 300 }, secondUser)).json();
  const wallet = checkoutByOrder(walletResponse.order.id).session;
  markPaid(wallet);
  assert.equal((await sendWebhook(wallet)).status, 200);
  assert.equal((await request('/admin/story-price', { priceCents: 150 }, adminHeaders)).status, 200);
  assert.equal((await request('/generate', { text: source, length: 'short', maxCharge: 100 }, secondUser)).status, 402);
  assert.equal((await request('/generate', { text: source, length: 'short', maxCharge: 200 }, secondUser)).status, 402);
  const walletOnly = await (await request('/generate', { text: source, length: 'short', maxCharge: 150 }, secondUser)).text();
  assert.match(walletOnly, /"chargedCents":150/);
  const secondAccount = await (await request('/me', undefined, secondUser)).json();
  assert.equal(secondAccount.remaining, 0);
  assert.equal(secondAccount.balanceCents, 150);

  const legacyToken = randomBytes(32).toString('hex');
  const fixtureDb = new DatabaseSync(join(temp, 'state.sqlite'));
  fixtureDb.prepare('INSERT INTO sessions(hash, quota, expires) VALUES (?, 3, ?)')
    .run(createHash('sha256').update(legacyToken).digest('hex'), Date.now() + 60_000);
  fixtureDb.close();
  const prior = { Authorization: 'Bearer ' + legacyToken };
  const legacyPhone = '13800138002';
  assert.equal((await request('/auth/request-code', { phone: legacyPhone }, prior)).status, 200);
  const migrated = await (await request('/auth/verify', { phone: legacyPhone, code: await verifyCode(legacyPhone) }, prior)).json();
  const legacyUser = { Authorization: 'Bearer ' + migrated.session };
  assert.equal((await request('/me', undefined, prior)).status, 401);
  assert.equal((await (await request('/me', undefined, legacyUser)).json()).remaining, 3);
  const dashboard = await request('/admin/dashboard', undefined, adminHeaders);
  assert.equal(dashboard.status, 200);
  const result = await dashboard.json();
  assert.equal(result.orders.find((order) => order.id === orderId).status, 'fulfilled');
  assert.equal(result.stats.wallet_charge_cents, 250);
  assert.ok(result.stats.cost_cents > 0 && result.stats.metered >= 2);
  assert.ok(Number.isInteger(result.stats.p50) && result.stats.p95 >= result.stats.p50);
  assert.equal((await request('/admin/settings', { defaultModel: 'env', guestFree: false, paused: true, announcement: '测试公告' }, adminHeaders)).status, 200);
  assert.equal((await request('/generate', { text: source, length: 'short', maxCharge: 100 }, user)).status, 503);
  const users = await (await request('/admin/users?q=13800138001', undefined, adminHeaders)).json();
  assert.equal(users.users.length, 1);
  assert.equal((await request('/admin/users', { id: users.users[0].id, status: 'blocked', delta: 0 }, adminHeaders)).status, 200);
  assert.equal((await request('/me', undefined, secondUser)).status, 403);
  assert.equal((await (await request('/me', undefined, user)).json()).balanceCents, 200);
  assert.deepEqual(admin.consoleErrors, []);
  assert.deepEqual(reader.consoleErrors, []);
  console.log('✓ 后台定价、订阅支付、充值、在线收银台回跳和按篇扣费通过');
  console.log('✓ 签名校验、重复回调、支付确认、仅余额消费、旧额度迁移和失败不扣费通过');
} finally {
  await admin?.close();
  await reader?.close();
  if (app && app.exitCode === null && app.signalCode === null) {
    const exited = once(app, 'exit');
    app.kill();
    await exited;
  }
  paymentGateway.closeAllConnections();
  paymentGateway.close();
  upstream.closeAllConnections();
  upstream.close();
  await rm(temp, { recursive: true, force: true });
}
