/**
 * 首页静态示例：展示一份「已经完成」的示例稿（含六道门禁结果），
 * 让访客看到成品形态，但**不假装在跑流水线**。
 *
 * 数据来自内置样本 + 人工写好的续写脚本，门禁结果由真实门禁引擎现算，
 * 因此展示的 PASS/FAIL 和真实运行完全一致。
 */
import type { Agent1Payload, Agent2Payload, SegmentDraft } from '../types';
import { SAMPLE_CONTINUATION, SAMPLE_TEXT } from './presets';
import { classifyBait, countWords, extractEndingAnchor, extractEntities } from '../lib/text';
import { buildFallbackBible, buildSegmentPlan, resolveLengthTier } from '../lib/router';
import { evaluateGates } from '../lib/gates';

export interface ShowcaseData {
  agent1: Agent1Payload;
  agent2: Agent2Payload;
  segments: SegmentDraft[];
}

let cached: ShowcaseData | null = null;

export function buildShowcase(): ShowcaseData {
  if (cached) return cached;

  const anchor = extractEndingAnchor(SAMPLE_TEXT, 300);
  const total = countWords(SAMPLE_TEXT);
  const tier = resolveLengthTier(total);
  const agent1: Agent1Payload = {
    source_type: 'raw_text',
    cleaned_text: SAMPLE_TEXT,
    total_char_count: total,
    length_tier: tier,
    ending_anchor: anchor,
    paywall_detected: false,
    _meta: {
      paragraphs: SAMPLE_TEXT.split(/\n+/).filter(Boolean).length,
      noise_removed: [],
      anchor_entities: extractEntities(anchor, 5),
      tier_label: '黄金卡点期（2,500–6,000 字）',
      judged_by: 'code',
    },
  };

  const bible = buildFallbackBible(agent1, '绝不原谅直接复仇 · 彻底清算');
  const bait = classifyBait(anchor, SAMPLE_TEXT);
  const cannedTotal = [1, 2, 3].reduce((n, i) => n + countWords(SAMPLE_CONTINUATION[i] ?? ''), 0);
  const planned = buildSegmentPlan({
    tier,
    targetWords: cannedTotal,
    direction: '绝不原谅直接复仇 · 彻底清算',
    baitType: bait.bait_type,
    protagonist: bible.characters[0].name,
    antagonist: bible.characters[1].name,
    payoffMandate: bait.first_800w_payoff_mandate,
  });

  const segments: SegmentDraft[] = [1, 2, 3].map((index) => {
    const text = SAMPLE_CONTINUATION[index] ?? '';
    const outline = { ...planned[index - 1], target_words: countWords(text) };
    const gate = evaluateGates({
      draft: text,
      outline,
      index: index - 1,
      total: 3,
      bible,
      agent1,
      previousTail: index === 1 ? anchor : (SAMPLE_CONTINUATION[index - 1] ?? '').slice(-1200),
    });
    return {
      segment_index: index,
      segment_role: outline.segment_role,
      title: outline.title_hint || outline.segment_role,
      text,
      word_count: countWords(text),
      status: gate.status === 'PASS' ? 'pass' : 'forced',
      gate,
      attempts: 1,
      warnings: gate.revision_instructions,
      source: 'sample',
    };
  });

  const agent2: Agent2Payload = {
    story_bible: bible,
    segment_outlines: planned,
    _meta: {
      plan_mode: 'three_stage',
      judged_by: 'code',
      route_reason: `前文 ${total.toLocaleString()} 字，正处付费墙边缘（30%–45%）→ 标准商业三段式。`,
    },
  };

  cached = { agent1, agent2, segments };
  return cached;
}
