import { afterEach, describe, expect, it, vi } from 'vitest';
import { callLLM, isApiConfigured, LLMError, pingLLM } from '../src/lib/api';
import type { ApiConfig } from '../src/types';

const openaiCfg: ApiConfig = {
  provider: 'openai',
  baseUrl: 'https://example.test/v1',
  model: 'test-model',
  apiKey: 'sk-test',
  temperature: 0.8,
  maxTokens: 2048,
  persistKey: false,
};

const geminiCfg: ApiConfig = {
  provider: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  model: 'gemini-test',
  apiKey: 'g-test',
  temperature: 0.7,
  maxTokens: 1024,
  persistKey: false,
};

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('api client', () => {
  it('未配置 Key 时直接拒绝，不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(isApiConfigured({ ...openaiCfg, apiKey: '  ' })).toBe(false);
    await expect(callLLM({ ...openaiCfg, apiKey: '' }, { system: 's', user: 'u' })).rejects.toBeInstanceOf(LLMError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('OpenAI 兼容协议：真实 SSE 流式拼接 + 显式 max_tokens', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"，世界"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const deltas: string[] = [];
    const res = await callLLM(openaiCfg, {
      system: '你是主编',
      user: '写一段',
      onDelta: (chunk) => deltas.push(chunk),
    });

    expect(res.text).toBe('你好，世界');
    expect(res.streamed).toBe(true);
    expect(deltas).toEqual(['你好', '，世界']);

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://example.test/v1/chat/completions');
    const body = JSON.parse(String(call[1].body)) as Record<string, unknown>;
    expect(body.max_tokens).toBe(2048);
    expect(body.stream).toBe(true);
    expect((call[1].headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('OpenAI 兼容协议：非流式 JSON 模式带 response_format', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 8 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await callLLM(openaiCfg, { system: 's', user: 'u', json: true });
    expect(res.text).toBe('{"ok":true}');
    expect(res.streamed).toBe(false);
    expect(res.usage?.completion_tokens).toBe(8);

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(call[1].body)) as Record<string, unknown>;
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('Gemini 原生协议：走 streamGenerateContent + x-goog-api-key 头', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"连通"}]}}]}\r\n\r\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"成功"}]}}]}\r\n\r\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await callLLM(geminiCfg, { system: 's', user: 'u', onDelta: () => {} });
    expect(res.text).toBe('连通成功');

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain(':streamGenerateContent');
    expect((call[1].headers as Record<string, string>)['x-goog-api-key']).toBe('g-test');
    const body = JSON.parse(String(call[1].body)) as {
      systemInstruction: { parts: Array<{ text: string }> };
      generationConfig: { maxOutputTokens: number };
    };
    expect(body.systemInstruction.parts[0].text).toBe('s');
    expect(body.generationConfig.maxOutputTokens).toBe(1024);
  });

  it('401 会映射成可读错误且不重试', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { message: 'invalid api key' } }, 401),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(callLLM(openaiCfg, { system: 's', user: 'u' })).rejects.toThrow(/API Key 无效/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('不支持 max_tokens 的端点会自动改用 max_completion_tokens 重试', async () => {
    let first = true;
    const fetchMock = vi.fn(async () => {
      if (first) {
        first = false;
        return jsonResponse({ error: { message: "Unsupported parameter: 'max_tokens'" } }, 400);
      }
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await callLLM(openaiCfg, { system: 's', user: 'u' });
    expect(res.text).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const second = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const body = JSON.parse(String(second[1].body)) as Record<string, unknown>;
    expect(body.max_completion_tokens).toBe(2048);
    expect(body.max_tokens).toBeUndefined();
  });

  it('网络/CORS 失败会给出可操作提示', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(callLLM(openaiCfg, { system: 's', user: 'u' })).rejects.toThrow(/CORS/);
  });

  it('连通性探测成功时返回延迟与模型名', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ choices: [{ message: { content: '连通成功' } }] })),
    );
    const result = await pingLLM(openaiCfg);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('连通成功');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
