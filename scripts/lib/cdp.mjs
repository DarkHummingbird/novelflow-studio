/**
 * 极简 Chrome DevTools Protocol 驱动 —— 供冒烟脚本复用。
 * 不引入 playwright/puppeteer，避免为一次验收装几十 MB 依赖。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CHROME_PATH = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function launch({ url, width = 1600, height = 1000, port = 9333, readyText = null }) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'nf-cdp-'));
  const chrome = spawn(
    CHROME_PATH,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) break;
    } catch {
      /* not ready */
    }
    await sleep(250);
  }

  const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  const page = await created.json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  const consoleErrors = [];
  let seq = 0;
  const pending = new Map();

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? 'exception');
    }
  };

  const send = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text ?? 'evaluate failed');
    return res.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(1300);

  const api = {
    send,
    evaluate,
    consoleErrors,
    bodyText: () => evaluate('document.body.innerText'),
    async screenshot(file) {
      const res = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(file, Buffer.from(res.data, 'base64'));
      console.log(`  📸 ${file}`);
    },
    async clickByText(text) {
      const result = await evaluate(`(() => {
        const buttons = [...document.querySelectorAll('button')];
        const el = buttons.find((b) => (b.textContent || '').includes(${JSON.stringify(text)}));
        if (!el) return 'NOT_FOUND';
        el.click();
        return 'CLICKED';
      })()`);
      if (result !== 'CLICKED') throw new Error(`找不到按钮：${text}`);
      return text;
    },
    async clickAny(candidates) {
      for (const text of candidates) {
        const result = await evaluate(`(() => {
          const buttons = [...document.querySelectorAll('button')];
          const el = buttons.find((b) => (b.textContent || '').includes(${JSON.stringify(text)}));
          if (!el) return 'NOT_FOUND';
          el.click();
          return 'CLICKED';
        })()`);
        if (result === 'CLICKED') return text;
      }
      throw new Error(`找不到按钮：${candidates.join(' / ')}`);
    },
    async waitForText(text, timeout = 25000) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        try {
          const body = await evaluate('document.body ? document.body.innerText : ""');
          if (body && body.includes(text)) return body;
        } catch {
          /* 页面正在导航/重载：等下一轮 */
        }
        await sleep(250);
      }
      throw new Error(`等待文本超时：${text}`);
    },
    /** 受控输入框赋值（React 受控组件必须走原生 setter + input 事件） */
    async fillInput(selectorMatcher, value) {
      return evaluate(`(() => {
        const el = [...document.querySelectorAll('input, textarea')].find((i) =>
          ${JSON.stringify(selectorMatcher)}.some((hint) => (i.placeholder || '').includes(hint)),
        );
        if (!el) return 'NOT_FOUND';
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'FILLED';
      })()`);
    },
    async enableDownloads(dir) {
      await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
    },
    async close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      chrome.kill('SIGKILL');
    },
  };

  if (readyText) await api.waitForText(readyText);
  return api;
}
