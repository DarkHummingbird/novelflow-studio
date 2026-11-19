import assert from 'node:assert/strict';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { launch, sleep } from './lib/cdp.mjs';

const dir = await mkdtemp(join(tmpdir(), 'nf-models-'));
const dbPath = join(dir, 'test.sqlite');
const previousGeminiKey = 'fixture-gemini-shared';
const geminiKey = 'fixture-gemini-replaced';
const deepseekKey = 'fixture-deepseek-shared';
const calls = [];
const source = '窗外下着雨。她看着窗上的水珠，终于开口。';
const upstream = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const gemini = url.pathname.startsWith('/gemini/');
  const key = gemini ? req.headers['x-goog-api-key'] : req.headers.authorization?.replace(/^Bearer /, '');
  const json = (body) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  if (gemini ? ![previousGeminiKey, geminiKey].includes(key) : key !== deepseekKey) {
    return res.writeHead(401).end();
  }
  if (req.method === 'GET') {
    return gemini ? json({
      models: [
        { name: 'models/gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-4-carbon', displayName: 'Gemini 4 Carbon', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-live-example', displayName: 'Live Fixture', supportedGenerationMethods: ['bidiGenerateContent'] },
      ],
    }) : json({ data: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] });
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const model = gemini ? url.pathname.split('/').at(-1).split(':')[0] : body.model;
  const streaming = gemini ? url.searchParams.get('alt') === 'sse' : body.stream;
  const structured = gemini ? body.generationConfig.responseMimeType === 'application/json' : Boolean(body.response_format);
  const prompt = gemini ? body.contents[0].parts[0].text : body.messages.at(-1).content;
  calls.push({ model, key, thinking: gemini ? body.generationConfig.thinkingConfig?.thinkingLevel : body.thinking?.type });
  let text = 'OK';
  if (structured) {
    const input = JSON.parse(prompt);
    text = input.各段目标非空白字数 ? JSON.stringify({
      mainPlot: '她望着窗外的雨', characters: [], conflict: '', currentScene: '她正要开口',
      openThreads: [], openingBeat: '接住她的话',
      partPlan: input.各段目标非空白字数.map((_, index) => '推进第 ' + (index + 1) + ' 段'),
    }) : JSON.stringify({ events: ['她说完了。'] });
  } else if (streaming) {
    const input = JSON.parse(prompt);
    text = '雨声渐轻，她把窗关好。';
    for (let i = 0; text.length < input.目标非空白字数; i++) {
      const bytes = createHash('sha256').update(input.当前部分 + ':' + i).digest();
      text += Array.from(bytes, (n) => String.fromCodePoint(0x6000 + n)).join('') + '。';
    }
  }
  const usage = gemini ? { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 1000, thoughtsTokenCount: 30 } }
    : { usage: { prompt_tokens: 100, completion_tokens: 1000 } };
  const payload = gemini ? { candidates: [{ content: { parts: [{ text: '测试思考内容', thought: true }, { text }] } }], ...usage }
    : { choices: [streaming ? { delta: { content: text } } : { message: { content: text } }], ...usage };
  if (!streaming) return json(payload);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    .end('data: ' + JSON.stringify(payload) + '\n\ndata: [DONE]\n\n');
});

