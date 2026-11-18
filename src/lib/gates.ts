/**
 * 六道商业门禁 —— 确定性判定引擎（PRD §4.4）。
 *
 * 设计原则：**门禁的判定权在代码，不在模型。**
 * v4.0 原型里 Agent 4 恒返回 PASS，六道门禁实际只实现了"套话子串匹配"一条。
 * 这里把六条全部落成可复现、可单测的硬判定：
 *   1 字数达标        → countWords ≥ target × 85%
 *   2 前 800 字兑现   → 实体/主语 + 兑现动词 + 无回忆杀开场
 *   3 人设与视角     → 人称代词占比 + 至少一个反派实体现身
 *   4 物理无缝衔接   → 无标题残留、无元叙述、不复制上文末尾
 *   5 去 AI 套话     → 黑名单命中为 0 且 10-gram 重复率 < 18%
 *   6 终局金句       → 末句 8–60 字、陈述句、非"未完待续"
 */

import type { Agent1Payload, GateFlags, GateResult, SegmentOutline, StoryBible } from '../types';
import { AI_CLICHES } from '../config/presets';
import {
  countWords,
  lastSentence,
  repeatRatio,
  splitParagraphs,
  splitSentences,
  trimQuotes,
} from './text';

export const GATE_ORDER: (keyof GateFlags)[] = [
  'word_count_ok',
  'instant_payoff_800_ok',
  'character_pov_ok',
  'seamless_bridge_ok',
  'anti_cliche_ok',
  'golden_ending_ok',
];

export interface GateContext {
  draft: string;
  outline: SegmentOutline;
  index: number;
  total: number;
  bible: StoryBible;
  agent1: Agent1Payload;
  previousTail: string;
}

const PLACEHOLDER_NAMES = new Set(['主角', '我（主角）', '核心对手', '反派', '关键配角', '配角', '我']);

const PAYOFF_VERBS =
  /(揭晓|亮出|掏出|甩|拍|按下|说|开口|冷笑|回答|宣布|念出|指出|拆穿|打脸|播放|投影|递上|推到|摔|砸|给出|公布|抬手)/;

const DRAG_OPENERS =
  /^(那天|那一年|那晚|很多年后|回忆|说起来|讲起来|时间倒回|时间回到|三个月前|三年前的那个|很久以前)/;

