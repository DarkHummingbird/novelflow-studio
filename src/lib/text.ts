/**
 * 确定性文本引擎 —— 不依赖任何模型的可验证逻辑。
 *
 * 这里实现的每一项能力都对应 PRD 中的一个"Skill"：
 *  - paywall_noise_stripper   → stripNoise
 *  - novel_style_profiler     → profileStyle
 *  - bait_classifier          → classifyBait
 *  - word_count_controller    → countWords
 *  - commercial_gatekeeper    → 供 gates.ts 使用的 repeatRatio / extractEndingAnchor 等
 */

/* --------------------------------------------------------------- 计数 */

/** 字数口径：非空白字符数（含中文标点），与番茄/知乎等平台后台的“字数”一致。 */
export function countWords(text: string | null | undefined): number {
  if (!text) return 0;
  return text.replace(/\s/g, '').length;
}

export function countChars(text: string | null | undefined): number {
  return text ? text.length : 0;
}

export function cjkRatio(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const visible = text.replace(/\s/g, '').length;
  return visible ? cjk / visible : 0;
}

/* ----------------------------------------------------------- 段落/句子 */

export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？…])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function lastSentence(text: string): string {
  const sents = splitSentences(text);
  return sents.length ? sents[sents.length - 1] : text.trim().slice(-40);
}

