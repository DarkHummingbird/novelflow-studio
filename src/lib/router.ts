/**
 * 按字数自动选模式 + 大纲规划（PRD §3 / §5）
 * 纯函数，可单测；不依赖模型。
 */

import type {
  Agent1Payload,
  Beats,
  CharacterCard,
  LengthTier,
  SegmentOutline,
  StoryBible,
  TargetTier,
} from '../types';
import { clamp, classifyBait, countWords, extractEntities, profileStyle } from './text';
import { AI_CLICHES } from '../config/presets';

export function resolveLengthTier(charCount: number): LengthTier {
  if (charCount < 2500) return 'EARLY_SETUP_UNDER_2500';
  if (charCount <= 6000) return 'STANDARD_PAYWALL_30_45_PCT';
  return 'LONG_FORM_SERIAL_OVER_6000';
}

export function routeReason(tier: LengthTier, charCount: number): string {
  switch (tier) {
    case 'EARLY_SETUP_UNDER_2500':
      return `前文仅 ${charCount.toLocaleString()} 字，未抵达 30% 主卡点 → 切换“蓄势引爆”策略。`;
    case 'STANDARD_PAYWALL_30_45_PCT':
      return `前文 ${charCount.toLocaleString()} 字，正处付费墙边缘（30%–45%）→ 标准商业三段式。`;
    default:
      return `前文 ${charCount.toLocaleString()} 字，超长文本 → 启用 分单元滚动。`;
  }
}

export type PlanMode = 'three_stage' | 'early_setup' | 'arc_units';

export function planModeOf(tier: LengthTier): PlanMode {
  if (tier === 'EARLY_SETUP_UNDER_2500') return 'early_setup';
  if (tier === 'LONG_FORM_SERIAL_OVER_6000') return 'arc_units';
  return 'three_stage';
}

export const ARC_UNIT_WORDS = 3500;

/** 把总字数按权重切分，保证每段 ≥ minWords，总和≈total */
export function distributeTargets(total: number, weights: number[], minWords = 800): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  let targets = weights.map((w) => Math.max(minWords, Math.round((total * w) / sum)));
  // 修正累计误差，把余量塞进最长的一段
  const diff = total - targets.reduce((a, b) => a + b, 0);
  if (diff !== 0) {
    const idx = targets.indexOf(Math.max(...targets));
    targets = targets.map((t, i) => (i === idx ? Math.max(minWords, t + diff) : t));
  }
  return targets;
}

export interface PlanInput {
  tier: LengthTier;
  targetWords: number;
  direction: string;
  baitType: string;
  protagonist: string;
  antagonist: string;
  payoffMandate: string;
}

export function buildSegmentPlan(input: PlanInput): SegmentOutline[] {
  const { tier, targetWords, direction, baitType, protagonist, antagonist, payoffMandate } = input;
  const dir = direction.trim() || '绝不原谅 · 彻底清算';

  if (tier === 'LONG_FORM_SERIAL_OVER_6000') {
    const units = clamp(Math.round(targetWords / ARC_UNIT_WORDS), 2, 6);
    const perUnit = Math.round(targetWords / units);
    return Array.from({ length: units }, (_, i) => {
      const isLast = i === units - 1;
      const beats: Beats = isLast
        ? {
            qi: `起（全账清算）：把所有 OPEN 伏笔一次性回收，${antagonist} 的最后一张底牌被当众掀翻。`,
            cheng: `承（迟来的悔恨）：昔日背叛者痛哭求宽恕，${protagonist} 一句话冷淡拒绝。`,
            zhuan: `转（主角涅槃）：${protagonist} 拿回属于自己的一切，事业与人生进入新阶段。`,
            he: `合（400 字金句收尾）：情绪彻底闭合，以一句极具截图传播度的金句收尾。`,
          }
        : {
            qi: `起（兑现上一单元卡点）：直接给出上一单元留白的结果，不切视角、不回忆杀。`,
            cheng: `承（阶段性反击）：${protagonist} 拆掉 ${antagonist} 的一层底牌，旁观者态度倒戈。`,
            zhuan: `转（抛出新危机）：更大的对手或更深的秘密浮出水面，${dir}的走向开始兑现。`,
            he: `合（卷末卡点）：动作已发生、结果留白，勾住下一单元的付费点。`,
          };
      return {
        segment_index: i + 1,
        segment_role: isLast
          ? `第 ${i + 1} 单元 · 全部收尾`
          : `第 ${i + 1} 单元 · 一个小高潮`,
        title_hint: isLast ? '终局清算' : `情绪单元 ${i + 1}`,
        target_words: perUnit,
        beats,
      };
    });
  }

  const early = tier === 'EARLY_SETUP_UNDER_2500';
  const weights = early ? [0.45, 0.3, 0.25] : [0.27, 0.4, 0.33];
  const [t1, t2, t3] = distributeTargets(targetWords, weights);

  return [
    {
      segment_index: 1,
      segment_role: early
        ? '第 1 段 · 先把情绪垫足，再当场给结果'
        : '第 1 段 · 开头就把结果给出来',
      title_hint: early ? '蓄势引爆' : '当众兑现',
      target_words: t1,
      beats: {
        qi: early
          ? `起（蓄势 · ${baitType}）：补全前文缺失的压抑与伏笔，把情绪推高到主付费卡点，并在前 800 字内当场引爆。`
          : `起（前 800 字硬兑现 · ${baitType}）：${payoffMandate} 必须正面揭晓结果，不切视角、不回忆杀。`,
        cheng: `承（利息放大）：${antagonist} 当场震惊并要求压下此事，旁观者态度开始倒戈。`,
        zhuan: `转（贯彻指令：${dir}）：${protagonist} 亮出第二层反制底牌，${antagonist} 的狡辩被当场反杀。`,
        he: `合（段末微钩子）：一通紧急来电打断僵局，${antagonist} 苦心经营的防线全面崩塌，牵出更深的秘密。`,
      },
    },
    {
      segment_index: 2,
      segment_role: '第 2 段 · 再来一次反转',
      title_hint: '二次反转',
      target_words: t2,
      beats: {
        qi: `起（600–800 字小钩子）：${antagonist} 阵营内部出现裂痕，利益同盟当场反水互相甩锅。`,
        cheng: `承（二次反转）：更深一层的幕后交易被公开投出，证据链在众人面前闭环。`,
        zhuan: `转（情绪顶点）：${protagonist} 以绝对实力碾压 ${antagonist} 最后的反扑企图。`,
        he: `合（清算降临）：执法力量推门而入，所有罪证锁定到人。`,
      },
    },
    {
      segment_index: 3,
      segment_role: '第 3 段 · 全部算清，用一句话收尾',
      title_hint: '终局清算',
      target_words: t3,
      beats: {
        qi: `起（恶人伏法）：所有涉案者依法付出代价，非法所得尽数追缴赔偿。`,
        cheng: `承（迟来的悔恨）：昔日背叛者痛哭忏悔求宽恕，被 ${protagonist} 冷淡拒绝。`,
        zhuan: `转（主角涅槃）：${protagonist} 拿回属于自己的一切，开启全新事业与人生。`,
        he: `合（400 字金句收尾）：情绪彻底闭合，以一句极具截图传播度的金句收尾。`,
      },
    },
  ];
}

