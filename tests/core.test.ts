import { describe, expect, it } from 'vitest';
import {
  classifyBait,
  countWords,
  extractEndingAnchor,
  extractEntities,
  extractGoldenQuote,
  looksLikeSample,
  profileStyle,
  repeatRatio,
  stripNoise,
} from '../src/lib/text';
import { buildFallbackBible, buildSegmentPlan, distributeTargets, planMicroSteps, resolveLengthTier } from '../src/lib/router';
import { evaluateGates, mergeLLMReview, gateScore } from '../src/lib/gates';
import { coerceAgent1, coerceAgent2 } from '../src/lib/normalize';
import { parseJsonLoose, asNumber, asStringArray } from '../src/lib/json';
import { simulateSegment } from '../src/lib/simulate';
import { buildMarkdown } from '../src/lib/export';
import { SAMPLE_TEXT, SAMPLE_CONTINUATION, TARGET_TIERS } from '../src/config/presets';
import type { Agent1Payload, Agent2Payload, ProjectState, SegmentOutline } from '../src/types';

/* ------------------------------------------------------------- helpers */

function makeAgent1(): Agent1Payload {
  return {
    source_type: 'raw_text',
    cleaned_text: SAMPLE_TEXT,
    total_char_count: countWords(SAMPLE_TEXT),
    length_tier: resolveLengthTier(countWords(SAMPLE_TEXT)),
    ending_anchor: extractEndingAnchor(SAMPLE_TEXT, 300),
    paywall_detected: false,
    _meta: {
      paragraphs: SAMPLE_TEXT.split(/\n+/).length,
      noise_removed: [],
      anchor_entities: extractEntities(extractEndingAnchor(SAMPLE_TEXT, 300), 5),
      tier_label: '黄金卡点期',
      judged_by: 'code',
    },
  };
}

function makeGateDraft(targetChars: number): string {
  // 组合式造稿：8×8×8 个互不相同的句子，避免测试夹具自己触发 10-gram 重复率门禁
  const who = ['周景深', '苏念念', '周老爷子', '坐在后排的董事', '门口的服务生', '那位律师', '技术部的人', '第三排的记者'];
  const act = [
    '把公证书推过来',
    '把手机翻过来',
    '按住桌沿',
    '撕开信封',
    '把录音笔按下',
    '把电脑转向我',
    '掏出那份复印件',
  ];
  const mood = [
    '声音压得很低',
    '手指一直在抖',
    '没有再看我一眼',
    '把话咽了回去',
    '脸色白得厉害',
  ];
  let out = [
    '我把牛皮纸袋里的东西一份一份摊开，推到周景深面前，指尖压在钢印上。',
    '“自己看。”我的声音不高，每个字都咬得很清楚，“第一页第三行，是谁的名字。”',
    '周景深伸手来抢，指尖磕在桌沿上，纸页散开成扇形。',
  ].join('\n\n');
  let i = 0;
  while (countWords(out) < targetChars && i < 500) {
    // 三个池长度 8 / 7 / 5，互质 → 组合周期 280，不会在几十句内自我重复
    const line = `${who[i % who.length]}${act[(i * 3) % act.length]}，${mood[(i * 7) % mood.length]}。`;
    out += `\n\n${line}`;
    i += 1;
  }
  out += '\n\n周景深，烂在泥里的旧梦我不捡，属于我父亲的东西，我自己拿回来。';
  return out;
}

/* --------------------------------------------------------------- 文本 */

