/**
 * 持久化专项冒烟：验证「刚改完就刷新」也不丢内容。
 * 场景：填入一段带唯一标记的前文 → 不等 800ms 防抖窗口 → 立即重载页面
 *       期望：页面隐藏时同步写下的应急快照被读回，输入框内容与标记一致。
 *
 *   node scripts/smoke-durability.mjs [file-or-url]
 */
import path from 'node:path';
import { launch } from './lib/cdp.mjs';

const target = process.argv[2] ?? 'dist/novelflow-studio-standalone.html';
const baseUrl = target.startsWith('http') ? target : `file://${path.resolve(target)}`;
// 无模型的结构演示需要显式开关（产品路径默认关闭仿真）
const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}sim=1`;
const app = await launch({ url, port: 9336 });

try {
  const marker = `刷新落盘验证_${Date.now()}`;
  const payload = `${marker}\n\n第二段正文，用来验证防抖窗口内的改动不会随刷新丢失。`;

  console.log('1) 填入带唯一标记的前文（不等防抖）');
  const filled = await app.fillInput(['前文'], payload);
  if (filled !== 'FILLED') throw new Error('前文输入框不可用');

  console.log('2) 立即重载页面');
  await app.send('Page.reload', { ignoreCache: true });
  await app.waitForText('正文与修改', 25000);
  await new Promise((r) => setTimeout(r, 600));

  const value = await app.evaluate('document.querySelector("textarea") ? document.querySelector("textarea").value : ""');
  if (!value.includes(marker)) throw new Error('刷新后最后一段编辑丢失（应急快照未生效）');
  if (!value.includes('第二段正文')) throw new Error('刷新后只恢复了部分内容');

  await app.screenshot('/tmp/nf_10_durability.png');
  console.log(`  ✓ 刷新后内容完整恢复（${value.length} 字符，含唯一标记）`);

  if (app.consoleErrors.length) {
    for (const e of app.consoleErrors.slice(0, 5)) console.error('  JS 错误：', e.split('\n')[0]);
    throw new Error('控制台存在 JS 错误');
  }
  console.log('  ✓ 无控制台错误');
  console.log('✓ 持久化专项冒烟通过');
} catch (err) {
  console.error('✗ 持久化冒烟失败：', err.message);
  try {
    await app.screenshot('/tmp/nf_durability_fail.png');
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
} finally {
  await app.close();
}