let app;
let browser;
try {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const redirectFile = join(dir, 'fixture-vendors.mjs');
  await writeFile(redirectFile, [
    'const original = globalThis.fetch;',
    'globalThis.fetch = (input, options) => {',
    '  const url = new URL(input instanceof Request ? input.url : input);',
    "  const vendor = url.hostname === 'api.deepseek.com' ? 'deepseek' :",
    "    url.hostname === 'generativelanguage.googleapis.com' ? 'gemini' : null;",
    '  if (!vendor) return original(input, options);',
    '  return original("http://127.0.0.1:' + upstream.address().port + '/" + vendor + url.pathname + url.search, options);',
    '};',
  ].join('\n'));
  const password = 'test-only-model-dashboard';
  const salt = randomBytes(16);
  app = spawn(process.execPath, ['--import', redirectFile, 'scripts/serve.mjs'], {
    env: { ...process.env, PORT: '0', NF_DB_PATH: dbPath, NF_PROVIDER_KEY: '', NF_MODEL: '', NF_GENERATION_PAUSED: '0',
      NF_LOCAL_ADMIN_PASSWORD_ONLY: '1', NF_TRUST_PROXY: '0', NF_SECURE_COOKIE: '0', NF_SETTINGS_SECRET: 'f'.repeat(64),
      NF_ADMIN_PASSWORD_HASH: salt.toString('hex') + ':' + scryptSync(password, salt, 64).toString('hex') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  app.stdout.on('data', (chunk) => { output += chunk.toString(); });
  let base;
  for (let i = 0; i < 80 && !base; i++) {
    base = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];
    if (!base) await sleep(100);
  }
  assert.ok(base, 'server did not start');
  const post = (route, body, headers) => fetch(base + '/api' + route, {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers },
  });
  browser = await launch({ url: base + '/admin', port: 9356, width: 1280, height: 950 });
  await browser.waitForText('登录后台');
  async function setInput(selector, value) {
    await browser.evaluate('(() => {const el = document.querySelector(' + JSON.stringify(selector) + ');' +
      'Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, ' + JSON.stringify(value) + ');' +
      'el.dispatchEvent(new Event("input", {bubbles:true}));el.dispatchEvent(new Event("change", {bubbles:true}));})()');
  }
  await setInput('[name=password]', password);
  await browser.clickByText('登录后台');
  await browser.waitForText('运行概览');
  const cookie = (await browser.send('Network.getCookies', { urls: [base + '/api/admin/dashboard'] })).cookies.find((c) => c.name === 'nf_admin');
  const auth = { Cookie: 'nf_admin=' + cookie.value };
  const dashboard = async () => (await fetch(base + '/api/admin/dashboard', { headers: auth })).json();

  await browser.clickByText('模型与开关');
  await browser.waitForText('接入模型服务');
  assert.equal(await browser.evaluate('Boolean(document.querySelector("input[name=endpoint]"))'), false);
  await setInput('.model-provider:nth-child(1) input[name=key]', deepseekKey);
  await browser.evaluate('document.querySelector(".model-provider:nth-child(1) form").requestSubmit()');
  await browser.waitForText('DeepSeek Key 已保存');
  await browser.evaluate('document.querySelector(".model-provider:nth-child(1) button[type=button]").click()');
  await browser.waitForText('DeepSeek 返回了 2 个可选文字模型');
  await setInput('[name=label]', '快速续写');
  await setInput('[name=price]', '1.00');
  await browser.clickByText('保存档位');
  await browser.waitForText('续写档位已保存');
  const fast = (await dashboard()).models.find((m) => m.vendor === 'deepseek');
  assert.ok(fast);

  await setInput('.model-provider:nth-child(2) input[name=key]', previousGeminiKey);
  await browser.evaluate('document.querySelector(".model-provider:nth-child(2) form").requestSubmit()');
  await browser.waitForText('Gemini Key 已保存');
  await browser.evaluate('document.querySelector(".model-provider:nth-child(2) button[type=button]").click()');
  await browser.waitForText('Gemini 返回了 2 个可选文字模型');
  await setInput('select[name=vendor]', 'gemini');
  await setInput('[name=label]', '均衡续写');
  await setInput('[name=price]', '1.50');
  await browser.clickByText('保存档位');
  await browser.waitForText('续写档位已保存');
  const balanced = (await dashboard()).models.find((m) => m.model === 'gemini-4-hydrogen');
  assert.ok(balanced);
  const premium = (await (await post('/admin/model-tiers', {
    vendor: 'gemini', model: 'gemini-4-carbon', label: '深度续写', priceCents: 200,
  }, auth)).json()).id;
  assert.ok(premium);
  assert.equal((await post('/admin/model-tiers/default', { id: fast.id }, auth)).status, 200);
  assert.equal((await post('/admin/model-providers', { vendor: 'gemini', apiKey: geminiKey }, auth)).status, 200);
  for (const id of [fast.id, balanced.id, premium]) {
    assert.equal((await post('/admin/models/test', { id }, auth)).status, 200);
  }
  assert.deepEqual(calls.slice(-3), [
    { model: 'deepseek-flash', key: deepseekKey, thinking: 'disabled' },
    { model: 'gemini-4-hydrogen', key: geminiKey, thinking: 'LOW' },
    { model: 'gemini-4-carbon', key: geminiKey, thinking: 'LOW' },
  ]);
  const encrypted = await readFile(dbPath + '-wal');
  assert.ok(![deepseekKey, previousGeminiKey, geminiKey].some((key) => encrypted.includes(Buffer.from(key))));
  const ids = (await dashboard()).models;
  assert.equal(ids.find((m) => m.id === premium).price_cents, 200);
  assert.ok(!JSON.stringify(ids).includes(geminiKey));

  const db = new DatabaseSync(dbPath);
  const token = randomBytes(32).toString('hex');
  db.prepare("INSERT INTO users(id, phone, wallet_cents, created) VALUES ('user-models', '+8613800138009', 600, ?)").run(Date.now());
  db.prepare("INSERT INTO sessions(hash, quota, expires, user_id) VALUES (?, 0, ?, 'user-models')")
    .run(createHash('sha256').update(token).digest('hex'), Date.now() + 60_000);
  db.prepare("INSERT INTO entitlements(id, user_id, name, quota_left) VALUES ('model-test-credit', 'user-models', '测试订阅', 1)").run();
  db.close();
  const user = { Authorization: 'Bearer ' + token };
  const getAccount = async (headers) => (await fetch(base + '/api/me', { headers })).json();
  assert.deepEqual((await getAccount()).tiers.map((item) => item.id), [fast.id]);
  const catalog = (await getAccount(user)).tiers;
  assert.deepEqual(catalog.map((item) => [item.id, item.priceCents]), [[fast.id, 100], [balanced.id, 150], [premium, 200]]);
  assert.ok(!JSON.stringify(catalog).includes('gemini-4-carbon'));

  const generate = (id, maxCharge) => post('/generate', { text: source, length: 'short', tierId: id, maxCharge }, user);
  assert.match(await (await generate(premium, 0)).text(), /"chargedCents":0/);
  assert.equal((await getAccount(user)).remaining, 0);
  assert.equal((await getAccount(user)).balanceCents, 600);
  assert.equal((await generate(premium, 150)).status, 402);
  const wallet = await (await generate(premium, 200)).text();
  assert.match(wallet, /"chargedCents":200/);
  assert.doesNotMatch(wallet, /测试思考内容/);
  assert.match(await (await generate(fast.id, 100)).text(), /"chargedCents":100/);
  assert.equal((await getAccount(user)).balanceCents, 300);
  assert.equal((await post('/admin/model-tiers/toggle', { id: premium, active: false }, auth)).status, 200);
  assert.equal((await generate(premium, 200)).status, 409);
  assert.equal((await getAccount(user)).balanceCents, 300);
  assert.deepEqual(browser.consoleErrors, []);
  console.log('✓ 模型后台、厂商目录、同厂商多个档位复用和更换 Key 通过');
  console.log('✓ 两家协议、选择档位、订阅按篇、余额差异定价及停用保护通过');
} finally {
  await browser?.close();
  if (app && app.exitCode === null && app.signalCode === null) {
    const stopped = once(app, 'exit');
    app.kill();
    await stopped;
  }
  upstream.closeAllConnections();
  upstream.close();
  await rm(dir, { recursive: true, force: true });
}
