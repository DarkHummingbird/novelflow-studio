import { useState } from 'react';
import {
  Compass,
  FileText,
  PanelLeftClose,
  ScanLine,
  SlidersHorizontal,
  Sparkles,
  Target,
  Upload,
  Video,
} from 'lucide-react';
import { LENGTH_TIER_HINT, QUICK_DIRECTIONS, SAMPLE_TEXT, TARGET_TIERS } from '../config/presets';
import { countWords } from '../lib/text';
import type { Agent1Payload, LengthTier, SourceType, TargetTierId } from '../types';
import { Badge, SectionLabel, Toggle } from './ui';

export interface LeftPanelProps {
  sourceText: string;
  onSourceTextChange: (v: string) => void;
  sourceType: SourceType;
  onSourceType: (t: SourceType) => void;
  direction: string;
  onDirection: (v: string) => void;
  targetTierId: TargetTierId;
  onTargetTierId: (id: TargetTierId) => void;
  agent1: Agent1Payload | null;
  diagnostics: { chars: number; paragraphs: number; tier: LengthTier };
  onLoadSample: () => void;
  onAnalyze: () => void;
  running: boolean;
  hasBlueprint: boolean;
  canRun: boolean;
  onConfigure: () => void;
  reviewWithLLM: boolean;
  onReviewWithLLM: (v: boolean) => void;
  maxRevision: number;
  onMaxRevision: (n: number) => void;
  onCollapse: () => void;
}

const DEMO_LINES = [
  '结婚三周年纪念日的烛光晚餐，他迟到了三个小时。',
  '我坐在靠窗的位置，面前的和牛早已冷透。',
  '手机屏幕停在一条同城热搜推送上——',
  '“周氏集团总裁豪掷八千万拍下粉钻，只博红颜一笑”。',
  '配图里，我的丈夫正低头替另一个女人戴上项链。',
  '那是他藏在心尖上五年的白月光。',
  '我抬手，把牛皮纸袋里的东西狠狠拍在茶几上——',
];

