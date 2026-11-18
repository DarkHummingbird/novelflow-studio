/**
 * 把 Vite 产物内联成单文件 HTML —— 双击即可运行，不依赖 dev server / http 服务。
 * 前提：vite.config.ts 中 output.format = 'iife'（无 ESM，file:// 才不会被 CORS 拦）。
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const dist = path.resolve('dist');
const outFile = path.join(dist, 'novelflow-studio-standalone.html');

if (!existsSync(path.join(dist, 'index.html'))) {
  console.error('未找到 dist/index.html，请先执行 npm run build');
  process.exit(1);
}

let html = await readFile(path.join(dist, 'index.html'), 'utf8');
const assetsDir = path.join(dist, 'assets');
const files = existsSync(assetsDir) ? await readdir(assetsDir) : [];

const cssFiles = files.filter((f) => f.endsWith('.css'));
const jsFiles = files.filter((f) => f.endsWith('.js'));

for (const cssName of cssFiles) {
  const css = await readFile(path.join(assetsDir, cssName), 'utf8');
  const tag = new RegExp(`<link[^>]*href="[^"]*${cssName.replace('.', '\\.')}"[^>]*>`);
  // 必须用函数式 replacement：CSS/JS 里的 $& / $' 会被当成替换模式
  html = html.replace(tag, () => `<style>\n${css}\n</style>`);
}

let inlineJs = '';
for (const jsName of jsFiles) {
  const js = await readFile(path.join(assetsDir, jsName), 'utf8');
  // 防止脚本内容里出现 </script> 提前闭合标签
  inlineJs += js.replace(/<\/script/gi, '<\\/script');
  const tag = new RegExp(`<script[^>]*src="[^"]*${jsName.replace('.', '\\.')}"[^>]*></script>`);
  // 从 head 里摘掉：普通 script 会立即执行，此时 #root 还不存在
  html = html.replace(tag, () => '');
}

// 统一注入到 </body> 之前，保证 DOM 已解析
if (inlineJs) {
  html = html.replace('</body>', () => `<script>\n${inlineJs}\n</script>\n  </body>`);
}

if (html.includes('/assets/')) {
  console.warn('⚠ 仍有未内联的 asset 引用，请检查 dist/index.html');
}

await writeFile(outFile, html, 'utf8');
const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
console.log(`✓ 单文件构建完成：${path.relative(process.cwd(), outFile)} (${kb} KB)`);
