/**
 * 多协议大模型客户端：Gemini 原生 + OpenAI 兼容。
 *
 * 与 v4.0 原型的差别（全部为交付级修复）：
 *  1. 真实 SSE 流式输出，UI 的打字机效果不再靠 setTimeout 伪造；
 *  2. 显式 max_tokens，规避长段被默认上限截断；
 *  3. AbortController 支持「停止」，超时保护，429/5xx 指数退避重试；
 *  4. 每次请求都带可读的错误信息（含 CORS 提示），不再静默返回 null。
 */

import type { ApiConfig } from '../types';

export class LLMError extends Error {
  status?: number;
  retryable: boolean;
  constructor(message: string, status?: number, retryable = false) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.retryable = retryable;
  }
}

export interface LLMRequest {
  system: string;
  user: string;
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onDelta?: (chunk: string) => void;
  timeoutMs?: number;
  includeUsage?: boolean;
  redirect?: RequestRedirect;
}

export interface LLMResponse {
  text: string;
  model: string;
  streamed: boolean;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const DEFAULT_TIMEOUT = 180_000;

export function isApiConfigured(cfg: ApiConfig | null | undefined): boolean {
  return Boolean(cfg && cfg.apiKey && cfg.apiKey.trim() && cfg.model && cfg.baseUrl);
}

function baseOf(baseUrl: string): string {
  return (baseUrl || '').trim().replace(/\/+$/, '');
}

function modelOf(cfg: ApiConfig): string {
  return (cfg.model || '').trim() || 'gemini-2.5-flash';
}

function joinSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new LLMError(`请求超时（${Math.round(timeoutMs / 1000)}s）`, 408, true)), timeoutMs);
  const onAbort = () => controller.abort((signal?.reason as Error | undefined) ?? new LLMError('已取消', 499, false));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

export async function readSSE(res: Response, onData: (data: string) => 'done' | 'continue'): Promise<void> {
  if (!res.body) throw new LLMError('响应没有可读流（浏览器/代理可能不支持流式）', res.status, true);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const rawLine = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const line = rawLine.replace(/\r$/, '');
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') return;
        if (onData(data) === 'done') return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function networkHint(err: unknown): LLMError {
  if (err instanceof LLMError) return err;
  if (err instanceof DOMException && err.name === 'AbortError') return new LLMError('已取消', 499, false);
  const msg = err instanceof Error ? err.message : String(err);
  if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(msg)) {
    return new LLMError(
      '网络请求失败：可能是 CORS 跨域限制或离线。浏览器直连第三方 API 常被拦截，请改用支持 CORS 的端点或自建代理。',
      0,
      true,
    );
  }
  return new LLMError(msg, 0, false);
}

/* ------------------------------------------------------------------ Gemini */

async function callGemini(cfg: ApiConfig, req: LLMRequest): Promise<LLMResponse> {
  const base = baseOf(cfg.baseUrl) || 'https://generativelanguage.googleapis.com/v1beta';
  const model = modelOf(cfg);
  const stream = Boolean(req.onDelta);
  const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  const url = `${base}/models/${encodeURIComponent(model)}:${action}`;

  const generationConfig: Record<string, unknown> = {
    temperature: req.temperature ?? cfg.temperature,
    maxOutputTokens: req.maxTokens ?? cfg.maxTokens,
  };
  if (cfg.geminiThinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: cfg.geminiThinkingLevel };
  if (req.json) generationConfig.responseMimeType = 'application/json';

  const body = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: 'user', parts: [{ text: req.user }] }],
    generationConfig,
  };

  const { signal, cleanup } = joinSignal(req.signal, req.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    const res = await fetch(url, {
      redirect: req.redirect,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey.trim() },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw await httpError(res);

    let text = '';
    let usage: LLMResponse['usage'];
    if (stream) {
      await readSSE(res, (data) => {
        try {
          const json = JSON.parse(data) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
          };
          for (const cand of json.candidates ?? []) {
            for (const part of cand.content?.parts ?? []) {
              if (part.text && !part.thought) {
                text += part.text;
                req.onDelta?.(part.text);
              }
            }
          }
          if (json.usageMetadata) {
            usage = {
              prompt_tokens: json.usageMetadata.promptTokenCount,
              completion_tokens: json.usageMetadata.candidatesTokenCount === undefined ? undefined
                : json.usageMetadata.candidatesTokenCount + (json.usageMetadata.thoughtsTokenCount ?? 0),
            };
          }
        } catch {
          /* 忽略无法解析的心跳帧 */
        }
        return 'continue';
      });
    } else {
      const json = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
      };
      text = (json.candidates ?? [])
        .flatMap((c) => c.content?.parts ?? [])
        .map((p) => p.thought ? '' : p.text ?? '')
        .join('');
      usage = {
        prompt_tokens: json.usageMetadata?.promptTokenCount,
        completion_tokens: json.usageMetadata?.candidatesTokenCount === undefined ? undefined
          : json.usageMetadata.candidatesTokenCount + (json.usageMetadata.thoughtsTokenCount ?? 0),
      };
    }
    if (!text.trim()) throw new LLMError('模型返回空内容（可能触发安全策略或输出被截断）', 200, true);
    return { text, model, streamed: stream, usage };
  } catch (err) {
    throw networkHint(err);
  } finally {
    cleanup();
  }
}