export function LeftPanel(props: LeftPanelProps) {
  const {
    sourceText,
    onSourceTextChange,
    sourceType,
    onSourceType,
    direction,
    onDirection,
    targetTierId,
    onTargetTierId,
    agent1,
    diagnostics,
    onLoadSample,
    onAnalyze,
    running,
    hasBlueprint,
    canRun,
    onConfigure,
    reviewWithLLM,
    onReviewWithLLM,
    maxRevision,
    onMaxRevision,
    onCollapse,
  } = props;

  const [showAdvanced, setShowAdvanced] = useState(false);
  const tier = agent1?.length_tier ?? diagnostics.tier;

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
      <header className="flex items-center justify-between gap-2 border-b border-line bg-paper-2 px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <Target className="h-4 w-4 text-amber-600" />
          <h2 className="text-xs font-bold text-ink">1. 卡点素材与创作指令</h2>
        </div>
        <button
          type="button"
          onClick={onCollapse}
          title="折叠左栏，扩大阅读视野"
          className="rounded-lg p-1 text-zinc-500 hover:bg-white hover:text-zinc-900"
        >
          <PanelLeftClose className="h-3.5 w-3.5" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {/* 双模输入 */}
        <div className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-paper-3 p-1">
          <button
            type="button"
            onClick={() => onSourceType('raw_text')}
            className={`flex items-center justify-center gap-1 rounded-lg py-1.5 text-[11px] font-semibold transition-all ${
              sourceType === 'raw_text' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800'
            }`}
          >
            <FileText className="h-3.5 w-3.5 text-amber-600" />
            纯文本直入
          </button>
          <button
            type="button"
            onClick={() => onSourceType('fast_screen_record')}
            className={`flex items-center justify-center gap-1 rounded-lg py-1.5 text-[11px] font-semibold transition-all ${
              sourceType === 'fast_screen_record'
                ? 'bg-white text-zinc-900 shadow-sm'
                : 'text-zinc-500 hover:text-zinc-800'
            }`}
          >
            <Video className="h-3.5 w-3.5 text-indigo-600" />
            录屏抽帧
          </button>
        </div>

        {!canRun && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-2.5">
            <span className="mt-0.5 text-[11px] font-bold text-amber-900">未配置模型</span>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] leading-snug text-amber-900/85">
                续写与蓝图生成需要真实模型。下面的「卡点前文」和走向指令可以随便填，但点生成前需要先接入模型。
              </p>
              <button
                type="button"
                onClick={onConfigure}
                className="mt-1.5 rounded-lg bg-amber-600 px-2 py-1 text-[10px] font-bold text-white hover:bg-amber-500"
              >
                配置模型 API
              </button>
            </div>
          </div>
        )}

        {sourceType === 'fast_screen_record' && (
          <div className="space-y-1.5 rounded-xl border border-indigo-200 bg-indigo-50/50 p-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-indigo-900">抽帧通道演示</span>
              <Badge tone="indigo" title="真实光流抽帧 + PaddleOCR 属于 v5.0 后端能力">
                界面演示
              </Badge>
            </div>
            <div className="relative h-20 overflow-hidden rounded-lg border border-indigo-900/20 bg-zinc-900 px-2 py-1.5 font-mono text-[9px] leading-[15px] text-zinc-100">
              <div className="animate-[nf-scroll_9s_linear_infinite] space-y-0">
                {DEMO_LINES.map((line) => (
                  <p key={line} className="whitespace-nowrap opacity-80">
                    {line}
                  </p>
                ))}
              </div>
              <div className="absolute inset-x-0 bottom-0 bg-amber-600/95 px-2 py-1 text-center text-[9px] font-bold text-white">
                🔒 识别付费卡点 · 开通会员解锁后续
              </div>
              <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-emerald-400" />
            </div>
            <p className="text-[10px] leading-snug text-indigo-900/80">
              当前版本由确定性清洗器承担跨帧去重与断句拼接；真实视频像素级 OCR 需 v5.0 的
              OpenCV + PaddleOCR 后端。请把录屏文字粘贴到下方文本框后继续。
            </p>
          </div>
        )}

        {/* 前文输入 */}
        <div className="flex min-h-[150px] flex-1 flex-col">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-zinc-700">卡点前文正文</span>
            <div className="flex items-center gap-1">
              <Badge
                tone={diagnostics.chars >= 2500 && diagnostics.chars <= 6000 ? 'emerald' : 'neutral'}
                title={LENGTH_TIER_HINT[tier]}
              >
                {diagnostics.chars.toLocaleString()} 字
              </Badge>
              <Badge tone="amber" title={LENGTH_TIER_HINT[tier]}>
                {tier === 'EARLY_SETUP_UNDER_2500'
                  ? '蓄势期'
                  : tier === 'STANDARD_PAYWALL_30_45_PCT'
                    ? '黄金卡点期'
                    : '连载滚动期'}
              </Badge>
            </div>
          </div>
          <textarea
            value={sourceText}
            onChange={(e) => onSourceTextChange(e.target.value)}
            spellCheck={false}
            placeholder="在此粘贴 3,000–5,000 字卡点前文（建议停在付费卡点最后一句）…"
            className="min-h-[150px] flex-1 resize-none rounded-xl border border-line bg-paper px-3 py-2.5 font-serif text-[12px] leading-[1.8] text-ink outline-none focus:border-amber-500"
          />
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              type="button"
              onClick={onLoadSample}
              disabled={running}
              className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-2 py-1.5 text-[10px] font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-40"
            >
              <Sparkles className="h-3 w-3 text-amber-600" />
              载入 {countWords(SAMPLE_TEXT).toLocaleString()} 字卡点样本
            </button>
            <label className="flex shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-line bg-white px-2 py-1.5 text-[10px] font-medium text-zinc-700 hover:border-line-strong">
              <Upload className="h-3 w-3" />
              导入 TXT
              <input
                type="file"
                accept=".txt,.md,text/plain,text/markdown"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = (ev) => onSourceTextChange(String(ev.target?.result ?? ''));
                  reader.readAsText(file, 'utf-8');
                  e.target.value = '';
                }}
              />
            </label>
          </div>
        </div>

        {/* 走向指令 */}
        <div className="space-y-2 rounded-xl border border-line bg-paper p-2.5">
          <SectionLabel icon={<Compass className="h-3.5 w-3.5 text-indigo-600" />}>续写走向与爽点指令</SectionLabel>
          <input
            type="text"
            value={direction}
            onChange={(e) => onDirection(e.target.value)}
            placeholder="例如：身份掉马、全网直播、幕后黑手另有其人…"
            className="w-full rounded-lg border border-line-strong bg-white px-2.5 py-1.5 text-[11px] text-ink outline-none focus:border-indigo-500"
          />
          <div className="flex flex-wrap gap-1">
            {QUICK_DIRECTIONS.map((chip) => {
              const active = direction.includes(chip);
              return (
                <button
                  key={chip}
                  type="button"
                  onClick={() => onDirection(chip)}
                  className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                    active
                      ? 'border-indigo-300 bg-indigo-50 text-indigo-900'
                      : 'border-line bg-white text-zinc-600 hover:border-line-strong'
                  }`}
                >
                  {chip}
                </button>
              );
            })}
          </div>
        </div>

        {/* 字数档位 */}
        <div className="space-y-1.5 rounded-xl border border-line bg-paper p-2.5">
          <div className="flex items-center justify-between">
            <SectionLabel icon={<SlidersHorizontal className="h-3.5 w-3.5 text-amber-600" />}>
              续写目标字数
            </SectionLabel>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {TARGET_TIERS.map((tierItem) => {
              const active = targetTierId === tierItem.id;
              return (
                <button
                  key={tierItem.id}
                  type="button"
                  onClick={() => onTargetTierId(tierItem.id)}
                  title={tierItem.desc}
                  className={`rounded-lg border px-1 py-1.5 text-center transition-all ${
                    active
                      ? 'border-zinc-900 bg-zinc-900 text-white shadow-sm'
                      : 'border-line bg-white text-zinc-700 hover:border-line-strong'
                  }`}
                >
                  <div className="text-[11px] font-bold">{tierItem.label}</div>
                  <div className={`font-mono text-[10px] ${active ? 'text-amber-300' : 'text-zinc-500'}`}>
                    {tierItem.totalLabel}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* 高级设置 */}
        <div className="rounded-xl border border-line bg-paper p-2.5">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex w-full items-center justify-between text-[11px] font-bold text-zinc-800"
          >
            <span>门禁与复审设置</span>
            <span className="font-mono text-[10px] text-zinc-500">{showAdvanced ? '收起' : '展开'}</span>
          </button>
          {showAdvanced && (
            <div className="mt-2 space-y-2.5">
              <Toggle
                checked={reviewWithLLM}
                onChange={onReviewWithLLM}
                label="叠加 LLM 复审（Agent 04）"
                hint="开启后每段多一次模型调用；代码判定仍是权威，模型只补充修订建议与摘要。"
              />
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold text-zinc-700">返工上限（每段）</span>
                <select
                  value={maxRevision}
                  onChange={(e) => onMaxRevision(Number(e.target.value))}
                  className="w-full rounded-lg border border-line-strong bg-white px-2 py-1 text-[11px] text-zinc-800 outline-none"
                >
                  <option value={0}>不返工（门禁只记录）</option>
                  <option value={1}>返工 1 次</option>
                  <option value={2}>返工 2 次</option>
                  <option value={3}>返工 3 次</option>
                </select>
              </label>
              <p className="text-[10px] leading-snug text-zinc-500">
                门禁未通过时会带着具体修改指令重写该段；达到上限后按当前稿保留并标注「存在未通过门禁」。
              </p>
            </div>
          )}
        </div>

        {/* 诊断摘要 */}
        {agent1 && (
          <div className="space-y-1 rounded-xl border border-emerald-200 bg-emerald-50/60 p-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-emerald-900">Agent 01 摄取结果</span>
              <Badge tone="emerald">{agent1._meta.judged_by === 'llm' ? 'LLM 语义清洗' : '确定性清洗'}</Badge>
            </div>
            <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] text-emerald-950">
              <div className="flex justify-between">
                <dt className="text-emerald-800/80">净字数</dt>
                <dd className="font-mono">{agent1.total_char_count.toLocaleString()}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-emerald-800/80">段落</dt>
                <dd className="font-mono">{agent1._meta.paragraphs}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-emerald-800/80">付费墙话术</dt>
                <dd>{agent1.paywall_detected ? '已识别' : '未出现'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-emerald-800/80">锚点实体</dt>
                <dd className="truncate">{agent1._meta.anchor_entities.slice(0, 2).join('、') || '—'}</dd>
              </div>
            </dl>
            {agent1._meta.noise_removed.length > 0 && (
              <p className="text-[10px] text-emerald-800/80">已剥离：{agent1._meta.noise_removed.join('、')}</p>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={onAnalyze}
          disabled={running || !canRun}
          title={canRun ? undefined : '需要先配置模型 API'}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-amber-500 py-2 text-[11px] font-bold text-zinc-950 shadow-sm transition-colors hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ScanLine className="h-3.5 w-3.5" />
          {hasBlueprint ? '重新生成四拍蓝图' : '生成商业三段式细纲'}
        </button>
      </div>
    </section>
  );
}
