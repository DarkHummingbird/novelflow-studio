/**
 * 多 Agent 流水线编排（PRD §4 / §5）。
 *
 * 真实执行顺序：
 *   Agent1（确定性清洗 + 可选 LLM 语义清洗）
 *     → 体量路由（<2500 / 2500–6000 / >6000）
 *     → Agent2（LLM 蓝图 + 契约归一化，失败则确定性规划）
 *     → 逐段：Agent3（真实流式撰写 / 微步长接力 / 仿真兜底）
 *              → Agent4（确定性六道门禁 [+ 可选 LLM 复审]）
 *              → REJECT 则带着具体修改指令返工（有上限，不会死循环）
 *     → 每段完成即回调，UI 负责写 IndexedDB 断点。
 */

import type {
  Agent1Payload,
  Agent2Payload,
  AgentId,
  AgentStatus,
  ApiConfig,
  GateResult,
  LengthTier,
  LogEntry,
  PipelineOptions,
  ProgressState,
  SegmentDraft,
  SegmentOutline,
  SourceType,
  StoryBible,
  TargetTier,
} from '../types';
import { AGENT_SPECS } from '../config/agentSpecs';
import { LENGTH_TIER_LABEL, SAMPLE_CONTINUATION, targetTierById } from '../config/presets';
import { callLLM, isApiConfigured } from './api';
import { evaluateGates, mergeLLMReview } from './gates';
import { asRecord, parseJsonLoose } from './json';
import { coerceAgent1, coerceAgent2, coerceLLMReview } from './normalize';
import { buildFallbackBible, buildSegmentPlan, planModeOf, resolveLengthTier, routeReason } from './router';
import { simulateSegment } from './simulate';
import { classifyBait, countChars, countWords, extractEndingAnchor, extractEntities, looksLikeSample, stripNoise, tailChars } from './text';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let logSeq = 0;
function makeLog(agent: AgentId | 'system', level: LogEntry['level'], text: string): LogEntry {
  logSeq += 1;
  return { id: `log-${Date.now()}-${logSeq}`, at: Date.now(), agent, level, text };
}

class AbortedError extends Error {
  constructor() {
    super('已取消');
    this.name = 'AbortedError';
  }
}

function ensureAlive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError();
}

export interface PipelineHooks {
  onLog: (entry: LogEntry) => void;
  onAgent: (agent: AgentId, status: AgentStatus) => void;
  onAgent1: (payload: Agent1Payload) => void;
  onAgent2: (payload: Agent2Payload) => void;
  onSegments: (segments: SegmentDraft[]) => void;
  onStream: (index: number, text: string) => void;
  onProgress: (progress: ProgressState) => void;
  onMemory: (banner: string) => void;
  onEngine: (engine: 'live' | 'simulation') => void;
}

export interface RunInput {
  text: string;
  sourceType: SourceType;
}

export interface RunOutcome {
  aborted: boolean;
  segments: SegmentDraft[];
  agent1: Agent1Payload;
  agent2: Agent2Payload;
  logs: LogEntry[];
  progress: ProgressState;
  memoryBanner: string;
  abortedReason?: string;
}

/* ------------------------------------------------------------ 确定性入口 */

function deterministicAgent1(
  cleaned: string,
  sourceType: SourceType,
  noiseRemoved: string[],
  paywallDetected: boolean,
): Agent1Payload {
  const total = countWords(cleaned);
  const tier: LengthTier = resolveLengthTier(total);
  const anchor = extractEndingAnchor(cleaned, 300);
  return {
    source_type: sourceType,
    cleaned_text: cleaned,
    total_char_count: total,
    length_tier: tier,
    ending_anchor: anchor,
    paywall_detected: paywallDetected,
    _meta: {
      paragraphs: cleaned.split(/\n+/).filter(Boolean).length,
      noise_removed: noiseRemoved,
      anchor_entities: extractEntities(anchor, 5),
      tier_label: LENGTH_TIER_LABEL[tier],
      judged_by: 'code',
    },
  };
}