describe('text engine', () => {
  it('字数口径为非空白字符数', () => {
    expect(countWords('你好，世界！')).toBe(6);
    expect(countWords('  A B\n\n')).toBe(2);
    expect(countWords('')).toBe(0);
    expect(countWords(SAMPLE_TEXT)).toBeGreaterThan(3000);
  });

  it('剥离平台噪音但保留正文', () => {
    const raw = [
      '我推开门，雨声灌进来。',
      '点击左下角阅读原文，看全集不迷路',
      '她把伞递给我。',
      '开通VIP会员解锁后续85%精彩内容',
      '我推开门，雨声灌进来。',
      '第18章未完待续',
      '我们一起走进电梯。',
    ].join('\n');
    const { text, removed } = stripNoise(raw);
    expect(text).toContain('我推开门');
    expect(text).toContain('她把伞递给我');
    expect(text).toContain('我们一起走进电梯');
    expect(text).not.toContain('阅读原文');
    expect(text).not.toContain('VIP');
    expect(text).not.toContain('未完待续');
    expect(removed.length).toBeGreaterThan(0);
    // 跨帧重复段应被去掉，只保留一份
    expect(text.match(/我推开门/g)?.length).toBe(1);
  });

  it('体量三档路由的边界', () => {
    expect(resolveLengthTier(1000)).toBe('EARLY_SETUP_UNDER_2500');
    expect(resolveLengthTier(2499)).toBe('EARLY_SETUP_UNDER_2500');
    expect(resolveLengthTier(2500)).toBe('STANDARD_PAYWALL_30_45_PCT');
    expect(resolveLengthTier(6000)).toBe('STANDARD_PAYWALL_30_45_PCT');
    expect(resolveLengthTier(6001)).toBe('LONG_FORM_SERIAL_OVER_6000');
    expect(resolveLengthTier(countWords(SAMPLE_TEXT))).toBe('STANDARD_PAYWALL_30_45_PCT');
  });

  it('卡点诱饵按"最近文本优先"分类', () => {
    const a1 = makeAgent1();
    const hit = classifyBait(a1.ending_anchor, a1.cleaned_text);
    expect(hit.bait_type).toBe('憋屈 → 反击');
    expect(hit.first_800w_payoff_mandate).toContain('800');

    // 前文里出现过"电话"不应污染末尾锚点的判定
    const tail = '门锁，转了半圈。';
    expect(classifyBait(tail, '我拨通了那个号码，电话那头没人接。').bait_type).toBe('死亡 → 降临');
    expect(classifyBait('照片背面那行字，是我自己的笔迹。', '').bait_type).toBe('谜题 → 答案');
  });

  it('文风指纹识别第一人称与对话占比', () => {
    const style = profileStyle(SAMPLE_TEXT);
    expect(style.pov).toContain('第一人称');
    expect(Number.parseInt(style.dialogue_ratio, 10)).toBeGreaterThan(10);
    expect(style.tone_keywords.length).toBeGreaterThan(0);
  });

  it('实体抽取能抓出故事人物', () => {
    const entities = extractEntities(extractEndingAnchor(SAMPLE_TEXT, 300), 5);
    expect(entities.join('')).toContain('周景深');
    expect(looksLikeSample(SAMPLE_TEXT)).toBe(true);
    expect(looksLikeSample('另一个人在天台上抽着烟，风很大。')).toBe(false);
  });

  it('重复率能识别车轱辘话', () => {
    const padded = '他看着我。'.repeat(60);
    const natural = SAMPLE_TEXT;
    expect(repeatRatio(padded, 10)).toBeGreaterThan(0.2);
    expect(repeatRatio(natural, 10)).toBeLessThan(0.2);
  });

  it('末尾锚点不超过 300 字且贴合原文结尾', () => {
    const anchor = extractEndingAnchor(SAMPLE_TEXT, 300);
    expect(anchor.length).toBeLessThanOrEqual(320);
    expect(SAMPLE_TEXT.trim().endsWith(anchor.slice(-20))).toBe(true);
  });

  it('金句提取返回陈述性短句', () => {
    const quote = extractGoldenQuote('前面的铺垫很长。\n\n周景深，烂在泥里的旧梦我不捡，属于我父亲的东西，我自己拿回来。');
    expect(quote).toContain('烂在泥里的旧梦');
    expect(quote.length).toBeGreaterThanOrEqual(8);
  });
});

/* --------------------------------------------------------------- 规划 */

