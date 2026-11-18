/**
 * 端到端冒烟（标准流程）：真实点击一遍主链路，并逐一验证四种导出。
 */
import path from 'node:path';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import { launch, sleep } from './lib/cdp.mjs';

const target = process.argv[2] ?? 'dist/novelflow-studio-standalone.html';
const baseUrl = target.startsWith('http') ? target : `file://${path.resolve(target)}`;
// 无模型的结构演示需要显式开关（产品路径默认关闭仿真）
const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}sim=1`;
const downloadDir = await mkdtemp(path.join(os.tmpdir(), 'nf-dl-'));

const app = await launch({ url, port: 9333 });
await app.enableDownloads(downloadDir);
await app.send('DOM.enable');

async function downloadByClick(label, ext, timeout = 15000) {
  const before = new Set(await readdir(downloadDir));
  await app.clickAny([label]);
  const started = Date.now();
  while (Date.now() - started < timeout) {
    await sleep(200);
    const after = await readdir(downloadDir);
    const fresh = after.filter((f) => !before.has(f) && f.endsWith(ext));
    if (fresh.length) return path.join(downloadDir, fresh[0]);
  }
  throw new Error(`下载未落盘：${label} (*${ext})`);
}

try {
  console.log('1) 首屏渲染');
  const home = await app.bodyText();
  for (const marker of ['前文与要求', '悬念类型与分段大纲', '正文与修改', '一键全自动续写']) {
    if (!home.includes(marker)) throw new Error(`首屏缺少：${marker}`);
  }
  await app.screenshot('/tmp/nf_1_home.png');

  console.log('2) 生成四拍蓝图');
  await app.clickAny(['生成分段大纲', '重新生成大纲']);
  await app.waitForText('分段大纲');
  await app.screenshot('/tmp/nf_2_blueprint.png');

  console.log('3) 启动主笔续写');
  await app.clickAny(['确认大纲，开始写', '按当前大纲重写正文']);
  await app.waitForText('质检', 40000);
  await sleep(3500);
  const written = await app.bodyText();
  if (!written.includes('质检通过') && !written.includes('按上限保留')) {
    throw new Error('正文未产出或门禁状态缺失');
  }
  await app.screenshot('/tmp/nf_3_write.png');

  console.log('4) 单段局部重写');
  await app.clickAny(['局部重写']);
  const filled = await app.fillInput(['微调要求'], '打脸再狠一点，多加两句宾客当场倒戈的对话');
  if (filled !== 'FILLED') throw new Error('局部重写输入框不可用');
  await app.clickAny(['执行重写']);
  await app.waitForText('局部重写完成', 30000);
  await app.screenshot('/tmp/nf_4_rewrite.png');

  console.log('5) 开发视图 + 步骤检视器');
  await app.clickAny(['开发视图']);
  await app.waitForText('开发视图：能看到每一步');
  await app.clickAny(['读前文']);
  await app.waitForText('给模型的指令');
  await app.screenshot('/tmp/nf_5_architect.png');
  await app.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '关闭');
    if (btn) btn.click();
    return 'CLOSED';
  })()`);

  console.log('6) 质检结果');
  await app.clickAny(['质检结果']);
  await app.waitForText('质检报告');
  await app.screenshot('/tmp/nf_6_report.png');

  console.log('7) 导出：Markdown / TXT / 交接数据');
  const mdPath = await downloadByClick('.MD', '.md');
  const md = await readFile(mdPath, 'utf8');
  if (!md.includes('卡点前文（原文）') || !md.includes('六道商业门禁质检报告')) {
    throw new Error('Markdown 缺少前文或质检结果');
  }
  const txtPath = await downloadByClick('.TXT', '.txt');
  const txt = await readFile(txtPath, 'utf8');
  if (txt.length < 1000) throw new Error('TXT 内容过短');
  const contractPath = await downloadByClick('交接数据', '.json');
  const contract = JSON.parse(await readFile(contractPath, 'utf8'));
  if (!contract.agent1_payload || !contract.gate_results) throw new Error('契约 JSON 缺少载荷或门禁结果');
  console.log(`  ✓ .MD ${md.length} 字符 · .TXT ${txt.length} 字符 · 契约 JSON 含 ${contract.gate_results.length} 段`);

  console.log('8) 作品草稿箱 / 快照（含自动快照）');
  const opened = await app.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.title || '').includes('作品草稿箱'));
    if (!btn) return 'NOT_FOUND';
    btn.click();
    return 'CLICKED';
  })()`);
  if (opened !== 'CLICKED') throw new Error('找不到作品草稿箱入口');
  await app.waitForText('版本历史');
  const drawer = await app.bodyText();
  if (!drawer.includes('自动')) throw new Error('没有找到自动快照（重写前应自动存档）');
  if (!drawer.includes('重写第 1 段前')) throw new Error('自动快照缺少原因标签');
  const persistence = drawer.includes('IndexedDB 持久化')
    ? 'indexeddb'
    : drawer.includes('内存模式')
      ? 'memory'
      : 'unknown';
  await app.clickAny(['保存当前版本']);
  await app.waitForText('手动', 12000);
  await app.screenshot('/tmp/nf_7_projects.png');
  console.log(`  ✓ 持久化：${persistence} · 自动快照可见`);

  console.log('9) 归档导出 + 导入往返');
  const archivePath = await downloadByClick('导出全部', '.json');
  const archive = JSON.parse(await readFile(archivePath, 'utf8'));
  if (archive.format !== 'novelflow-archive') throw new Error('归档格式标记不正确');
  if (archive.projects.length < 1) throw new Error('归档里没有作品');

  // 抽屉会随存档刷新重渲染，节点 id 可能失效：每次重试都重新取节点
  let imported = false;
  for (let attempt = 0; attempt < 4 && !imported; attempt++) {
    const doc = await app.send('DOM.getDocument', { depth: -1 });
    const inputNode = await app.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: 'input[type="file"][accept*="json"]',
    });
    if (!inputNode.nodeId) throw new Error('找不到导入备份的 file input');
    await app.send('DOM.setFileInputFiles', { files: [archivePath], nodeId: inputNode.nodeId });
    const started = Date.now();
    let failure = '';
    while (Date.now() - started < 6000) {
      const text = await app.bodyText();
      if (text.includes('已导入')) {
        imported = true;
        break;
      }
      const err = text.match(/导入失败[^\n]*/);
      if (err) {
        failure = err[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (failure) throw new Error(failure);
  }
  if (!imported) throw new Error('导入存档没有成功（既没成功提示也没失败提示）');
  const afterImport = await app.bodyText();
  const count = Number((afterImport.match(/我的作品（([0-9]+)）/) || [])[1] || '0');
  if (count < 2) throw new Error(`导入后作品数没有增加（当前 ${count}）`);
  await app.screenshot('/tmp/nf_8_archive.png');
  console.log(`  ✓ 归档往返成功，作品数 ${count}`);

  console.log('10) 刷新页面 → 断点恢复');
  await app.send('Page.reload', { ignoreCache: true });
  await app.waitForText('正文与修改', 25000);
  await app.waitForText('质检通过', 30000);
  const restored = await app.bodyText();
  if (!restored.includes('3,364')) throw new Error('刷新后前文字数没恢复');
  const restoreOpened = await app.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.title || '').includes('作品草稿箱'));
    if (!btn) return 'NOT_FOUND';
    btn.click();
    return 'CLICKED';
  })()`);
  if (restoreOpened !== 'CLICKED') throw new Error('刷新后找不到草稿箱入口');
  await app.waitForText('版本历史', 12000);
  const afterReload = await app.bodyText();
  const snapCount = Number((afterReload.match(/版本历史（([0-9]+)\//) || [])[1] || '0');
  if (snapCount < 1) throw new Error('刷新后快照丢失');
  await app.screenshot('/tmp/nf_9_reload.png');
  console.log(`  ✓ 刷新后作品、正文、${snapCount} 个快照全部还在`);

  console.log('11) 结果');
  const stats = await app.evaluate(`(() => {
    const text = document.body.innerText;
    return {
      words: (text.match(/[0-9,]+\\s*字/) || []).slice(0, 4),
      pass: (text.match(/通过六道门禁|质检通过/g) || []).length,
      reject: (text.match(/门禁 REJECT/g) || []).length,
      forced: (text.match(/按上限保留/g) || []).length,
    };
  })()`);
  console.log('  统计：', JSON.stringify(stats));
  if (app.consoleErrors.length) {
    for (const e of app.consoleErrors.slice(0, 8)) console.error('   -', e.split('\n')[0]);
    throw new Error('控制台存在 JS 错误');
  }
  console.log('  ✓ 无控制台错误');
  console.log('✓ 冒烟测试通过（含四种导出与归档往返）');
} catch (err) {
  console.error('✗ 冒烟测试失败：', err.message);
  try {
    await app.screenshot('/tmp/nf_fail.png');
    console.error('  可见文本尾部：', JSON.stringify((await app.bodyText()).slice(-280)));
    for (const e of app.consoleErrors.slice(0, 5)) console.error('  JS 错误：', e.split('\n')[0]);
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
} finally {
  await app.close();
}