export function normalizeForMatch(text: string): string {
  return text.replace(/[\s\u3000-\u303f\uff00-\uffef，。！？、"“”‘’；：…—·]/g, '');
}

/** 去掉首尾引号，便于金句展示 */
export function trimQuotes(text: string): string {
  return text.replace(/^[「『“"'（(]+/, '').replace(/[」』”"'）)]+$/, '').trim();
}

/* -------------------------------------------------------- 平台噪音清洗 */

interface NoiseRule {
  id: string;
  /** line：整行命中即删除；inline：只删除命中片段 */
  mode: 'line' | 'inline';
  re: RegExp;
}

const NOISE_RULES: NoiseRule[] = [
  { id: '付费锁屏弹窗', mode: 'inline', re: /(开通|立即开通|续费|购买)?\s*(VIP|vip|会员|会员卡)?[^\n]{0,12}(解锁|观看|阅读)(后续|全文|剩余|更多)?[^\n]{0,14}/g },
  { id: '付费拦截提示', mode: 'inline', re: /(本章|全文|后续)[^\n]{0,6}(需|要)(付费|购买|开通)[^\n]{0,12}/g },
  { id: '阅读原文导流', mode: 'inline', re: /(点击|戳|长按)[^\n]{0,6}(左下角|下方|上面|屏幕)?[^\n]{0,4}(阅读原文|看全集|继续阅读|查看全文|免费阅读|解锁全文)[^\n]{0,10}/g },
  { id: '主页看全集', mode: 'line', re: /^(点|看|进)?\s*(我的|作者|主播|主页)[^\n]{0,12}(看全集|有全集|更精彩|不迷路)[^\n]{0,10}$/ },
  { id: '求关注话术', mode: 'line', re: /^(点赞|收藏|转发|关注|评论|投币|双击|分享)[\s\S]{0,30}(不迷路|看全集|更新|支持|谢谢|感谢)[\s\S]{0,10}$/ },
  { id: '求票话术', mode: 'line', re: /^(求|跪求)[^\n]{0,6}(收藏|推荐票|月票|三连|关注)[^\n]{0,8}$/ },
  { id: '章节未完', mode: 'line', re: /^第?\s*[0-9一二三四五六七八九十百零]+\s*[章回节集]?\s*[（(]?\s*(未完|待续)[^\n]{0,10}$/ },
  { id: '未完待续', mode: 'line', re: /^[【\[（(]?\s*(未完待续|待续|下集更精彩|下章更精彩|本章完|全文完)\s*[】\]）)]?$/ },
  { id: '状态栏', mode: 'line', re: /^\s*\d{1,2}:\d{2}\s*(5G|4G|WiFi|wifi)?[^\n]{0,20}$/ },
  { id: '电量信号', mode: 'line', re: /^[\s\d%]*\s*(电量|信号|运营商|中国移动|中国联通|中国电信)[^\n]{0,12}$/ },
  { id: '平台水印', mode: 'line', re: /^(抖音|快手|小红书|视频号|B站|bilibili|知乎|番茄|晋江)[^\n]{0,10}@?[^\n]{0,14}$/ },
  { id: '下载引导', mode: 'line', re: /^(打开|下载|安装)\s*(APP|App|app|番茄|知乎|抖音|快手)[^\n]{0,18}$/ },
  { id: '作者注', mode: 'line', re: /^(作者|PS|ps|P\.S\.)[:：][^\n]{0,60}$/ },
  { id: '字数标注', mode: 'line', re: /^[（(]?\s*(全文|本章|共)\s*\d+\s*字\s*[）)]?$/ },
];

const INVISIBLE_RE = /[\u200b\u200c\u200d\ufeff\u2060]/g;

export interface NoiseStripResult {
  text: string;
  removed: string[];
}

/**
 * 剥离平台 UI 噪音与重复帧残影。
 * 保守策略：只删明确的 UI 话术，绝不删正文；作者修辞原样保留。
 */
export function stripNoise(input: string): NoiseStripResult {
  const removed = new Set<string>();
  const raw = (input ?? '').replace(/\r\n?/g, '\n').replace(INVISIBLE_RE, '');

  const kept: string[] = [];
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      kept.push('');
      continue;
    }
    // 纯符号/emoji 行
    if (!/[\u4e00-\u9fff a-zA-Z0-9]/.test(line)) {
      removed.add('符号噪声');
      continue;
    }
    let dropped = false;
    for (const rule of NOISE_RULES) {
      if (rule.mode !== 'line') continue;
      if (rule.re.test(line)) {
        removed.add(rule.id);
        dropped = true;
        break;
      }
    }
    if (dropped) continue;

    let out = line;
    for (const rule of NOISE_RULES) {
      if (rule.mode !== 'inline') continue;
      rule.re.lastIndex = 0;
      if (rule.re.test(out)) {
        rule.re.lastIndex = 0;
        out = out.replace(rule.re, '');
        removed.add(rule.id);
      }
    }
    out = out.trim();
    if (!out) continue;
    kept.push(out);
  }

  // 去重：视频跨帧重复段、连续重复段
  const deduped = dedupeParagraphs(splitParagraphs(kept.join('\n')));
  if (deduped.removed > 0) removed.add('重复帧残影');

  return { text: deduped.paragraphs.join('\n\n'), removed: [...removed] };
}

function dedupeParagraphs(paragraphs: string[]): { paragraphs: string[]; removed: number } {
  const out: string[] = [];
  let removed = 0;
  const seenExact = new Set<string>();
  for (const p of paragraphs) {
    const norm = normalizeForMatch(p);
    if (norm.length < 2) continue;
    if (seenExact.has(norm)) {
      removed += 1;
      continue;
    }
    const prev = out.length ? normalizeForMatch(out[out.length - 1]) : '';
    if (prev && (prev === norm || (norm.length > 8 && prev.endsWith(norm)) || (prev.length > 8 && norm.endsWith(prev)))) {
      removed += 1;
      // 保留更长的那一段
      if (norm.length > prev.length) out[out.length - 1] = p;
      continue;
    }
    seenExact.add(norm);
    out.push(p);
  }
  return { paragraphs: out, removed };
}

/* ------------------------------------------------------------ 卡点锚点 */

/** 取前文最后 N 字（按段落边界对齐，避免切断句子） */
export function extractEndingAnchor(text: string, size = 300): string {
  const t = text.trim();
  if (t.length <= size) return t;
  const start = Math.max(0, t.length - size);
  const nl = t.indexOf('\n', start);
  if (nl >= 0 && nl - start < 90) return t.slice(nl + 1).trim();
  const dot = t.lastIndexOf('。', t.length - 1);
  if (dot > t.length - size - 120) return t.slice(dot + 1).trim() || t.slice(start).trim();
  return t.slice(start).trim();
}

/* ------------------------------------------------------------ 诱饵分类 */

export interface BaitDiagnosis {
  bait_type: string;
  bait_mechanism: string;
  first_800w_payoff_mandate: string;
}

interface BaitRule extends BaitDiagnosis {
  re: RegExp;
}

const BAIT_RULES: BaitRule[] = [
  {
    bait_type: '死亡 → 降临',
    bait_mechanism: '致命危险已经贴到皮肤，生死一线',
    first_800w_payoff_mandate: '前 800 字内正面化解眼前杀机并反制凶手，禁止跳叙。',
    re: /(门锁.{0,6}(转|响)|脚步(声)?.{0,4}(停|近|来)|刀刃|刀尖|枪口|血(顺着|从|滴)|黑影|掐住|窒息|心跳(停止|骤停)|监控.{0,4}(黑|断))/,
  },
  {
    bait_type: '困境 → 解法',
    bait_mechanism: '救援/破局办法刚刚出现，执行瞬间被切断',
    first_800w_payoff_mandate: '前 800 字内必须接通救援或当场破局，并让局势完成第一次逆转。',
    re: /(拨通|打通|按下了?那个|十年没打过|号码|电话(那头|里)?|急救|110|120|唯一的办法|最后一根稻草|救命)/,
  },
  {
    bait_type: '憋屈 → 反击',
    bait_mechanism: '动作已发生、结果留白，制造极高认知闭合缺口',
    first_800w_payoff_mandate: '前 800 字内必须正面揭晓证据内容并完成第一轮当众打脸。',
    re: /(拍在|摔在|甩在|砸在|怼在|扔在|看清楚|睁大.{0,4}眼|她也配|惊喜吗|白纸黑字|证据|公证书|录音|当众)/,
  },
  {
    bait_type: '谜题 → 答案',
    bait_mechanism: '线索直指核心真相，揭晓延后一秒',
    first_800w_payoff_mandate: '前 800 字内直接亮出线索背后的真实身份或秘密。',
    re: /(笔迹|字迹|名字|背面|照片|签名|写着|一模一样|对戒|这是谁的)/,
  },
  {
    bait_type: '关系 → 临界',
    bait_mechanism: '摊牌与真相揭晓停在临界门槛上',
    first_800w_payoff_mandate: '前 800 字内直接完成摊牌决裂，绝不拖泥带水。',
    re: /(离婚|分手|订婚|婚礼|结婚证|戒指|表白|摊牌|决裂|退婚|休书|我们之间)/,
  },
  {
    bait_type: '真相 → 反转',
    bait_mechanism: '主角刚意识到“原来是他”，但还没说出口',
    first_800w_payoff_mandate: '前 800 字内让主角把真相完整说出口，并触发第一轮反制。',
    re: /(原来|竟然|居然|才知道|才发现|不是.{0,8}而是|一直在骗)/,
  },
];

export function classifyBait(tail: string, fullText: string): BaitDiagnosis {
  // 越靠近卡点的文本优先级越高：先用末尾 300 字锚点判定，再退到 400 / 1200 字。
  // 避免"前文正文里出现过'电话'"就把卡点误判成 困境 → 解法。
  const probes = [tail, fullText.slice(-400), fullText.slice(-1200)];
  for (const probe of probes) {
    for (const rule of BAIT_RULES) {
      if (rule.re.test(probe)) {
        return {
          bait_type: rule.bait_type,
          bait_mechanism: rule.bait_mechanism,
          first_800w_payoff_mandate: rule.first_800w_payoff_mandate,
        };
      }
    }
  }
  return {
    bait_type: '关系 → 临界',
    bait_mechanism: '摊牌与真相揭晓停在临界门槛上',
    first_800w_payoff_mandate: '前 800 字内直接完成摊牌决裂，给出卡点的确定结果。',
  };
}

/* ------------------------------------------------------------ 文风指纹 */

export interface StyleProfile {
  pov: string;
  avg_sentence_len: number;
  dialogue_ratio: string;
  tone_keywords: string[];
}

export function profileStyle(text: string): StyleProfile {
  const sents = splitSentences(text).filter((s) => s.length > 1);
  const avg = sents.length ? Math.round(sents.reduce((n, s) => n + s.length, 0) / sents.length) : 18;

  const dialogueChars = (text.match(/“[^”]*”/g) ?? []).join('').length;
  const visible = text.replace(/\s/g, '').length || 1;
  const ratio = dialogueChars / visible;

  const selfCount = (text.match(/我/g) ?? []).length;
  const thirdCount = (text.match(/[他她]/g) ?? []).length;
  const pov = selfCount >= Math.max(6, thirdCount * 0.9) ? '第一人称（“我”）' : '第三人称限制视角';

  const tones: string[] = [];
  if (avg <= 16) tones.push('短句凌厉');
  else if (avg >= 26) tones.push('长句铺陈');
  else tones.push('中速推进');

  if (ratio >= 0.3) tones.push('对话驱动');
  const excl = (text.match(/！/g) ?? []).length / (visible / 1000);
  if (excl > 8) tones.push('强情绪');
  const quest = (text.match(/？/g) ?? []).length / (visible / 1000);
  if (quest > 6) tones.push('悬念密集');

  return {
    pov,
    avg_sentence_len: avg,
    dialogue_ratio: `${Math.round(ratio * 100)}%`,
    tone_keywords: tones,
  };
}

/* ------------------------------------------------------------ 实体抽取 */

const BAD_ENTITY_CHARS =
  /[的了是在和就都也还很太最更不没么着过们这那有被把给对从向到说走看想要会能又再才只已当如虽但因所然其真假啥嘛吧呢啊哦呀我家你他她它]/;

/**
 * 频次法抽人名/关键实体：连续 2–4 个汉字、出现 ≥2 次、不含虚词字。
 * 纯启发式，用于卡点实体锚定与仿真引擎填槽，不作为门禁的唯一依据。
 */
export function extractEntities(text: string, limit = 6): string[] {
  const src = text.replace(/[^\u4e00-\u9fff]/g, '\u0000');
  const counts = new Map<string, number>();
  for (let len = 2; len <= 4; len++) {
    for (let i = 0; i + len <= src.length; i++) {
      const seg = src.slice(i, i + len);
      if (seg.includes('\u0000')) continue;
      if (BAD_ENTITY_CHARS.test(seg[0]) || BAD_ENTITY_CHARS.test(seg[len - 1])) continue;
      counts.set(seg, (counts.get(seg) ?? 0) + 1);
    }
  }
  const candidates = [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] * b[0].length - a[1] * a[0].length);

  const picked: string[] = [];
  for (const [seg, n] of candidates) {
    if (picked.length >= limit) break;
    if (n < 2) continue;
    if (picked.some((p) => p.includes(seg) || seg.includes(p))) continue;
    picked.push(seg);
  }
  return picked;
}

/* --------------------------------------------------------- 重复率检测 */

/** n-gram 重复率：越大越像车轱辘话注水 */
export function repeatRatio(text: string, n = 10): number {
  const src = normalizeForMatch(text);
  if (src.length <= n) return 0;
  const seen = new Set<string>();
  let dup = 0;
  let total = 0;
  for (let i = 0; i + n <= src.length; i++) {
    const gram = src.slice(i, i + n);
    total += 1;
    if (seen.has(gram)) dup += 1;
    else seen.add(gram);
  }
  return total ? dup / total : 0;
}

/* -------------------------------------------------------------- 金句 */

export function extractGoldenQuote(text: string): string {
  const paras = splitParagraphs(text);
  const last = paras.length ? paras[paras.length - 1] : '';
  const sents = splitSentences(last).map(trimQuotes).filter(Boolean);
  for (let i = sents.length - 1; i >= 0; i--) {
    const s = sents[i];
    if (s.length >= 8 && s.length <= 60 && !s.includes('？')) return s;
  }
  const fallback = trimQuotes(last);
  return fallback.length > 60 ? fallback.slice(-60) : fallback;
}

/* ---------------------------------------------------------- 其他工具 */

export function firstSentence(text: string): string {
  const s = splitSentences(text.trim());
  return s.length ? s[0].trim() : '';
}

export function tailChars(text: string, n: number): string {
  const t = text.trim();
  return t.length <= n ? t : t.slice(-n);
}

/** 是否为内置示例（用于示例脚本路由；不影响真实输入） */
export function looksLikeSample(text: string): boolean {
  return /周景深/.test(text) && /苏念念/.test(text) && /周老爷子/.test(text);
}

export function hashText(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
