import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callLLM } from '../src/lib/api';
import type { LLMRequest } from '../src/lib/api';
import type { ApiConfig } from '../src/types';
import { generateStory } from '../server/generate';
import { lastLineOfStory, parseStoryAnalysis, StoryAnalysisError } from '../server/story-context';

vi.mock('../src/lib/api', () => ({ callLLM: vi.fn() }));

const call = vi.mocked(callLLM);
const config: ApiConfig = {
  provider: 'openai', baseUrl: 'http://127.0.0.1', apiKey: 'fixture', model: 'fixture',
  temperature: 0.6, maxTokens: 8192, persistKey: false,
};
const source = '  林舟去接外婆。\r\n雨一直下。\r\n雨一直下。\r\n外婆问：“还赶得上末班车吗？”\r\n';
const analysis = {
  mainPlot: '林舟来接外婆。', currentScene: '外婆问是否还能赶上车。', conflict: '赶末班车。',
  characters: [{ name: '林舟', role: '来接外婆', state: '' }, { name: '沈陌', role: '猜测的人物', state: '' }],
  openThreads: ['能否一起赶上车'], openingBeat: '林舟抬头去看站牌。',
  partPlan: ['回应外婆的问题', '两人走到车站', '回家收束'],
};
const firstEvent = '林舟给外婆撑伞。';
const draftFor = (part: number, length: number) => Array.from(
  { length }, (_, index) => String.fromCodePoint(0x5000 + part * 1800 + index),
).join('') + '。';
type Input = {
  前文: string;
  已写本段?: string;
  各段目标非空白字数?: number[];
  当前部分: number;
  最后一句原文: string;
  紧邻结尾原文: string;
  故事分析: typeof analysis;
  已发生的续章记录: { events?: string[]; excerpt?: string }[];
  目标非空白字数: number;
  本段修改建议: string[];
};
const payload = (req: LLMRequest): Input => JSON.parse(req.user);
const response = (text: string, req: LLMRequest) => {
  req.onDelta?.(text);
  return { text, streamed: Boolean(req.onDelta), model: 'fixture', usage: { prompt_tokens: 10, completion_tokens: 20 } };
};
const run = (events: object[] = []) => generateStory(
  source, 4000, config, new AbortController().signal, (event) => events.push(event), 9000, () => {},
);

describe('web story analysis and continuation', () => {
  beforeEach(() => vi.resetAllMocks());

  it('retains original text and ending punctuation, then carries forward each prior part', async () => {
    const writing: Input[] = [];
    let memoryCalls = 0;
    call.mockImplementation(async (_, req) => {
      const data = payload(req);
      if (data.各段目标非空白字数) {
        expect(data.前文).toBe(source);
        expect(data.最后一句原文).toContain('还赶得上末班车吗？”');
        return response(JSON.stringify(analysis), req);
      }
      if (data.已写本段) {
        memoryCalls++;
        return response(memoryCalls === 1 ? JSON.stringify({ events: [firstEvent] }) : '无效记忆', req);
      }
      writing.push(data);
      return response(draftFor(data.当前部分, data.目标非空白字数), req);
    });

    const events: object[] = [];
    const result = await run(events);
    expect(events[0]).toMatchObject({ type: 'analysis', analysis: { mainPlot: analysis.mainPlot } });
    expect(result.charged).toBe(true);
    expect(writing).toHaveLength(3);
    expect(writing.every((data) => data.前文 === source)).toBe(true);
    expect(writing[0].紧邻结尾原文).toBe(source);
    expect(writing[0].故事分析.characters.map(({ name }) => name)).toEqual(['林舟']);
    expect(writing[1].已发生的续章记录[0].events).toEqual([firstEvent]);
    expect(writing[2].已发生的续章记录.map(({ events }) => events)).toEqual([[firstEvent], undefined]);
    expect(writing[2].已发生的续章记录[1].excerpt).toBe(draftFor(2, writing[1].目标非空白字数));
  });

  it('repairs only the rejected part and preserves its accepted prefix', async () => {
    const writing: Input[] = [];
    call.mockImplementation(async (_, req) => {
      const data = payload(req);
      if (data.各段目标非空白字数) return response(JSON.stringify(analysis), req);
      if (data.已写本段) return response(JSON.stringify({ events: [firstEvent] }), req);
      writing.push(data);
      const text = data.当前部分 === 2 && !data.本段修改建议.length
        ? '这一版过短。' : draftFor(data.当前部分, data.目标非空白字数);
      return response(text, req);
    });

    const events: object[] = [];
    expect((await run(events)).charged).toBe(true);
    expect(writing.map((data) => data.当前部分)).toEqual([1, 2, 2, 3]);
    expect(writing[2].本段修改建议[0]).toContain('至少写');
    expect(writing[3].本段修改建议).toEqual([]);
    expect(events).toContainEqual({ type: 'reset', text: draftFor(1, writing[0].目标非空白字数) });
  });

  it('returns an analysis error after two incompatible plans without writing', async () => {
    call.mockImplementation(async (_, req) => response(JSON.stringify({ ...analysis, partPlan: [] }), req));
    const events: object[] = [];
    await expect(run(events)).rejects.toBeInstanceOf(StoryAnalysisError);
    expect(call).toHaveBeenCalledTimes(2);
    expect(events).toEqual([]);
  });

  it('retains an unfinished line and permits an explicitly conflict-free source', () => {
    expect(lastLineOfStory('门外很安静。\n她正要说：“我想')).toBe('她正要说：“我想');
    expect(lastLineOfStory('她停在门口。外婆问：“你来了吗？”')).toBe('外婆问：“你来了吗？”');
    expect(parseStoryAnalysis(JSON.stringify({ ...analysis, conflict: '', characters: [], openThreads: [] }), source, 3))
      .toMatchObject({ conflict: '', characters: [], openThreads: [] });
  });
});
