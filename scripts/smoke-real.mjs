/**
 * 真实链路冒烟：通过本地代理把产品接到一个 OpenAI 兼容端点（可以是真模型，也可以是
 * scripts/lib/fake-upstream.mjs 的桩），验证「BYOK 配置 → 连通性探测 → Agent1/2/3
 * 真实 HTTP/SSE → 六道门禁」整条链路。
 *
 *   # 桩：验证链路
 *   node scripts/lib/fake-upstream.mjs &
 *   NF_KEY=stub NF_UPSTREAM=http://127.0.0.1:8799/v1 node scripts/proxy.mjs &
 *   node scripts/smoke-real.mjs
 *
 *   # 真模型：把 NF_UPSTREAM/NF_KEY 换成真实值即可
 *   NF_KEY=sk-xxx NF_UPSTREAM=https://api.deepseek.com/v1 node scripts/proxy.mjs
 */
import path from 'node:path';
import { launch } from './lib/cdp.mjs';

const target = process.argv[2] ?? 'dist/novelflow-studio-standalone.html';
const url = target.startsWith('http') ? target : `file://${path.resolve(target)}`;
const baseUrl = process.env.NF_BASE_URL ?? 'http://127.0.0.1:8787/v1';
const model = process.env.NF_TEST_MODEL ?? 'stub-model';

const app = await launch({ url, port: 9335 });

async function setNative(selector, value, kind) {
  const result = await app.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'NOT_FOUND';
    const proto = ${kind === 'select'
      ? 'window.HTMLSelectElement'
      : kind === 'textarea'
        ? 'window.HTMLTextAreaElement'
        : 'window.HTMLInputElement'}.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event(${kind === 'select' ? "'change'" : "'input'"}, { bubbles: true }));
    return 'OK';
  })()`);
  if (result !== 'OK') throw new Error(`设置 ${selector} 失败：${result}`);
}

try {
  console.log('1) 打开 BYOK 配置并指向本地代理');
  await app.clickAny(['配置 API', '真实模型']);
  await app.waitForText('大模型接入配置');
  await setNative('select[name="api-provider"]', 'openai', 'select');
  await setNative('input[name="api-base-url"]', baseUrl, 'input');
  await setNative('input[name="api-model"]', model, 'input');
  await setNative('input[name="api-key"]', 'local-proxy', 'input');
  await app.screenshot('/tmp/nf_r1_config.png');

  console.log('2) 连通性探测（真实 HTTP 往返）');
  await app.clickByText('测试连通性');
  await app.waitForText('连通成功', 30000);
  await app.screenshot('/tmp/nf_r2_ping.png');

  console.log('3) 保存配置');
  await app.clickByText('保存配置');
  await app.waitForText('真实模型', 10000);

  console.log('4) Agent 01 + 02（真实 JSON 往返）');
  await app.clickAny(['生成商业三段式细纲', '重新生成四拍蓝图']);
  await app.waitForText('四拍续写蓝图', 90000);
  const blueprint = await app.bodyText();
  if (!blueprint.includes('主编模型')) throw new Error('蓝图不是来自模型（判定来源应为主编模型）');
  await app.screenshot('/tmp/nf_r3_blueprint.png');

  console.log('5) Agent 03 流式撰写 + Agent 04 门禁');
  await app.clickAny(['确认蓝图并启动主笔续写', '按当前蓝图重写正文']);
  await app.waitForText('六道门禁', 120000);
  await app.waitForText('全部段落撰写与质检完成', 180000);
  await new Promise((r) => setTimeout(r, 1200));
  const body = await app.bodyText();
  if (!/门禁\s*PASS/.test(body) && !body.includes('按上限保留')) throw new Error('门禁未产出');
  if (!body.includes('模型撰写')) throw new Error('正文来源不是模型（应显示“模型撰写”）');
  if (body.includes('仿真引擎')) throw new Error('仍然走的是仿真引擎，说明配置未生效');
  await app.screenshot('/tmp/nf_r4_written.png');

  if (app.consoleErrors.length) {
    for (const e of app.consoleErrors.slice(0, 5)) console.error('  JS 错误：', e.split('\n')[0]);
    throw new Error('控制台存在 JS 错误');
  }
  console.log('  ✓ 无控制台错误');
  console.log('✓ 真实链路冒烟通过（端点：' + baseUrl + '）');
} catch (err) {
  console.error('✗ 真实链路冒烟失败：', err.message);
  try {
    await app.screenshot('/tmp/nf_r_fail.png');
    console.error('  可见文本尾部：', JSON.stringify((await app.bodyText()).slice(-320)));
    for (const e of app.consoleErrors.slice(0, 5)) console.error('  JS 错误：', e.split('\n')[0]);
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
} finally {
  await app.close();
}