describe('router / planner', () => {
  it('目标字数分配后总和守恒', () => {
    for (const total of [5500, 7500, 9500]) {
      const parts = distributeTargets(total, [0.27, 0.4, 0.33]);
      expect(parts).toHaveLength(3);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it('微步长接力不超过 1300 字且覆盖目标', () => {
    const steps = planMicroSteps(3600);
    expect(steps.every((s) => s <= 1300)).toBe(true);
    expect(steps.reduce((a, b) => a + b, 0)).toBe(3600);
  });

  it('三段式蓝图的三段目标字数贴近档位', () => {
    const tier = TARGET_TIERS[1];
    const outlines = buildSegmentPlan({
      tier: 'STANDARD_PAYWALL_30_45_PCT',
      targetWords: tier.totalWords,
      direction: '绝不原谅直接复仇',
      baitType: '憋屈 → 反击',
      protagonist: '我',
      antagonist: '周景深',
      payoffMandate: '前 800 字内揭晓证据',
    });
    expect(outlines).toHaveLength(3);
    const total = outlines.reduce((n, o) => n + o.target_words, 0);
    expect(Math.abs(total - tier.totalWords)).toBeLessThan(20);
    expect(outlines[0].beats.qi).toContain('800');
    expect(outlines[2].segment_role).toContain('收尾');
  });

  it('长篇模式切换为 Arc Unit 循环', () => {
    const outlines = buildSegmentPlan({
      tier: 'LONG_FORM_SERIAL_OVER_6000',
      targetWords: 10500,
      direction: '',
      baitType: '真相 → 反转',
      protagonist: '我',
      antagonist: '对手',
      payoffMandate: '',
    });
    expect(outlines.length).toBe(3);
    expect(outlines[0].segment_role).toContain('单元');
    expect(outlines[outlines.length - 1].segment_role).toContain('收尾');
  });

  it('兜底 Story Bible 带上走向与反派', () => {
    const bible = buildFallbackBible(makeAgent1(), '身份掉马全网直播');
    expect(bible.pov).toContain('第一人称');
    expect(bible.characters.length).toBeGreaterThanOrEqual(2);
    expect(bible.characters[0].current_state).toContain('身份掉马');
  });
});

/* --------------------------------------------------------------- 门禁 */

describe('six gates', () => {
  const a1 = makeAgent1();
  const bible = buildFallbackBible(a1, '绝不原谅');
  const outline: SegmentOutline = {
    segment_index: 1,
    segment_role: '第 1 段 · 卡点即时兑现段',
    target_words: 1200,
    beats: { qi: 'q', cheng: 'c', zhuan: 'z', he: 'h' },
  };

  it('合格的正文可通过全部适用门禁', () => {
    const draft = makeGateDraft(1300);
    const gate = evaluateGates({ draft, outline, index: 0, total: 3, bible, agent1: a1, previousTail: a1.ending_anchor });
    expect(gate.gates.word_count_ok).toBe(true);
    expect(gate.gates.instant_payoff_800_ok).toBe(true);
    expect(gate.gates.anti_cliche_ok).toBe(true);
    expect(gate.gates.golden_ending_ok).toBe(true); // 非终段跳过
    expect(gate.status).toBe('PASS');
    expect(gateScore(gate)).toBe(100);
  });

  it('字数不足会 REJECT 并给出可执行指令', () => {
    const draft = makeGateDraft(400);
    const gate = evaluateGates({ draft, outline, index: 0, total: 3, bible, agent1: a1, previousTail: a1.ending_anchor });
    expect(gate.gates.word_count_ok).toBe(false);
    expect(gate.status).toBe('REJECT');
    expect(gate.revision_instructions.join()).toContain('字数不够');
  });

  it('章节标题残留会打断无缝衔接门禁', () => {
    const draft = `## 第一章 归来\n\n${makeGateDraft(1300)}`;
    const gate = evaluateGates({ draft, outline, index: 0, total: 3, bible, agent1: a1, previousTail: a1.ending_anchor });
    expect(gate.gates.seamless_bridge_ok).toBe(false);
  });

  it('开头复制了上文最后一句会被识别为不衔接', () => {
    const tail = a1.ending_anchor.slice(-12);
    const draft = `${tail}${makeGateDraft(1300)}`;
    const gate = evaluateGates({ draft, outline, index: 0, total: 3, bible, agent1: a1, previousTail: tail });
    expect(gate.gates.seamless_bridge_ok).toBe(false);
  });

  it('AI 套话命中即为 0 容忍', () => {
    const draft = `${makeGateDraft(1300)}\n\n空气仿佛凝固了，所有人都惊呆了。`;
    const gate = evaluateGates({ draft, outline, index: 0, total: 3, bible, agent1: a1, previousTail: a1.ending_anchor });
    expect(gate.gates.anti_cliche_ok).toBe(false);
    expect(gate.cliche_hits.length).toBeGreaterThan(0);
  });

  it('终段必须以金句收尾，问句会被拦下', () => {
    const draft = `${makeGateDraft(1300)}\n\n这一切，究竟是谁的错呢？`;
    const gate = evaluateGates({ draft, outline, index: 2, total: 3, bible, agent1: a1, previousTail: '前一段结尾。' });
    expect(gate.gates.golden_ending_ok).toBe(false);
    expect(gate.status).toBe('REJECT');
  });

  it('终段合格时抽出金句', () => {
    const draft = makeGateDraft(1300);
    const gate = evaluateGates({ draft, outline, index: 2, total: 3, bible, agent1: a1, previousTail: '前一段结尾。' });
    expect(gate.gates.golden_ending_ok).toBe(true);
    expect(gate.golden_quote_extracted).toContain('烂在泥里的旧梦');
  });

  it('模型复审不能推翻代码判定的 FAIL，只能补充意见', () => {
    const draft = makeGateDraft(400);
    const gate = evaluateGates({ draft, outline, index: 0, total: 3, bible, agent1: a1, previousTail: a1.ending_anchor });
    const merged = mergeLLMReview(gate, {
      status: 'PASS',
      revision_instructions: ['建议补充旁观者反应'],
      summary_for_next_segment: '主角当众亮出公证书。',
    });
    expect(merged.status).toBe('REJECT');
    expect(merged.revision_instructions.join()).toContain('字数不够');
    expect(merged.revision_instructions.join()).toContain('建议补充旁观者反应');
    expect(merged.summary_for_next_segment).toBe('主角当众亮出公证书。');
    expect(merged._meta.judged_by).toBe('code+llm');
  });
});

/* ----------------------------------------------------------- 载荷归一化 */

describe('normalize upstream payloads', () => {
  const fallbackA1 = {
    cleanedText: SAMPLE_TEXT,
    sourceType: 'raw_text' as const,
    noiseRemoved: [],
    paywallDetected: false,
  };

  it('模型压缩正文时回退到确定性清洗结果', () => {
    const payload = coerceAgent1({ cleaned_text: '短短一句摘要。', total_char_count: 7 }, fallbackA1);
    expect(payload.cleaned_text.length).toBe(SAMPLE_TEXT.length);
    expect(payload.total_char_count).toBe(countWords(SAMPLE_TEXT));
    expect(payload.length_tier).toBe('STANDARD_PAYWALL_30_45_PCT');
    expect(payload.ending_anchor.length).toBeGreaterThan(100);
  });

  it('模型谎报字数/体量档位时以代码计算为准', () => {
    const payload = coerceAgent1(
      { cleaned_text: SAMPLE_TEXT, total_char_count: 99999, length_tier: 'LONG_FORM_SERIAL_OVER_6000' },
      fallbackA1,
    );
    expect(payload.total_char_count).toBe(countWords(SAMPLE_TEXT));
    expect(payload.length_tier).toBe('STANDARD_PAYWALL_30_45_PCT');
  });

  it('蓝图缺拍点/缺段时用兜底结构补齐', () => {
    const a1 = makeAgent1();
    const bible = buildFallbackBible(a1, '');
    const fallbackOutlines = buildSegmentPlan({
      tier: a1.length_tier,
      targetWords: 7500,
      direction: '',
      baitType: '憋屈 → 反击',
      protagonist: '我',
      antagonist: '周景深',
      payoffMandate: '前 800 字兑现',
    });
    // 只返回 1 段 → 结构不完整，整包回退到确定性规划
    const truncated = coerceAgent2(
      { story_bible: {}, segment_outlines: [{ segment_index: 1, beats: { qi: '只写了起拍' } }] },
      { bible, outlines: fallbackOutlines, targetWords: 7500, planMode: 'three_stage', routeReason: '测试' },
    );
    expect(truncated.segment_outlines).toHaveLength(3);
    expect(truncated.segment_outlines[0].beats.qi).toBe(fallbackOutlines[0].beats.qi);

    // 段数齐全但某拍缺失 → 保留模型填写的内容，只补空缺拍
    const partial = coerceAgent2(
      {
        story_bible: { pov: '第三人称', characters: [{ name: '林晚', role: '主角' }, { name: '周景深', role: '反派' }] },
        segment_outlines: [
          { segment_index: 1, beats: { qi: '只写了起拍' } },
          { segment_index: 2 },
          { segment_index: 3 },
        ],
      },
      { bible, outlines: fallbackOutlines, targetWords: 7500, planMode: 'three_stage', routeReason: '测试' },
    );
    expect(partial.segment_outlines).toHaveLength(3);
    expect(partial.segment_outlines[0].beats.qi).toBe('只写了起拍');
    expect(partial.segment_outlines[0].beats.cheng).toBe(fallbackOutlines[0].beats.cheng);
    expect(partial.story_bible.characters[0].name).toBe('林晚');
  });

  it('容错解析能处理代码围栏与尾逗号', () => {
    expect(parseJsonLoose('```json\n{"a":1,}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('前置说明 {"b":[1,2]} 后置')).toEqual({ b: [1, 2] });
    expect(asNumber('约 2,200 字', 0)).toBe(2200);
    expect(asStringArray('快节奏，强情绪')).toEqual(['快节奏', '强情绪']);
  });
});

/* ------------------------------------------------------------- 仿真引擎 */

describe('simulation engine', () => {
  const a1 = makeAgent1();
  const bible = buildFallbackBible(a1, '绝不原谅直接复仇');

  it('仿真稿不撞套话黑名单', () => {
    const outline: SegmentOutline = {
      segment_index: 1,
      segment_role: '第 1 段 · 卡点即时兑现段',
      target_words: 1200,
      beats: { qi: 'q', cheng: 'c', zhuan: 'z', he: 'h' },
    };
    const text = simulateSegment({
      outline,
      index: 0,
      total: 3,
      bible,
      agent1: a1,
      direction: '绝不原谅直接复仇',
      previousTail: a1.ending_anchor,
    });
    expect(text).not.toContain('嘴角勾起');
    expect(text).not.toContain('空气仿佛凝固');
    expect(text.length).toBeGreaterThan(800);
  });

  it('1600 字仿真稿的 10-gram 重复率仍在阈值内（防止模板复读）', () => {
    const outline: SegmentOutline = {
      segment_index: 2,
      segment_role: '第 2 段 · 二次反转',
      target_words: 1600,
      beats: { qi: 'q', cheng: 'c', zhuan: 'z', he: 'h' },
    };
    const text = simulateSegment({
      outline,
      index: 1,
      total: 3,
      bible,
      agent1: a1,
      direction: '幕后黑手另有其人',
      previousTail: a1.ending_anchor,
    });
    expect(countWords(text)).toBeGreaterThan(1400);
    expect(repeatRatio(text, 10)).toBeLessThan(0.18);
  });

  it('长篇 Arc Unit 档位（3,750 字）也能填满目标且不触发重复率门禁', () => {
    const outline: SegmentOutline = {
      segment_index: 1,
      segment_role: '第 1 单元 · Arc Unit',
      target_words: 3750,
      beats: { qi: 'q', cheng: 'c', zhuan: 'z', he: 'h' },
    };
    const text = simulateSegment({
      outline,
      index: 0,
      total: 2,
      bible,
      agent1: a1,
      direction: '幕后黑手另有其人',
      previousTail: a1.ending_anchor,
    });
    expect(countWords(text)).toBeGreaterThanOrEqual(3400);
    const gate = evaluateGates({
      draft: text,
      outline,
      index: 0,
      total: 2,
      bible,
      agent1: a1,
      previousTail: a1.ending_anchor,
    });
    expect(gate.gates.anti_cliche_ok).toBe(true);
    expect(gate.gates.word_count_ok).toBe(true);
    expect(gate._meta.repeat_ratio).toBeLessThan(0.18);
  });

  it('仿真稿可以通过自己产出的六道门禁（首段与终段）', () => {
    const first: SegmentOutline = {
      segment_index: 1,
      segment_role: '第 1 段 · 卡点即时兑现段',
      target_words: 1200,
      beats: { qi: 'q', cheng: 'c', zhuan: 'z', he: 'h' },
    };
    const firstText = simulateSegment({
      outline: first,
      index: 0,
      total: 3,
      bible,
      agent1: a1,
      direction: '',
      previousTail: a1.ending_anchor,
    });
    const firstGate = evaluateGates({
      draft: firstText,
      outline: first,
      index: 0,
      total: 3,
      bible,
      agent1: a1,
      previousTail: a1.ending_anchor,
    });
    expect(firstGate.gates.word_count_ok).toBe(true);
    expect(firstGate.gates.instant_payoff_800_ok).toBe(true);
    expect(firstGate.gates.anti_cliche_ok).toBe(true);

    const last: SegmentOutline = { ...first, segment_index: 3, segment_role: '第 3 段 · 终局' };
    const lastText = simulateSegment({
      outline: last,
      index: 2,
      total: 3,
      bible,
      agent1: a1,
      direction: '',
      previousTail: firstText.slice(-600),
    });
    const lastGate = evaluateGates({
      draft: lastText,
      outline: last,
      index: 2,
      total: 3,
      bible,
      agent1: a1,
      previousTail: firstText.slice(-600),
    });
    expect(lastGate.gates.golden_ending_ok).toBe(true);
  });
});

/* --------------------------------------------------------------- 导出 */

describe('export', () => {
  it('Markdown 包含前文、续写与门禁报告', () => {
    const a1 = makeAgent1();
    const bible = buildFallbackBible(a1, '');
    const outline: SegmentOutline = {
      segment_index: 1,
      segment_role: '第 1 段 · 卡点即时兑现段',
      target_words: 400,
      beats: { qi: 'q', cheng: 'c', zhuan: 'z', he: 'h' },
    };
    const text = makeGateDraft(500);
    const gate = evaluateGates({ draft: text, outline, index: 0, total: 1, bible, agent1: a1, previousTail: '' });
    const agent2: Agent2Payload = {
      story_bible: bible,
      segment_outlines: [outline],
      _meta: { plan_mode: 'three_stage', judged_by: 'code', route_reason: 'test' },
    };
    const state: ProjectState = {
      source_text: SAMPLE_TEXT,
      source_type: 'raw_text',
      direction: '绝不原谅',
      target_tier_id: 'compact',
      agent1: a1,
      agent2,
      segments: [
        {
          segment_index: 1,
          segment_role: outline.segment_role,
          title: '当众兑现',
          text,
          word_count: countWords(text),
          status: 'pass',
          gate,
          attempts: 1,
          warnings: [],
          source: 'simulation',
        },
      ],
      logs: [],
      memory_banner: '',
      progress: { percent: 100, label: '', active_segment: 1, total_segments: 1 },
      engine: 'simulation',
    };
    const md = buildMarkdown(state, '测试作品');
    expect(md).toContain('# 测试作品');
    expect(md).toContain('卡点前文（原文）');
    expect(md).toContain('六道商业门禁质检报告');
    expect(md).toContain('字数够不够');
    expect(md).toContain(text.slice(0, 30));
  });

  it('示例脚本能覆盖三段的全部段落角色', () => {
    expect(Object.keys(SAMPLE_CONTINUATION).map(Number).sort()).toEqual([1, 2, 3]);
    expect(countWords(SAMPLE_CONTINUATION[1])).toBeGreaterThan(1000);
  });
});
