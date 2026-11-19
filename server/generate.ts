import { callLLM } from '../src/lib/api';
import type { LLMResponse } from '../src/lib/api';
import type { StoryAnalysis } from '../src/lib/story-analysis';
import { distributeTargets } from '../src/lib/router';
import { countWords } from '../src/lib/text';
import type { ApiConfig } from '../src/types';
import {
  ANALYSIS_PROMPT, MEMORY_PROMPT, WRITING_PROMPT, StoryAnalysisError,
  lastLineOfStory, parseStoryAnalysis, parseStoryMemory,
} from './story-context';
import { checkStoryPart, minPartWords } from './story-quality';

type Meter = (usage: LLMResponse['usage']) => void;
type PartMemory = NonNullable<ReturnType<typeof parseStoryMemory>> | { excerpt: string };

async function analyze(
  source: string, targets: number[], config: ApiConfig, signal: AbortSignal, meter: Meter,
): Promise<StoryAnalysis> {
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    const response = await callLLM(config, {
      system: ANALYSIS_PROMPT,
      user: JSON.stringify({
        前文: source,
        最后一句原文: lastLineOfStory(source),
        各段目标非空白字数: targets,
        格式反馈: attempt ? '上次返回不符合结构，请只输出完整 JSON，并提供与要求相同数量的分段任务。' : undefined,
      }),
      signal, json: true, maxTokens: Math.min(2500, config.maxTokens), redirect: 'error',
    });
    meter(response.usage);
    const result = parseStoryAnalysis(response.text, source, targets.length);
    if (result) return result;
  }
  throw new StoryAnalysisError();
}

async function remember(
  part: string, config: ApiConfig, signal: AbortSignal, meter: Meter,
): Promise<PartMemory> {
  try {
    const response = await callLLM(config, {
      system: MEMORY_PROMPT,
      user: JSON.stringify({ 已写本段: part }),
      signal, json: true, maxTokens: Math.min(1400, config.maxTokens), redirect: 'error',
    });
    meter(response.usage);
    return parseStoryMemory(response.text) ?? { excerpt: part };
  } catch {
    signal.throwIfAborted();
    meter(undefined);
    return { excerpt: part };
  }
}

export async function generateStory(
  source: string,
  goal: number,
  config: ApiConfig,
  signal: AbortSignal,
  send: (event: object) => void,
  maxOutput: number,
  meter: Meter,
) {
  const targets = distributeTargets(goal, countWords(source) > 6000 ? [1, 1] : [1, 1, 1]);
  const analysis = await analyze(source, targets, config, signal, meter);
  signal.throwIfAborted();
  send({ type: 'analysis', analysis });

  const chapters: string[] = [];
  const memory: PartMemory[] = [];
  const gates: ReturnType<typeof checkStoryPart>[] = [];
  let remaining = maxOutput;

  for (const [index, target] of targets.entries()) {
    const previousTail = (chapters.at(-1) ?? source).slice(-1500);
    const futureMinimum = targets.slice(index + 1).reduce((sum, words) => sum + minPartWords(words), 0);
    const limit = remaining - futureMinimum;
    if (limit < 1) break;
    let feedback: string[] = [];
    let draft = '';
    let result = checkStoryPart(draft, target, previousTail, false);

    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      if (attempt) send({ type: 'reset', text: chapters.join('\n\n') });
      if (index) send({ type: 'delta', text: '\n\n' });
      let space = limit;
      let truncated = false;
      draft = '';
      function append(chunk: string) {
        let end = 0;
        // Use the same UTF-16 counting convention as countWords and the input validation.
        for (; end < chunk.length; end++) {
          if (/\s/u.test(chunk[end])) continue;
          if (space === 0) {
            truncated = true;
            break;
          }
          space--;
        }
        // Avoid sending a lone high surrogate if the limit splits a Unicode character.
        if (end < chunk.length && end > 0 && /[\uD800-\uDBFF]/.test(chunk[end - 1])) end--;
        const fragment = chunk.slice(0, end);
        if (!fragment) return;
        draft += fragment;
        send({ type: 'delta', text: fragment });
      }

      const response = await callLLM(config, {
        system: WRITING_PROMPT,
        user: JSON.stringify({
          前文: source,
          故事分析: analysis,
          已发生的续章记录: memory,
          紧邻结尾原文: previousTail,
          最后一句原文: lastLineOfStory(chapters.at(-1) ?? source),
          当前部分: index + 1,
          总部分数: targets.length,
          目标非空白字数: Math.min(target, limit),
          本段最多非空白字数: limit,
          当前任务: analysis.partPlan[index],
          本段修改建议: feedback,
        }),
        signal,
        maxTokens: Math.min(config.maxTokens, Math.max(1800, target * 3)),
        onDelta: append,
        includeUsage: true,
        redirect: 'error',
      });
      if (!draft && !truncated) append(response.text);
      meter(response.usage);
      result = checkStoryPart(draft, target, previousTail, truncated);
      feedback = result.feedback;
      if (!feedback.length) break;
    }

    if (!draft.trim()) break;
    chapters.push(draft);
    gates.push(result);
    remaining -= countWords(draft);
    if (index < targets.length - 1) memory.push(await remember(draft, config, signal, meter));
  }

  const text = chapters.join('\n\n');
  if (!text.trim()) throw new Error('Empty output');
  const charged = gates.length === targets.length && gates.every((gate) => !gate.feedback.length)
    && countWords(text) >= Math.ceil(goal * 0.8);
  return { text, gates, charged };
}