/** 单次生成的目标字数上限：1,200–1,500 字黄金输出区间（PRD §5.3） */
export const MICRO_STEP_WORDS = 1300;

export function planMicroSteps(targetWords: number, step = MICRO_STEP_WORDS): number[] {
  const steps: number[] = [];
  let left = Math.max(200, targetWords);
  while (left > 0) {
    const take = Math.min(step, left);
    steps.push(take);
    left -= take;
    if (steps.length >= 8) break;
  }
  return steps;
}

/* ------------------------------------------------------- 备用方案 人物与文风设定 */

export function buildFallbackBible(a1: Agent1Payload, direction: string): StoryBible {
  const style = profileStyle(a1.cleaned_text);
  const bait = classifyBait(a1.ending_anchor, a1.cleaned_text);
  const entities = extractEntities(`${a1.ending_anchor}\n${a1.cleaned_text}`, 6);
  const antagonist = entities[0] ?? '核心对手';
  const dir = direction.trim() || '彻底清算';

  const characters: CharacterCard[] = [
    {
      name: style.pov.startsWith('第一人称') ? '我（主角）' : '主角',
      role: '主角',
      traits: '清醒、能算账、动手不留余地',
      current_state: `刚刚抛出杀手锏，停在卡点爆发前最后一秒；既定走向：${dir.slice(0, 24)}。`,
    },
    {
      name: antagonist,
      role: '反派',
      traits: '傲慢、习惯性低估对手、擅长把责任推给别人',
      current_state: '仍以为局面可控，正准备用身份或资源强行压事。',
    },
    {
      name: entities[1] ?? '关键配角',
      role: '关键配角',
      traits: '见风使舵，但掌握一段没人知道的旧事',
      current_state: '在阵营崩塌边缘，随时可能反水。',
    },
  ];

  return {
    pov: style.pov,
    bait_type: bait.bait_type,
    style_fingerprint: {
      avg_sentence_len: style.avg_sentence_len,
      dialogue_ratio: style.dialogue_ratio,
      tone_keywords: style.tone_keywords,
      forbidden_cliches: AI_CLICHES.slice(0, 8),
    },
    characters,
  };
}

export function planForPayload(a1: Agent1Payload, targetTier: TargetTier, direction: string): SegmentOutline[] {
  const bible = buildFallbackBible(a1, direction);
  const bait = classifyBait(a1.ending_anchor, a1.cleaned_text);
  return buildSegmentPlan({
    tier: a1.length_tier,
    targetWords: targetTier.totalWords,
    direction,
    baitType: bait.bait_type,
    protagonist: bible.characters[0].name,
    antagonist: bible.characters[1].name,
    payoffMandate: bait.first_800w_payoff_mandate,
  });
}

export function summarizeForNext(seg: SegmentOutline, draft: string): string {
  const tail = draft.trim().slice(-58);
  const text = `第${seg.segment_index}段（${seg.segment_role}）：${seg.beats.qi.slice(0, 34)}；结尾：${tail}`;
  return text.length <= 150 ? text : `${text.slice(0, 147)}...`;
}

export function totalPlannedWords(outlines: SegmentOutline[]): number {
  return outlines.reduce((n, o) => n + o.target_words, 0);
}

export function countDraftWords(text: string): number {
  return countWords(text);
}