/* ---------------------------------------------------------------- 写作 */

interface WriteArgs {
  api: ApiConfig;
  live: boolean;
  sample: boolean;
  outline: SegmentOutline;
  index: number;
  total: number;
  bible: StoryBible;
  agent1: Agent1Payload;
  contextWindow: string;
  previousTail: string;
  direction: string;
  revision: string;
  signal?: AbortSignal;
  onStream: (index: number, text: string) => void;
  log: (level: LogEntry['level'], text: string) => void;
}

function buildWritePrompt(args: WriteArgs): string {
  const { outline, index, total, bible, contextWindow, direction, revision } = args;
  const bibleBrief = [
    `人称：${bible.pov}`,
    `诱饵：${bible.bait_type}`,
    `文风：平均句长 ${bible.style_fingerprint.avg_sentence_len} 字 / 对话占比 ${bible.style_fingerprint.dialogue_ratio} / ${bible.style_fingerprint.tone_keywords.join('、')}`,
    `人物：${bible.characters.map((c) => `${c.name}(${c.role})：${c.traits}；当前${c.current_state}`).join(' ｜ ')}`,
  ].join('\n');

  return `# 任务
续写商业短篇故事的第 ${index + 1}/${total} 段【${outline.segment_role}】，目标约 ${outline.target_words} 字。
${index === 0 ? '【硬性红线】前 800 字内必须正面兑现前文卡点悬念（给出结果），严禁用环境描写、回忆杀、切视角拖延。' : ''}
${index === total - 1 ? '【终局红线】最后 400 字完成情绪闭合，末句必须是 8–60 字、可截图传播的陈述性金句（不能是问句、不能是“未完待续”）。' : ''}

# Story Bible
${bibleBrief}

# 用户走向指令
${direction.trim() || '（空）请自主推演最解气、最有传播力的走向'}

# 本段四拍细纲
起：${outline.beats.qi}
承：${outline.beats.cheng}
转：${outline.beats.zhuan}
合：${outline.beats.he}

# 紧邻上文（必须从这里无缝接续，第一句直接承接最后一秒的动作或对话）
${contextWindow}

# 门禁红线
- 字数口径：非空白字符数（含中文标点），与番茄/知乎后台一致；合格线为目标字数的 85%。
- 不要输出章节标题、段号、字数说明、作者注释。
- 禁止“嘴角勾起一抹弧度”“眼神中闪过一丝不易察觉”“空气仿佛凝固了”等套话与车轱辘话。
- 用具体动作、微表情、利益博弈与个性化台词撑字数，禁止概括式流水账。
${revision ? `\n# 上一版被六道门禁打回，本次必须逐条修正\n${revision}` : ''}

# 输出
只输出本段纯小说正文。`;
}

function buildContinuePrompt(acc: string, need: number): string {
  return `# 已有正文（不要重复以下任何内容）
${tailChars(acc, 700)}

# 接续要求
从上面最后一句之后继续写，再补约 ${need} 字（非空白字符，含标点），保持同一段落、同一视角、同一场景与同一语气。
不要总结、不要写标题、不要重新开头。只输出新增的正文。`;
}

function estimateMaxTokens(targetWords: number, ceiling: number): number {
  return Math.min(8192, Math.max(ceiling, Math.round(targetWords * 1.9)));
}

async function writeWithLLM(args: WriteArgs): Promise<{ text: string; warnings: string[] }> {
  const { api, outline, index, signal, onStream, log } = args;
  const warnings: string[] = [];
  let acc = '';
  const maxCalls = Math.min(4, Math.max(1, Math.ceil(outline.target_words / 1200)));
  let lastEmit = 0;

  for (let call = 0; call < maxCalls; call++) {
    ensureAlive(signal);
    const written = countWords(acc);
    if (call > 0 && written >= outline.target_words * 0.92) break;
    const need = Math.max(400, outline.target_words - written + 80);
    const prompt = call === 0 ? buildWritePrompt(args) : buildContinuePrompt(acc, need);

    let received = '';
    const res = await callLLM(api, {
      system: AGENT_SPECS[2].system_prompt,
      user: prompt,
      temperature: api.temperature,
      maxTokens: estimateMaxTokens(call === 0 ? outline.target_words : need, api.maxTokens),
      signal,
      onDelta: (chunk) => {
        received += chunk;
        const now = Date.now();
        if (now - lastEmit > 45) {
          lastEmit = now;
          onStream(index, acc + received);
        }
      },
    });

    acc = `${acc}${res.text}`.replace(/^\s+/, '');
    onStream(index, acc);
    if (res.usage?.completion_tokens) {
      log('info', `第${index + 1}段 第${call + 1}次调用：输出 ${res.usage.completion_tokens} tokens`);
    } else {
      log('info', `第${index + 1}段 第${call + 1}次调用完成（${countWords(res.text)} 字）`);
    }
    if (res.text.length < 120) {
      warnings.push('模型单次返回过短，可能触发了输出限制');
      break;
    }
  }

  return { text: acc.trim(), warnings };
}

async function emitChunked(text: string, onChunk: (partial: string) => void, signal?: AbortSignal, size = 72, delay = 14): Promise<void> {
  let cursor = 0;
  while (cursor < text.length) {
    ensureAlive(signal);
    cursor = Math.min(text.length, cursor + size);
    onChunk(text.slice(0, cursor));
    await sleep(delay);
  }
}

/* ---------------------------------------------------------------- 主流程 */

export async function runPipeline(input: RunInput, options: PipelineOptions, hooks: PipelineHooks): Promise<RunOutcome> {
  const live = isApiConfigured(options.api);
  const targetTier: TargetTier = targetTierById(options.targetTierId);
  const logs: LogEntry[] = [];
  const log = (agent: AgentId | 'system', level: LogEntry['level'], text: string) => {
    const entry = makeLog(agent, level, text);
    logs.push(entry);
    hooks.onLog(entry);
  };

  const progress: ProgressState = { percent: 0, label: '准备中…', active_segment: 0, total_segments: 0 };
  const setProgress = (patch: Partial<ProgressState>) => {
    Object.assign(progress, patch);
    hooks.onProgress({ ...progress });
  };

  let segments: SegmentDraft[] = [];
  let agent1!: Agent1Payload;
  let agent2!: Agent2Payload;
  let memoryBanner = '';

  try {
    hooks.onEngine(live ? 'live' : 'simulation');
    log('system', 'info', live ? `引擎：真实模型 ${options.api.model}` : '引擎：内置仿真引擎（未配置 API Key）');
    if (!live) {
      log('system', 'warn', '未检测到 API Key：全部文案由确定性仿真引擎生成，仅用于结构与流程演示。');
    }

    /* ---------------------------------------------------- Agent 1 */
    let a1: Agent1Payload | null = options.existing?.agent1 ?? null;
    if (a1) {
      log('system', 'info', '复用已确认的卡点载荷，跳过 Agent 01（保护用户已编辑的蓝图）。');
      hooks.onAgent1(a1);
      hooks.onAgent('agent1', 'pass');
      setProgress({ label: `Agent 01 复用 · ${a1.total_char_count.toLocaleString()} 字`, percent: 8 });
    } else {
    hooks.onAgent('agent1', 'running');
    setProgress({ label: 'Agent 01 · 清洗平台噪音并锚定卡点…', percent: 2 });
    ensureAlive(options.signal);

    const stripped = stripNoise(input.text);
    if (!stripped.text.trim()) throw new Error('输入为空：请粘贴卡点前文或载入内置样本。');
    const paywallDetected = /(解锁|会员|VIP|付费|未完待续)/.test(input.text);
    if (stripped.removed.length) {
      log('agent1', 'info', `已剥离平台噪音：${stripped.removed.join('、')}`);
    }

    a1 = deterministicAgent1(stripped.text, input.sourceType, stripped.removed, paywallDetected);
    if (live && stripped.text.length <= 6000) {
      try {
        const res = await callLLM(options.api, {
          system: AGENT_SPECS[0].system_prompt,
          user: `source_type=${input.sourceType}\n下面是需要清洗的原始文本：\n\n${stripped.text}`,
          json: true,
          temperature: 0.1,
          maxTokens: Math.min(8192, Math.max(2048, Math.round(stripped.text.length * 1.6))),
          signal: options.signal,
        });
        const raw = parseJsonLoose<Record<string, unknown>>(res.text);
        if (raw) {
          a1 = coerceAgent1(raw, {
            cleanedText: stripped.text,
            sourceType: input.sourceType,
            noiseRemoved: stripped.removed,
            paywallDetected,
          });
          log('agent1', 'pass', `LLM 语义清洗完成：${a1.total_char_count} 字 · ${a1._meta.paragraphs} 段`);
        } else {
          log('agent1', 'warn', 'Agent1 返回内容不是合法 JSON，已回退确定性清洗结果。');
        }
      } catch (err) {
        log('agent1', 'warn', `Agent1 LLM 清洗失败，使用确定性结果：${err instanceof Error ? err.message : String(err)}`);
        a1 = deterministicAgent1(stripped.text, input.sourceType, stripped.removed, paywallDetected);
      }
    } else if (live) {
      log('agent1', 'info', '前文超过 6,000 字，跳过 LLM 清洗以控制成本，直接使用确定性清洗。');
    }
    hooks.onAgent1(a1);
    hooks.onAgent('agent1', 'pass');
    }

    agent1 = a1;
    // 示例模式只在仿真引擎下启用：示例脚本是人工定稿，目标字数必须以脚本实际长度校准，
    // 否则门禁会拿“7500 字档位”去卡一篇 1,800 字的示例，产生假 REJECT。
    const sampleMode = !live && looksLikeSample(a1.cleaned_text);
    const sampleTargets = sampleMode ? [1, 2, 3].map((i) => countWords(SAMPLE_CONTINUATION[i] ?? '')) : [];
    const sampleScriptWords = sampleTargets.reduce((n, w) => n + w, 0);
    const planWords = sampleMode ? sampleScriptWords : targetTier.totalWords;
    const tierReason = routeReason(a1.length_tier, a1.total_char_count);
    log('agent1', 'info', `体量路由：${a1._meta.tier_label} · ${tierReason}`);
    setProgress({
      label: `Agent 01 完成 · ${a1.total_char_count.toLocaleString()} 字 · ${a1._meta.tier_label}`,
      percent: 8,
    });

    /* ---------------------------------------------------- Agent 2 */
    let a2: Agent2Payload | null = options.existing?.agent2 ?? null;
    if (a2) {
      log('system', 'info', '复用已确认的四拍蓝图，跳过 Agent 02（保护蓝图编辑）。');
      setProgress({ label: `Agent 02 复用 · ${a2.segment_outlines.length} 段蓝图`, percent: 12 });
      hooks.onAgent('agent2', 'pass');
    } else {
    hooks.onAgent('agent2', 'running');
    ensureAlive(options.signal);
    const planMode = planModeOf(a1.length_tier);
    const fallbackBible = buildFallbackBible(a1, options.direction);
    const bait = classifyBait(a1.ending_anchor, a1.cleaned_text);
    const fallbackOutlines = buildSegmentPlan({
      tier: a1.length_tier,
      targetWords: planWords,
      direction: options.direction,
      baitType: bait.bait_type,
      protagonist: fallbackBible.characters[0].name,
      antagonist: fallbackBible.characters[1].name,
      payoffMandate: bait.first_800w_payoff_mandate,
    });

    setProgress({ label: 'Agent 02 · 识别诱饵并推演四拍蓝图…', percent: 12 });
    if (live) {
      try {
        const res = await callLLM(options.api, {
          system: AGENT_SPECS[1].system_prompt,
          user: `# 用户走向指令
${options.direction.trim() || '（空）请自主推演最解气走向'}
# 目标续写字数
${planWords} 字（${targetTier.label}）
# length_tier
${a1.length_tier}（${tierReason}）
# 卡点锚点（末尾 300 字）
${a1.ending_anchor}
# 前文正文（共 ${a1.total_char_count} 字）
${a1.cleaned_text.slice(0, 6000)}`,
          json: true,
          temperature: 0.6,
          maxTokens: Math.min(6144, Math.max(2048, a1.total_char_count > 4000 ? 4096 : 3072)),
          signal: options.signal,
        });
        const raw = parseJsonLoose<Record<string, unknown>>(res.text);
        if (raw && Object.keys(asRecord(raw)).length) {
          a2 = coerceAgent2(raw, {
            bible: fallbackBible,
            outlines: fallbackOutlines,
            targetWords: planWords,
            planMode,
            routeReason: tierReason,
          });
          log('agent2', 'pass', `LLM 蓝图生成完成：${a2.segment_outlines.length} 段 · 诱饵 ${a2.story_bible.bait_type}`);
        } else {
          log('agent2', 'warn', 'Agent2 返回内容不是合法 JSON，改用确定性蓝图。');
        }
      } catch (err) {
        log('agent2', 'warn', `Agent2 LLM 失败，改用确定性蓝图：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!a2) {
      a2 = {
        story_bible: fallbackBible,
        segment_outlines: fallbackOutlines,
        _meta: { plan_mode: planMode, judged_by: 'code', route_reason: tierReason },
      };
      log('agent2', 'info', `确定性蓝图：${fallbackOutlines.length} 段 / 合计 ${fallbackOutlines.reduce((n, o) => n + o.target_words, 0)} 字`);
    }
    hooks.onAgent2(a2);
    }
    agent2 = a2;
    if (sampleMode) {
      a2.segment_outlines = a2.segment_outlines.map((outline, i) => ({
        ...outline,
        target_words: sampleTargets[i] ?? outline.target_words,
      }));
      agent2 = a2;
      log('system', 'info', `示例脚本校准：三段目标字数 ${sampleTargets.join(' / ')}（合计 ${sampleScriptWords}）`);
    }

    /* ------------------------------------------------ 初始化段落 */
    segments = a2.segment_outlines.map((o) => ({
      segment_index: o.segment_index,
      segment_role: o.segment_role,
      title: o.title_hint || o.segment_role,
      text: '',
      word_count: 0,
      status: 'pending',
      attempts: 0,
      warnings: [],
      source: live ? 'llm' : 'simulation',
    }));
    hooks.onSegments([...segments]);
    setProgress({ total_segments: segments.length });
    hooks.onAgent('agent2', 'pass');

    if (options.planOnly) {
      setProgress({
        percent: 100,
        label: `蓝图已生成：${a2.segment_outlines.length} 段 / 合计约 ${a2.segment_outlines.reduce((n, o) => n + o.target_words, 0)} 字`,
      });
      log('system', 'pass', 'Agent 02 完成，等待确认蓝图后启动主笔。');
      return { aborted: false, segments, agent1, agent2, logs, progress, memoryBanner };
    }

    if (sampleMode) {
      log('system', 'info', '检测到内置示例文本：将使用内置示例续写脚本，并在界面标注“示例脚本”。');
    }

    /* ------------------------------------------------ 逐段撰写 + 门禁 */
    const summaries: string[] = [];
    let revision = '';

    for (let i = 0; i < a2.segment_outlines.length; i++) {
      ensureAlive(options.signal);
      const outline = a2.segment_outlines[i];
      const prevSegment = i > 0 ? segments[i - 1] : null;
      const previousTail = prevSegment ? tailChars(prevSegment.text, 60) : tailChars(a1.ending_anchor, 60);

      const contextWindow =
        i === 0 && a1.total_char_count <= 5500
          ? a1.cleaned_text
          : [
              `[Story Bible] ${a2.story_bible.characters.map((c) => `${c.name}(${c.role})`).join('、')}`,
              `[前情摘要] ${summaries.join(' ／ ') || '紧接卡点'}`,
              `[紧邻前文 1,500 字] ${i === 0 ? tailChars(a1.cleaned_text, 1500) : tailChars(segments[i - 1].text, 1500)}`,
            ].join('\n');

      memoryBanner =
        i === 0 && a1.total_char_count <= 5500
          ? `前文仅 ${a1.total_char_count.toLocaleString()} 字，已注入 100% 完整原文（滑动窗口首段策略）`
          : `已注入 [Story Bible] + 前 ${i} 段事实摘要 + 紧邻上文 1,500 字切片`;
      hooks.onMemory(memoryBanner);

      hooks.onAgent('agent3', 'running');
      hooks.onAgent('agent4', 'idle');
      const segment = segments[i];
      let attempts = 0;
      let accepted = false;
      revision = '';

      while (!accepted) {
        ensureAlive(options.signal);
        attempts += 1;
        segment.attempts = attempts;
        segment.status = 'writing';
        hooks.onStream(i, '');
        hooks.onSegments([...segments]);
        setProgress({
          active_segment: i + 1,
          percent: Math.min(12 + Math.round(((i + 0.15) / segments.length) * 84), 94),
          label: `Agent 03 · 第 ${i + 1}/${segments.length} 段：${outline.title_hint || outline.segment_role}${
            attempts > 1 ? `（第 ${attempts} 次返工）` : ''
          }`,
        });

        let text = '';
        let source: SegmentDraft['source'] = live ? 'llm' : 'simulation';
        const warnings: string[] = [];

        const canned = sampleMode ? SAMPLE_CONTINUATION[i + 1] : undefined;
        if (canned) {
          text = canned;
          source = 'sample';
          log('agent3', 'info', `第 ${i + 1} 段使用内置示例脚本（${countWords(canned)} 字）`);
          await emitChunked(canned, (partial) => hooks.onStream(i, partial), options.signal, 96, 8);
        } else if (live) {
          try {
            const res = await writeWithLLM({
              api: options.api,
              live,
              sample: false,
              outline,
              index: i,
              total: a2.segment_outlines.length,
              bible: a2.story_bible,
              agent1: a1,
              contextWindow,
              previousTail,
              direction: options.direction,
              revision,
              signal: options.signal,
              onStream: hooks.onStream,
              log: (level, msg) => log('agent3', level, msg),
            });
            text = res.text;
            warnings.push(...res.warnings);
            if (countWords(text) < 200) throw new Error('模型输出过短');
          } catch (err) {
            if (err instanceof AbortedError) throw err;
            log('agent3', 'error', `第 ${i + 1} 段 LLM 撰写失败：${err instanceof Error ? err.message : String(err)}`);
            log('agent3', 'warn', '已自动降级为仿真引擎续跑该段，流程不中断。');
            source = 'simulation';
            text = simulateSegment({
              outline,
              index: i,
              total: a2.segment_outlines.length,
              bible: a2.story_bible,
              agent1: a1,
              direction: options.direction,
              previousTail: contextWindow,
            });
            await emitChunked(text, (partial) => hooks.onStream(i, partial), options.signal, 96, 10);
          }
        } else {
          text = simulateSegment({
            outline,
            index: i,
            total: a2.segment_outlines.length,
            bible: a2.story_bible,
            agent1: a1,
            direction: options.direction,
            previousTail: contextWindow,
          });
          await emitChunked(text, (partial) => hooks.onStream(i, partial), options.signal, 96, 10);
        }

        segment.text = text;
        segment.word_count = countWords(text);
        segment.source = source;
        segment.warnings = warnings;
        hooks.onStream(i, text);

        /* ---------------------------------------- Agent 4 门禁 */
        hooks.onAgent('agent3', 'pass');
        hooks.onAgent('agent4', 'running');
        setProgress({
          active_segment: i + 1,
          percent: Math.min(12 + Math.round(((i + 0.8) / segments.length) * 84), 96),
          label: `Agent 04 · 第 ${i + 1} 段六道商业门禁校验…`,
        });

        const codeGate = evaluateGates({
          draft: text,
          outline,
          index: i,
          total: a2.segment_outlines.length,
          bible: a2.story_bible,
          agent1: a1,
          previousTail: i === 0 ? tailChars(a1.cleaned_text, 1500) : tailChars(segments[i - 1].text, 1500),
        });

        let gate = codeGate;
        if (live && options.reviewWithLLM && source !== 'sample') {
          try {
            const res = await callLLM(options.api, {
              system: AGENT_SPECS[3].system_prompt,
              user: `# Story Bible\n${JSON.stringify(a2.story_bible).slice(0, 1500)}
# 本段四拍细纲\n${JSON.stringify(outline.beats)}
# 上文结尾锚点\n${tailChars(a1.cleaned_text, 200)}
# 本段正文\n${text.slice(0, 6000)}`,
              json: true,
              temperature: 0.2,
              maxTokens: 1200,
              signal: options.signal,
            });
            gate = mergeLLMReview(codeGate, coerceLLMReview(parseJsonLoose(res.text)));
            log('agent4', 'info', `第 ${i + 1} 段已叠加 LLM 复审（代码判定仍为权威）`);
          } catch (err) {
            log('agent4', 'warn', `LLM 复审失败，仅使用确定性门禁：${err instanceof Error ? err.message : String(err)}`);
          }
        }

        segment.gate = gate;
        const canRetry = gate.status === 'REJECT' && source !== 'sample' && attempts <= options.maxRevision;

        if (canRetry) {
          segment.status = 'rejected';
          hooks.onAgent('agent4', 'reject');
          hooks.onSegments([...segments]);
          log('agent4', 'reject', `第 ${i + 1} 段门禁未通过：${gate.revision_instructions.join('；')}`);
          revision = gate.revision_instructions.join('\n');
          await sleep(120);
          continue;
        }

        segment.status = gate.status === 'PASS' ? 'pass' : 'forced';
        if (segment.status === 'forced') {
          segment.warnings.push(...gate.revision_instructions);
          log('agent4', 'warn', `第 ${i + 1} 段已达返工上限，按当前稿保留（存在未通过门禁）。`);
        } else {
          log('agent4', 'pass', `第 ${i + 1} 段通过六道门禁（${gate.actual_word_count} 字 · 重复率 ${(gate._meta.repeat_ratio * 100).toFixed(1)}%）`);
        }
        hooks.onAgent('agent4', 'pass');
        summaries.push(gate.summary_for_next_segment);
        accepted = true;
        hooks.onSegments([...segments]);
        setProgress({
          percent: Math.min(12 + Math.round(((i + 1) / segments.length) * 84), 96),
          label: `第 ${i + 1}/${segments.length} 段完成`,
        });
      }
    }

    setProgress({ percent: 100, label: '全部段落撰写与质检完成', active_segment: segments.length });
    hooks.onMemory('全段落完成：Story Bible、四拍蓝图与门禁报告均已固化，可导出交付。');
    log('system', 'pass', `流水线完成：${segments.length} 段 / ${segments.reduce((n, s) => n + s.word_count, 0)} 字`);
    hooks.onAgent('agent3', 'pass');
    hooks.onAgent('agent4', segments.every((s) => s.status === 'pass') ? 'pass' : 'reject');

    return { aborted: false, segments, agent1, agent2, logs, progress, memoryBanner };
  } catch (err) {
    if (err instanceof AbortedError) {
      log('system', 'warn', '用户中止了流水线，已完成的内容已保留。');
      hooks.onAgent('agent3', 'idle');
      hooks.onAgent('agent4', 'idle');
      setProgress({ label: '已中止（已完成内容已保留）' });
      if (!agent1 || !agent2) throw err;
      return { aborted: true, segments, agent1, agent2, logs, progress, memoryBanner };
    }
    log('system', 'error', err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/** 供 UI 计算：需要写入磁盘的完整字数 */
export function totalProducedWords(segments: SegmentDraft[]): number {
  return segments.reduce((n, s) => n + s.word_count, 0);
}

/** 供 UI 显示：当前源文本信息 */
export function describeSource(text: string): { chars: number; paragraphs: number; tier: LengthTier } {
  const cleaned = stripNoise(text).text;
  const chars = countWords(cleaned);
  return {
    chars,
    paragraphs: cleaned.split(/\n+/).filter(Boolean).length,
    tier: resolveLengthTier(chars),
  };
}

export { countChars, extractEndingAnchor };

/* ------------------------------------------------------- 单段局部重写 */

export interface RewriteArgs {
  api: ApiConfig;
  agent1: Agent1Payload;
  agent2: Agent2Payload;
  segments: SegmentDraft[];
  index: number;
  instruction: string;
  signal?: AbortSignal;
  onStream: (text: string) => void;
}

export interface RewriteResult {
  text: string;
  gate: GateResult;
  source: SegmentDraft['source'];
  warnings: string[];
}

export async function rewriteOneSegment(args: RewriteArgs): Promise<RewriteResult> {
  const { api, agent1, agent2, segments, index, instruction, signal, onStream } = args;
  const outline = agent2.segment_outlines[index];
  const prevTail = index === 0 ? tailChars(agent1.cleaned_text, 1200) : tailChars(segments[index - 1]?.text || agent1.cleaned_text, 1200);
  const current = segments[index]?.text ?? '';
  const userNote = instruction.trim() || '增强冲突张力与打脸爽感，对话更犀利';
  const warnings: string[] = [];
  let text = '';
  let source: SegmentDraft['source'] = 'simulation';

  if (isApiConfigured(api)) {
    try {
      // 与主笔同一套微步长策略：单次调用若被 max_tokens 截断就继续接力，
      // 否则长段重写（>2,500 字）会被硬生生砍掉一半。
      let acc = '';
      const maxCalls = Math.min(4, Math.max(1, Math.ceil(outline.target_words / 1200)));
      for (let call = 0; call < maxCalls; call++) {
        if (signal?.aborted) throw new Error('已取消');
        const written = countWords(acc);
        if (call > 0 && written >= outline.target_words * 0.92) break;
        const need = Math.max(300, outline.target_words - written + 60);
        const prompt =
          call === 0
            ? `# 任务
你正在对第 ${index + 1} 段【${outline.segment_role}】执行【局部外科手术式重写】，只重写这一段，不影响其它段落。
用户修改意见：【${userNote}】
约 ${outline.target_words} 字。

# 必须保留的四拍节点
起：${outline.beats.qi}
承：${outline.beats.cheng}
转：${outline.beats.zhuan}
合：${outline.beats.he}

# 紧邻上文末尾（重写后的第一句必须接住它）
${prevTail}

# 原稿（可参考，不必保留原句）
${current.slice(0, 3000)}

# 输出
只输出重写后的完整本段正文，不要标题、不要字数说明、不要修改说明。`
            : buildContinuePrompt(acc, need);

        let received = '';
        const res = await callLLM(api, {
          system: AGENT_SPECS[2].system_prompt,
          user: prompt,
          temperature: api.temperature,
          maxTokens: estimateMaxTokens(call === 0 ? outline.target_words : need, api.maxTokens),
          signal,
          onDelta: (chunk) => {
            received += chunk;
            onStream(acc + received);
          },
        });
        acc += res.text;
        onStream(acc);
      }
      text = acc.trim();
      source = 'llm';
      if (countWords(text) < outline.target_words * 0.7) {
        warnings.push('重写稿字数偏少，可能被输出上限截断');
      }
    } catch (err) {
      warnings.push(`LLM 重写失败，已降级为仿真引擎：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!text.trim()) {
    text = simulateSegment({
      outline,
      index,
      total: agent2.segment_outlines.length,
      bible: agent2.story_bible,
      agent1,
      direction: userNote,
      previousTail: prevTail,
    });
    await emitChunked(text, onStream, signal, 96, 8);
  }

  const gate = evaluateGates({
    draft: text,
    outline,
    index,
    total: agent2.segment_outlines.length,
    bible: agent2.story_bible,
    agent1,
    previousTail: prevTail,
  });

  return { text, gate, source, warnings };
}
