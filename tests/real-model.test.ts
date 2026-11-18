/**
 * 可选的「真实模型契约」集成测试。
 *
 * 它不自己调用模型，而是读取一份真实模型产出物（人工放置或按 §11 流程生成）：
 *   docs/evidence/real-model/agent2-blueprint.json —— 模型按 Agent2 契约产出的蓝图
 *   docs/evidence/real-model/agent3-segment1.txt   —— 模型按 Agent3 要求写出的第 1 段正文
 *
 * 然后把它交给产品自己的归一化器与六道门禁，回答一个只有真机才能回答的问题：
 * **真实模型的输出，能不能通过我们的契约与门禁？**
 *
 * 没有产物文件时自动跳过，不影响 CI。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { coerceAgent2 } from '../src/lib/normalize';
import { evaluateGates, gateScore, GATE_ORDER } from '../src/lib/gates';
import { buildFallbackBible, buildSegmentPlan, resolveLengthTier } from '../src/lib/router';
import { countWords, extractEndingAnchor, extractEntities, repeatRatio } from '../src/lib/text';
import { parseJsonLoose, safeStringify } from '../src/lib/json';
import { SAMPLE_TEXT } from '../src/config/presets';
import type { Agent1Payload } from '../src/types';

const ROOT = process.cwd();
const A2_FILE = path.join(ROOT, 'docs/evidence/real-model/agent2-blueprint.json');
const A3_FILE = path.join(ROOT, 'docs/evidence/real-model/agent3-segment1.txt');
const hasArtifacts = existsSync(A2_FILE) && existsSync(A3_FILE);

function agent1Fixture(): Agent1Payload {
  const anchor = extractEndingAnchor(SAMPLE_TEXT, 300);
  const total = countWords(SAMPLE_TEXT);
  return {
    source_type: 'raw_text',
    cleaned_text: SAMPLE_TEXT,
    total_char_count: total,
    length_tier: resolveLengthTier(total),
    ending_anchor: anchor,
    paywall_detected: false,
    _meta: {
      paragraphs: SAMPLE_TEXT.split(/\n+/).filter(Boolean).length,
      noise_removed: [],
      anchor_entities: extractEntities(anchor, 5),
      tier_label: '黄金卡点期',
      judged_by: 'code',
    },
  };
}

describe.skipIf(!hasArtifacts)('真实模型产物的契约与门禁', () => {
  it('Agent2 蓝图能通过归一化，Agent3 正文能被打分', () => {
    const a1 = agent1Fixture();
    const fallbackBible = buildFallbackBible(a1, '绝不原谅直接复仇 · 彻底清算');
    const fallbackOutlines = buildSegmentPlan({
      tier: a1.length_tier,
      targetWords: 7500,
      direction: '绝不原谅直接复仇 · 彻底清算',
      baitType: '憋屈 → 反击',
      protagonist: fallbackBible.characters[0].name,
      antagonist: fallbackBible.characters[1].name,
      payoffMandate: '前 800 字内揭晓证据',
    });

    const rawA2 = parseJsonLoose<Record<string, unknown>>(readFileSync(A2_FILE, 'utf8'));
    expect(rawA2, 'Agent2 返回的 JSON 必须能被解析').not.toBeNull();

    const a2 = coerceAgent2(rawA2, {
      bible: fallbackBible,
      outlines: fallbackOutlines,
      targetWords: 7500,
      planMode: 'three_stage',
      routeReason: '真实模型测试',
    });

    expect(a2.segment_outlines.length).toBeGreaterThanOrEqual(3);
    expect(a2.story_bible.characters.length).toBeGreaterThanOrEqual(2);

    const draft = readFileSync(A3_FILE, 'utf8').trim();
    const outline = a2.segment_outlines[0];
    const gate = evaluateGates({
      draft,
      outline,
      index: 0,
      total: a2.segment_outlines.length,
      bible: a2.story_bible,
      agent1: a1,
      previousTail: extractEndingAnchor(SAMPLE_TEXT, 1500),
    });

    const report = {
      模型蓝图段数: a2.segment_outlines.length,
      各段目标字数: a2.segment_outlines.map((o) => o.target_words),
      蓝图是否来自模型: a2._meta.judged_by,
      '正文净字数(非空白)': countWords(draft),
      '段落数': draft.split(/\n+/).filter(Boolean).length,
      '10-gram 重复率': `${(repeatRatio(draft, countWords(draft) >= 2500 ? 12 : 10) * 100).toFixed(1)}%`,
      门禁状态: gate.status,
      门禁得分: gateScore(gate),
      六道门禁: Object.fromEntries(GATE_ORDER.map((k) => [k, gate.gates[k] ? 'PASS' : 'FAIL'])),
      判定明细: gate._meta.details,
      修订指令: gate.revision_instructions,
      抽出的金句: gate.golden_quote_extracted,
    };
    console.log('\n===== 真实模型产出物评分 =====\n' + safeStringify(report, 2) + '\n');

    expect(countWords(draft)).toBeGreaterThan(300);
  });
});
