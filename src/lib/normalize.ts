/** 上游载荷归一化：模型输出永远不可信，所有字段都要兜底与量纲校正。 */

import type {
  Agent1Payload,
  LengthTier,
  Agent2Payload,
  CharacterCard,
  GateFlags,
  GateResult,
  SegmentOutline,
  SourceType,
  StoryBible,
  StyleFingerprint,
} from '../types';
import { asArray, asBool, asNumber, asRecord, asString, asStringArray } from './json';
import { countWords, extractEndingAnchor, extractEntities, clamp } from './text';
import { LENGTH_TIER_LABEL } from '../config/presets';
import { resolveLengthTier, summarizeForNext } from './router';

export interface Agent1Fallback {
  cleanedText: string;
  sourceType: SourceType;
  noiseRemoved: string[];
  paywallDetected: boolean;
}

export function coerceAgent1(raw: unknown, fallback: Agent1Fallback): Agent1Payload {
  const rec = asRecord(raw);
  let cleaned = asString(rec.cleaned_text ?? rec.cleanedText, '').trim();
  const judgedBy: Agent1Payload['_meta']['judged_by'] = 'llm';

  // 内容保真校验：模型不允许压缩/摘要正文
  const fallbackLen = fallback.cleanedText.length;
  if (!cleaned || (fallbackLen > 400 && cleaned.length < fallbackLen * 0.55)) {
    cleaned = fallback.cleanedText;
  } else if (cleaned.length > fallbackLen * 1.35) {
    cleaned = fallback.cleanedText;
  }

  const total = countWords(cleaned);
  // 体量路由只认代码算出来的字数：模型上报的 total_char_count / length_tier 一律不采信
  const tier: LengthTier = resolveLengthTier(total);

  const declaredAnchor = asString(rec.ending_anchor, '').trim();
  const anchor =
    declaredAnchor.length >= 60 && cleaned.includes(declaredAnchor.slice(0, 40))
      ? declaredAnchor
      : extractEndingAnchor(cleaned, 300);

  return {
    source_type: (asString(rec.source_type, fallback.sourceType) as SourceType) ?? fallback.sourceType,
    cleaned_text: cleaned,
    total_char_count: total,
    length_tier: tier,
    ending_anchor: anchor,
    paywall_detected: asBool(rec.paywall_detected, fallback.paywallDetected),
    _meta: {
      paragraphs: cleaned.split(/\n+/).filter(Boolean).length,
      noise_removed: fallback.noiseRemoved,
      anchor_entities: extractEntities(anchor, 5),
      tier_label: LENGTH_TIER_LABEL[tier],
      judged_by: judgedBy,
    },
  };
}

function coerceStyle(raw: unknown, fallback: StyleFingerprint): StyleFingerprint {
  const rec = asRecord(raw);
  return {
    avg_sentence_len: clamp(asNumber(rec.avg_sentence_len, fallback.avg_sentence_len), 4, 120),
    dialogue_ratio: asString(rec.dialogue_ratio, fallback.dialogue_ratio),
    tone_keywords: asStringArray(rec.tone_keywords, 6).length
      ? asStringArray(rec.tone_keywords, 6)
      : fallback.tone_keywords,
    forbidden_cliches: asStringArray(rec.forbidden_cliches, 12).length
      ? asStringArray(rec.forbidden_cliches, 12)
      : fallback.forbidden_cliches,
  };
}

function coerceCharacters(raw: unknown, fallback: CharacterCard[]): CharacterCard[] {
  const list = asArray(raw)
    .map((c) => {
      const rec = asRecord(c);
      return {
        name: asString(rec.name, '').trim(),
        role: asString(rec.role, '关键配角').trim() || '关键配角',
        traits: asString(rec.traits, '').trim(),
        current_state: asString(rec.current_state ?? rec.state, '').trim(),
      };
    })
    .filter((c) => c.name.length >= 1)
    .slice(0, 8);
  return list.length >= 2 ? list : fallback;
}

function coerceBible(raw: unknown, fallback: StoryBible): StoryBible {
  const rec = asRecord(raw);
  return {
    pov: asString(rec.pov, fallback.pov) || fallback.pov,
    bait_type: asString(rec.bait_type, fallback.bait_type) || fallback.bait_type,
    style_fingerprint: coerceStyle(rec.style_fingerprint, fallback.style_fingerprint),
    characters: coerceCharacters(rec.characters, fallback.characters),
  };
}

export interface Agent2Fallback {
  bible: StoryBible;
  outlines: SegmentOutline[];
  targetWords: number;
  planMode: Agent2Payload['_meta']['plan_mode'];
  routeReason: string;
}