const TITLE_PREFIX =
  /^(第\s*[一二三四五六七八九十百零\d]+\s*[章回节段集单元]|第\s*\d+\s*段|【[^】]{0,20}】|#{1,3}\s|\*\*|序章|尾声|上一段|上文|前文)/;

const META_PHRASES = /(续写|上一段|如前文所述|承接上文|接上文|笔者|本章完|未完待续|待续)/;

function squash(text: string): string {
  return text.replace(/\s+/g, '');
}

function collapseOverlaps(phrases: string[]): string[] {
  const uniq = [...new Set(phrases)].filter(Boolean).sort((a, b) => b.length - a.length);
  const out: string[] = [];
  for (const p of uniq) {
    if (out.some((kept) => kept.includes(p))) continue;
    out.push(p);
  }
  return out;
}

export function evaluateGates(ctx: GateContext): GateResult {
  const { draft, outline, index, total, bible, agent1, previousTail } = ctx;
  const actual = countWords(draft);
  const details: Record<keyof GateFlags, string> = {
    word_count_ok: '',
    instant_payoff_800_ok: '',
    character_pov_ok: '',
    seamless_bridge_ok: '',
    anti_cliche_ok: '',
    golden_ending_ok: '',
  };
  const instructions: string[] = [];

  const gates: GateFlags = {
    word_count_ok: false,
    instant_payoff_800_ok: false,
    character_pov_ok: false,
    seamless_bridge_ok: false,
    anti_cliche_ok: false,
    golden_ending_ok: false,
  };

  /* ---------------------------------------------------- 1. 字数达标 */
  const threshold = Math.round(outline.target_words * 0.85);
  gates.word_count_ok = actual >= threshold;
  details.word_count_ok = `实际 ${actual} 字 / 目标 ${outline.target_words} 字 / 阈值 ${threshold} 字（85%）`;
  if (!gates.word_count_ok) {
    instructions.push(
      `字数不足：当前 ${actual} 字，需至少 ${threshold} 字。请补足具体动作交锋、微表情变化与个性化台词，禁止概括式流水账。`,
    );
  }

  /* ------------------------------------------------ 2. 前 800 字兑现 */
  if (index !== 0) {
    gates.instant_payoff_800_ok = true;
    details.instant_payoff_800_ok = '非首段，本门禁不适用（PASS）';
  } else {
    const head800 = draft.slice(0, 800);
    const headFlat = squash(head800);
    const entities = agent1._meta.anchor_entities.filter((e) => e.length >= 2);
    const entityHit = entities.length === 0 ? true : entities.some((e) => headFlat.includes(e));
    const selfRef = /(我|我们)/.test(headFlat);
    const verbHit = PAYOFF_VERBS.test(headFlat);
    const dragOpen = DRAG_OPENERS.test(headFlat);
    const longEnough = headFlat.length >= 400;

    gates.instant_payoff_800_ok = (entityHit || selfRef) && verbHit && !dragOpen && longEnough;
    details.instant_payoff_800_ok = [
      `前800字长度 ${headFlat.length} 字`,
      entityHit ? `锚点实体命中(${entities.slice(0, 3).join('/') || '无可用实体'})` : '锚点实体未命中',
      verbHit ? '兑现动作命中' : '缺少兑现动作',
      dragOpen ? '以回忆杀开场' : '无回忆杀开场',
    ].join(' · ');
    if (!gates.instant_payoff_800_ok) {
      instructions.push(
        '首段未在前 800 字内正面兑现卡点：请直接给出结果（亮出证据/宣布决定/说出口），删掉回忆与景物铺垫。',
      );
    }
  }

  /* ------------------------------------------------ 3. 人设与视角 */
  const selfCount = (draft.match(/我/g) ?? []).length;
  const thirdCount = (draft.match(/[他她]/g) ?? []).length;
  const firstPerson = /第一人称/.test(bible.pov);
  const leadName = bible.characters.find((c) => /主角/.test(c.role))?.name ?? '';
  const leadMentions = leadName.length >= 2 && !PLACEHOLDER_NAMES.has(leadName) ? draft.split(leadName).length - 1 : 0;
  // 第三人称既可以用“他/她”叙述，也可以全程用名字，两者都算合规
  const povOk = firstPerson ? selfCount >= 3 && selfCount >= thirdCount * 0.5 : thirdCount >= 3 || leadMentions >= 3;

  const adversaryNames = bible.characters
    .filter((c) => /反派|对手/.test(c.role) && c.name.length >= 2 && !PLACEHOLDER_NAMES.has(c.name))
    .map((c) => c.name);
  const adversaryPresent = adversaryNames.length === 0 ? true : adversaryNames.some((n) => draft.includes(n));
  gates.character_pov_ok = povOk && adversaryPresent;
  details.character_pov_ok = [
    `${firstPerson ? '第一人称' : '第三人称'}校验：我×${selfCount} / 他她×${thirdCount}`,
    adversaryNames.length ? `反派实体 ${adversaryNames.join('、')} ${adversaryPresent ? '已出场' : '未出场'}` : '无具名反派',
  ].join(' · ');
  if (!gates.character_pov_ok) {
    instructions.push(
      povOk
        ? '反派实体未出场：请让对手在本段真实现身（台词或动作），不要只用代词指代。'
        : '人称视角漂移：请严格保持 Story Bible 中的人称叙述，不要中途切视角。',
    );
  }

  /* --------------------------------------------- 4. 物理无缝衔接 */
  const trimmed = draft.trimStart();
  const titleLike = TITLE_PREFIX.test(trimmed);
  const metaPhrase = META_PHRASES.test(trimmed.slice(0, 60));
  const prevTailFlat = squash(previousTail).slice(-12);
  const draftHeadFlat = squash(trimmed).slice(0, prevTailFlat.length);
  const copied = prevTailFlat.length >= 8 && draftHeadFlat === prevTailFlat;
  const startsWithPunct = /^[，。！？、；：…”»]/.test(trimmed);

  gates.seamless_bridge_ok = !titleLike && !metaPhrase && !copied && !startsWithPunct;
  details.seamless_bridge_ok = [
    titleLike ? '残留章节标题' : '无标题残留',
    metaPhrase ? '出现元叙述' : '无元叙述',
    copied ? '复制了上文末尾' : '未复制上文',
    startsWithPunct ? '以标点开头' : '首字为汉字',
  ].join(' · ');
  if (!gates.seamless_bridge_ok) {
    instructions.push(
      '首句衔接生硬：删除章节标题/元叙述，第一句直接承接上文最后一秒的动作或对话，不要复制上文原句。',
    );
  }

  /* ------------------------------------------------ 5. 去 AI 套话 */
  const blacklist = collapseOverlaps([...AI_CLICHES, ...bible.style_fingerprint.forbidden_cliches]);
  const clicheHits = blacklist.filter((p) => draft.includes(p));
  // 长稿的偶然短语重合会被放大：≥2,500 字改用 12-gram，阈值不变
  const nGram = actual >= 2500 ? 12 : 10;
  const rr = repeatRatio(draft, nGram);
  gates.anti_cliche_ok = clicheHits.length === 0 && rr < 0.18;
  details.anti_cliche_ok = [
    `套话命中 ${clicheHits.length} 处${clicheHits.length ? `（${clicheHits.slice(0, 3).join('、')}）` : ''}`,
    `${nGram}-gram 重复率 ${(rr * 100).toFixed(1)}%（阈值 18%）`,
  ].join(' · ');
  if (!gates.anti_cliche_ok) {
    instructions.push(
      clicheHits.length
        ? `删除 AI 套话：${clicheHits.slice(0, 4).join('、')}，用具体动作与台词替换。`
        : `车轱辘话注水（10-gram 重复率 ${(rr * 100).toFixed(1)}%）：请删掉复述式句子，换入新信息。`,
    );
  }

  /* ------------------------------------------------ 6. 终局金句 */
  let quote = '';
  if (index !== total - 1) {
    gates.golden_ending_ok = true;
    details.golden_ending_ok = '非终段，本门禁不适用（PASS）';
  } else {
    const paras = splitParagraphs(draft);
    const lastPara = paras.length ? paras[paras.length - 1] : '';
    const sents = splitSentences(lastPara).map(trimQuotes).filter(Boolean);
    quote = sents.length ? sents[sents.length - 1] : trimQuotes(lastPara);
    const lenOk = quote.length >= 8 && quote.length <= 60;
    const declarative = !quote.includes('？') && /[。！…]$/.test(quote);
    const notSerial = !/(未完|待续|下一章|下集)/.test(quote);
    gates.golden_ending_ok = lenOk && declarative && notSerial && lastPara.length >= 20;
    details.golden_ending_ok = [
      `末句 ${quote.length} 字`,
      lenOk ? '长度合规(8–60)' : '长度不合规',
      declarative ? '陈述句收尾' : '非陈述句/无终止标点',
      notSerial ? '无连载尾巴' : '残留连载尾巴',
    ].join(' · ');
    if (!gates.golden_ending_ok) {
      instructions.push(
        '终局金句未锁定：最后一段必须以一句 8–60 字、可截图传播的陈述性金句收尾，不要用问句或“未完待续”。',
      );
    }
  }

  const status = GATE_ORDER.every((k) => gates[k]) ? 'PASS' : 'REJECT';
  const summary = [
    `第${outline.segment_index}段（${outline.segment_role}）：`,
    `完成「${outline.beats.zhuan.slice(0, 28)}」。`,
    `结尾：${lastSentence(draft).slice(0, 46)}`,
  ].join('');

  return {
    status,
    actual_word_count: actual,
    gates,
    cliche_hits: clicheHits,
    golden_quote_extracted: quote,
    revision_instructions: instructions,
    summary_for_next_segment: summary.slice(0, 150),
    _meta: {
      details,
      judged_by: 'code',
      repeat_ratio: rr,
    },
  };
}

/**
 * 合并可选的 LLM 复审：**代码判定永远是权威**。
 * 模型只能补充修改指令与摘要，不能把代码判 FAIL 的段落放行（防止无限返工与"放水"）。
 */
export function mergeLLMReview(
  codeGate: GateResult,
  review: {
    status?: string;
    gates?: Partial<Record<keyof GateFlags, boolean>>;
    cliche_hits?: string[];
    revision_instructions?: string[];
    summary_for_next_segment?: string;
    golden_quote_extracted?: string;
  } | null,
): GateResult {
  if (!review) return codeGate;

  const extra = (review.revision_instructions ?? []).filter((t) => t && t.trim().length > 2).slice(0, 4);
  const modelDisagrees = String(review.status ?? '').toUpperCase() === 'REJECT' && codeGate.status === 'PASS';

  const details = { ...codeGate._meta.details };
  if (modelDisagrees) {
    details.anti_cliche_ok = `${details.anti_cliche_ok} · 模型复审建议 REJECT`;
  }

  return {
    ...codeGate,
    revision_instructions: [...codeGate.revision_instructions, ...extra],
    summary_for_next_segment: (review.summary_for_next_segment ?? '').trim() || codeGate.summary_for_next_segment,
    cliche_hits: codeGate.cliche_hits.length ? codeGate.cliche_hits : (review.cliche_hits ?? []),
    _meta: {
      ...codeGate._meta,
      details,
      judged_by: 'code+llm',
    },
  };
}

export function gateScore(gate: GateResult): number {
  const passed = GATE_ORDER.filter((k) => gate.gates[k]).length;
  return Math.round((passed / GATE_ORDER.length) * 100);
}