/* ------------------------------------------------------------------ OpenAI */

async function callOpenAICompatible(cfg: ApiConfig, req: LLMRequest, useMaxCompletionTokens = false, omitStreamOptions = false): Promise<LLMResponse> {
  const base = baseOf(cfg.baseUrl) || 'https://api.openai.com/v1';
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
  const stream = Boolean(req.onDelta);
  const payload: Record<string, unknown> = {
    model: modelOf(cfg),
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
    temperature: req.temperature ?? cfg.temperature,
    stream,
  };
  if (cfg.deepseekThinking) payload.thinking = { type: cfg.deepseekThinking };
  const maxTokens = req.maxTokens ?? cfg.maxTokens;
  if (maxTokens > 0) {
    if (useMaxCompletionTokens) payload.max_completion_tokens = maxTokens;
    else payload.max_tokens = maxTokens;
  }
  if (stream && req.includeUsage && !omitStreamOptions) payload.stream_options = { include_usage: true };
  if (req.json) payload.response_format = { type: 'json_object' };

  const { signal, cleanup } = joinSignal(req.signal, req.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    const res = await fetch(url, {
      redirect: req.redirect,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey.trim()}` },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) {
      const err = await httpError(res);
      const unsupported = err.status === 400 && /max_completion_tokens|max_tokens/i.test(err.message);
      if (unsupported && !useMaxCompletionTokens) return callOpenAICompatible(cfg, req, true, omitStreamOptions);
      if (err.status === 400 && payload.stream_options && /stream_options|include_usage/i.test(err.message)) {
        return callOpenAICompatible(cfg, req, useMaxCompletionTokens, true);
      }
      throw err;
    }

    if (!stream) {
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = json.choices?.map((c) => c.message?.content ?? '').join('') ?? '';
      if (!text.trim()) throw new LLMError('模型返回空内容', 200, true);
      return { text, model: modelOf(cfg), streamed: false, usage: json.usage };
    }

    let text = '';
    let usage: LLMResponse['usage'];
    await readSSE(res, (data) => {
      try {
        const json = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        for (const choice of json.choices ?? []) {
          const piece = choice.delta?.content;
          if (piece) {
            text += piece;
            req.onDelta?.(piece);
          }
        }
        if (json.usage) usage = json.usage;
      } catch {
        /* 忽略非 JSON 帧 */
      }
      return 'continue';
    });
    if (!text.trim()) throw new LLMError('流式响应为空（该端点可能不支持 stream）', 200, true);
    return { text, model: modelOf(cfg), streamed: true, usage };
  } catch (err) {
    throw networkHint(err);
  } finally {
    cleanup();
  }
}

/* --------------------------------------------------------------- 重试包装 */

async function httpError(res: Response): Promise<LLMError> {
  const body = await res.text().catch(() => '');
  const snippet = body.slice(0, 320).replace(/\s+/g, ' ');
  let detail = '';
  try {
    const json = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    if (typeof json.error === 'string') detail = json.error;
    else detail = json.error?.message ?? json.message ?? '';
  } catch {
    /* 非 JSON 错误体 */
  }
  const retryable = res.status === 429 || res.status >= 500 || res.status === 408;
  const hint =
    res.status === 401 || res.status === 403
      ? '（API Key 无效或无权限）'
      : res.status === 404
        ? '（模型名或 Base URL 不正确）'
        : res.status === 429
          ? '（限流/配额不足）'
          : '';
  return new LLMError(`HTTP ${res.status}${hint} ${detail || snippet}`.trim(), res.status, retryable);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function callLLM(cfg: ApiConfig, req: LLMRequest): Promise<LLMResponse> {
  if (!isApiConfigured(cfg)) throw new LLMError('未配置 API Key', 0, false);

  // 已经吐字后禁止重试，否则同一段正文会被写两遍
  let emitted = 0;
  const trackedReq: LLMRequest = req.onDelta
    ? {
        ...req,
        onDelta: (chunk: string) => {
          emitted += chunk.length;
          req.onDelta?.(chunk);
        },
      }
    : req;
  const run = () => (cfg.provider === 'gemini' ? callGemini(cfg, trackedReq) : callOpenAICompatible(cfg, trackedReq));

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await run();
    } catch (err) {
      lastErr = err;
      const e = networkHint(err);
      if (e.status === 499 || req.signal?.aborted) throw e;
      if (!e.retryable || emitted > 0 || attempt === 2) throw e;
      await sleep(700 * 2 ** attempt + Math.floor(Math.random() * 250));
    }
  }
  throw networkHint(lastErr);
}

export async function pingLLM(cfg: ApiConfig): Promise<{ ok: boolean; message: string; latencyMs: number }> {
  const started = performance.now();
  try {
    const res = await callLLM(cfg, {
      system: '你是接口连通性测试助手，只回复用户要求的内容，不要解释。',
      user: '只回复四个字：连通成功',
      maxTokens: 32,
      temperature: 0,
      timeoutMs: 30_000,
    });
    const latencyMs = Math.round(performance.now() - started);
    return { ok: true, message: `连通成功 · ${res.model}${res.streamed ? '（流式）' : ''} · ${latencyMs}ms · 返回：${res.text.trim().slice(0, 24)}`, latencyMs };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    return { ok: false, message: err instanceof Error ? err.message : String(err), latencyMs };
  }
}
