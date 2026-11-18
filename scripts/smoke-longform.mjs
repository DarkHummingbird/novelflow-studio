/**
 * 长文模式端到端冒烟：前文 > 6,000 字 → 分单元滚动。
 *   node scripts/smoke-longform.mjs [file-or-url]
 * 断言：路由到「超长篇」→ 大纲出现「单元 / 全部收尾」→ 逐个单元写到完成 →
 *       不出现内置示例脚本、不出现示例里的人物（防串味）→ Markdown 导出成功落盘。
 */
import path from 'node:path';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import { launch } from './lib/cdp.mjs';

const target = process.argv[2] ?? 'dist/novelflow-studio-standalone.html';
const baseUrl = target.startsWith('http') ? target : `file://${path.resolve(target)}`;
// 无模型的结构演示需要显式开关（产品路径默认关闭仿真）
const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}sim=1`;

const PARAS = [
  '顾砚舟把第{n}份股权代持协议推到桌子中央，指尖压住纸角，一直没有松开。',
  '沈曼青没有接，只是把第{n}杯茶推到一边，杯底在桌面上划出一道浅浅的水痕。',
  '“这是第{n}次了。”陈明远把录音笔放在两人中间，红灯亮着，“你们自己决定怎么谈。”',
  '审计组进场第{n}天，顾家的会议室被清空，只剩一张长桌和一排没来得及收走的椅子。',
  '顾老爷子拄着拐杖第{n}次进来，先看桌上的文件，再看他儿子的脸，什么都没问。',
  '我坐在最靠窗的位置，把第{n}号凭证的复印件按日期排开，从最早的一张开始。',
  '沈曼青的律师第{n}次提出延期，理由是“材料还在整理”，被陈明远一句话顶了回去。',
  '那份流水上的第{n}道签字，笔迹鉴定报告写着同一份结论：其中一道是后补的。',
  '走廊尽头的灯闪了第{n}下，有人把门带上，会议室里只剩下翻纸的声音。',
  '顾砚舟第{n}次抬头看我，喉结动了一下，最后只问了一句：“你从什么时候开始的？”',
  '我没有回答，把第{n}页翻过去，指着那行几乎看不清的铅笔字。',
  '审计报告第{n}部分的附件全部是三年间的往来邮件打印件，页脚还留着打印机编号。',
  '陈明远把时间线画在白板第{n}栏，从第一笔转账画到今天这场会，每一格都标了日期。',
  '窗外的雨停了第{n}个小时，会议室里的空调还在响，声音比刚才清楚了一些。',
];

function buildLongText(minChars) {
  let out = '';
  let i = 0;
  while (out.length < minChars) {
    out += `${PARAS[i % PARAS.length].replace(/\{n\}/g, String(i + 1))}\n\n`;
    i += 1;
  }
  out += '我把那份审计底稿拍在桌上，顾砚舟，你自己看清楚上面写的是谁的名字。';
  return out;
}

const longText = buildLongText(7200);
console.log(`输入前文：${longText.length} 字符`);

const app = await launch({ url, port: 9334 });

try {
  console.log('1) 输入 7,200+ 字前文');
  const filled = await app.fillInput(['前文'], longText);
  if (filled !== 'FILLED') throw new Error('前文输入框不可用');
  await app.waitForText('超长篇', 12000);
  await app.screenshot('/tmp/nf_l1_input.png');

  console.log('2) 生成大纲（应切到分单元模式）');
  await app.clickAny(['生成分段大纲', '重新生成大纲']);
  await app.waitForText('分段大纲', 40000);
  const blueprint = await app.bodyText();
  for (const marker of ['单元', '全部收尾']) {
    if (!blueprint.includes(marker)) throw new Error(`长文大纲缺少：${marker}`);
  }
  await app.screenshot('/tmp/nf_l2_blueprint.png');

  console.log('3) 逐单元撰写');
  await app.clickAny(['确认大纲，开始写', '按当前大纲重写正文']);
  await app.waitForText('质检', 90000);
  await app.waitForText('全部段落撰写与质检完成', 120000);
  await new Promise((r) => setTimeout(r, 1200));
  const body = await app.bodyText();

  if (body.includes('示例脚本')) throw new Error('长文模式错误地使用了内置示例脚本');
  if (body.includes('周景深')) throw new Error('检测到示例样本人物串味（应为用户自己的故事）');
  if (!/质检/.test(body) && !body.includes('没通过，先保留')) {
    throw new Error('未产出可判定的门禁结果');
  }
  await app.screenshot('/tmp/nf_l3_written.png');

  console.log('4) 导出 Markdown');
  const downloadDir = await mkdtemp(path.join(os.tmpdir(), 'nf-dl-'));
  await app.enableDownloads(downloadDir);
  await app.clickByText('.MD');
  let files = [];
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 200));
    files = (await readdir(downloadDir)).filter((f) => f.endsWith('.md'));
    if (files.length) break;
  }
  if (!files.length) throw new Error('Markdown 未落盘');
  const md = await readFile(path.join(downloadDir, files[0]), 'utf8');
  if (!md.includes('质检报告')) throw new Error('导出的 Markdown 缺少质检结果');
  if (!md.includes('卡点前文（原文）')) throw new Error('导出的 Markdown 缺少前文');
  console.log(`  ✓ 已导出 ${files[0]}（${md.length} 字符）`);

  if (app.consoleErrors.length) {
    for (const e of app.consoleErrors.slice(0, 5)) console.error('  JS 错误：', e.split('\n')[0]);
    throw new Error('控制台存在 JS 错误');
  }
  console.log('  ✓ 无控制台错误');
  console.log('✓ 长文模式冒烟通过');
} catch (err) {
  console.error('✗ 长文冒烟失败：', err.message);
  try {
    await app.screenshot('/tmp/nf_l_fail.png');
    console.error('  可见文本尾部：', JSON.stringify((await app.bodyText()).slice(-300)));
    for (const e of app.consoleErrors.slice(0, 5)) console.error('  JS 错误：', e.split('\n')[0]);
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
} finally {
  await app.close();
}