export function coerceAgent2(raw: unknown, fallback: Agent2Fallback): Agent2Payload {
  const rec = asRecord(raw);
  const bible = coerceBible(rec.story_bible ?? rec.storyBible, fallback.bible);

  const rawOutlines = asArray(rec.segment_outlines ?? rec.segmentOutlines ?? rec.stage_blueprints);
  const outlines: SegmentOutline[] = [];

  rawOutlines.slice(0, 8).forEach((item, idx) => {
    const o = asRecord(item);
    const fb = fallback.outlines[Math.min(idx, fallback.outlines.length - 1)];
    const beatsRaw = asRecord(o.beats ?? o.beat_sheet);
    const target = clamp(asNumber(o.target_words ?? o.target_chars, fb?.target_words ?? 1200), 400, 6000);
    outlines.push({
      segment_index: idx + 1,
      segment_role: asString(o.segment_role, fb?.segment_role ?? `第 ${idx + 1} 段`) || `第 ${idx + 1} 段`,
      title_hint: asString(o.title_hint, fb?.title_hint ?? '') || undefined,
      target_words: Math.round(target),
      beats: {
        qi: asString(beatsRaw.qi, fb?.beats.qi ?? '前 800 字内正面兑现卡点结果。') || '前 800 字内正面兑现卡点结果。',
        cheng: asString(beatsRaw.cheng, fb?.beats.cheng ?? '反派震惊，旁观者态度倒戈。'),
        zhuan: asString(beatsRaw.zhuan, fb?.beats.zhuan ?? '反派反扑被当场反杀。'),
        he: asString(beatsRaw.he, fb?.beats.he ?? '留下指向更深秘密的过渡钩子。'),
      },
    });
  });

  // 结构完整性：段数不能少于规划，否则必然是模型偷工减料
  const finalOutlines = outlines.length >= Math.min(2, fallback.outlines.length) ? outlines : fallback.outlines;

  // 目标字数对账：偏差 > 25% 时按比例重分配，避免模型随口报数
  const planned = finalOutlines.reduce((n, o) => n + o.target_words, 0);
  if (planned > 0 && Math.abs(planned - fallback.targetWords) / fallback.targetWords > 0.25) {
    const scale = fallback.targetWords / planned;
    for (const o of finalOutlines) o.target_words = Math.max(400, Math.round(o.target_words * scale));
  }

  return {
    story_bible: bible,
    segment_outlines: finalOutlines,
    _meta: {
      plan_mode: fallback.planMode,
      judged_by: 'llm',
      route_reason: fallback.routeReason,
    },
  };
}

/* ------------------------------------------------------- LLM 复审载荷 */

export interface LLMReview {
  status: 'PASS' | 'REJECT';
  gates: Partial<Record<keyof GateFlags, boolean>>;
  cliche_hits: string[];
  revision_instructions: string[];
  summary_for_next_segment: string;
  golden_quote_extracted: string;
}

export function coerceLLMReview(raw: unknown): LLMReview | null {
  const rec = asRecord(raw);
  if (!rec || Object.keys(rec).length === 0) return null;
  const gatesRaw = asRecord(rec.gates);
  const gates: Partial<Record<keyof GateFlags, boolean>> = {};
  for (const key of [
    'word_count_ok',
    'instant_payoff_800_ok',
    'character_pov_ok',
    'seamless_bridge_ok',
    'anti_cliche_ok',
    'golden_ending_ok',
  ] as (keyof GateFlags)[]) {
    if (key in gatesRaw) gates[key] = asBool(gatesRaw[key], true);
  }
  return {
    status: asString(rec.status, 'PASS').toUpperCase() === 'REJECT' ? 'REJECT' : 'PASS',
    gates,
    cliche_hits: asStringArray(rec.cliche_hits, 8),
    revision_instructions: asStringArray(rec.revision_instructions, 6),
    summary_for_next_segment: asString(rec.summary_for_next_segment, '').slice(0, 200),
    golden_quote_extracted: asString(rec.golden_quote_extracted, ''),
  };
}

/** 供 UI 兜底：没有 Agent4 结果时构造一个"未质检"占位 */
export function pendingGateResult(targetWords: number): GateResult {
  return {
    status: 'REJECT',
    actual_word_count: 0,
    gates: {
      word_count_ok: false,
      instant_payoff_800_ok: false,
      character_pov_ok: false,
      seamless_bridge_ok: false,
      anti_cliche_ok: false,
      golden_ending_ok: false,
    },
    cliche_hits: [],
    golden_quote_extracted: '',
    revision_instructions: ['尚未质检'],
    summary_for_next_segment: '',
    _meta: {
      details: {
        word_count_ok: `目标 ${targetWords} 字，尚未生成`,
        instant_payoff_800_ok: '尚未质检',
        character_pov_ok: '尚未质检',
        seamless_bridge_ok: '尚未质检',
        anti_cliche_ok: '尚未质检',
        golden_ending_ok: '尚未质检',
      },
      judged_by: 'code',
      repeat_ratio: 0,
    },
  };
}

export function buildSummary(outline: SegmentOutline, draft: string): string {
  return summarizeForNext(outline, draft);
}
