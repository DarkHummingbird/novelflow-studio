import { Fragment, type ReactNode } from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileJson,
  Highlighter,
  PanelLeftOpen,
  Quote,
  RefreshCw,
  ShieldCheck,
  Wand2,
  X,
} from 'lucide-react';
import { AI_CLICHES } from '../config/presets';
import { gateScore } from '../lib/gates';
import type { Agent1Payload, LogEntry, ProgressState, SegmentDraft, WorkspaceMode } from '../types';
import { Badge, EmptyState, GateDots, GateRows, IconButton, ProgressBar } from './ui';

export type ReaderView = 'segments' | 'full' | 'report';

export interface ReaderPanelProps {
  segments: SegmentDraft[];
  streaming: Record<number, string>;
  isRunning: boolean;
  progress: ProgressState;
  memoryBanner: string;
  logs: LogEntry[];
  mode: WorkspaceMode;
  engine: 'idle' | 'live' | 'simulation';
  view: ReaderView;
  onView: (v: ReaderView) => void;
  highlight: boolean;
  onHighlight: (v: boolean) => void;
  sourceText: string;
  agent1: Agent1Payload | null;
  title: string;
  isLeftCollapsed: boolean;
  onExpandLeft: () => void;
  rewritingIndex: number | null;
  onStartRewrite: (index: number | null) => void;
  revisionDraft: string;
  onRevisionDraft: (v: string) => void;
  onRewrite: (index: number) => void;
  isRewriting: boolean;
  onExportMarkdown: () => void;
  onExportTxt: () => void;
  onExportJson: () => void;
  onCopy: () => void;
  copied: boolean;
}

const CLICHE_SET = new Set(AI_CLICHES);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CLICHE_PATTERN = new RegExp(
  `(${[...AI_CLICHES].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})`,
  'g',
);

function withHighlight(text: string, enabled: boolean): ReactNode {
  if (!enabled) return text;
  const parts = text.split(CLICHE_PATTERN);
  return parts.map((part, idx) =>
    CLICHE_SET.has(part) ? (
      <mark key={`${part}-${idx}`} title="命中 AI 套话黑名单">
        {part}
      </mark>
    ) : (
      <Fragment key={`t-${idx}`}>{part}</Fragment>
    ),
  );
}

const LOG_TONE: Record<LogEntry['level'], string> = {
  info: 'border-line bg-white text-zinc-600',
  pass: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  warn: 'border-amber-200 bg-amber-50 text-amber-900',
  reject: 'border-rose-200 bg-rose-50 text-rose-900',
  error: 'border-rose-300 bg-rose-100 text-rose-950',
};

const STATUS_BADGE: Record<SegmentDraft['status'], { tone: 'neutral' | 'amber' | 'emerald' | 'rose' | 'indigo'; label: string }> = {
  pending: { tone: 'neutral', label: '排队中' },
  writing: { tone: 'indigo', label: '撰写中' },
  pass: { tone: 'emerald', label: '门禁 PASS' },
  rejected: { tone: 'rose', label: '门禁 REJECT' },
  forced: { tone: 'amber', label: '按上限保留' },
};

const SOURCE_LABEL: Record<SegmentDraft['source'], string> = {
  llm: '模型撰写',
  simulation: '仿真引擎',
  sample: '示例脚本',
};

export function ReaderPanel(props: ReaderPanelProps) {
  const {
    segments,
    streaming,
    isRunning,
    progress,
    memoryBanner,
    logs,
    mode,
    engine,
    view,
    onView,
    highlight,
    onHighlight,
    sourceText,
    agent1,
    title,
    isLeftCollapsed,
    onExpandLeft,
    rewritingIndex,
    onStartRewrite,
    revisionDraft,
    onRevisionDraft,
    onRewrite,
    isRewriting,
    onExportMarkdown,
    onExportTxt,
    onExportJson,
    onCopy,
    copied,
  } = props;

  const produced = segments.reduce((n, s) => n + s.word_count, 0);
  const passed = segments.filter((s) => s.status === 'pass').length;
  const recentLogs = logs.slice(-4);
  const lastStage = (segment: SegmentDraft) => {
    const writing = streaming[segment.segment_index - 1];
    return segment.status === 'writing' && writing ? writing : segment.text;
  };

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-paper-2 px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {isLeftCollapsed && (
            <IconButton title="展开素材栏" onClick={onExpandLeft}>
              <PanelLeftOpen className="h-3.5 w-3.5" />
            </IconButton>
          )}
          <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600" />
          <h2 className="truncate text-xs font-bold text-ink">3. 续写长文与门禁精修台</h2>
          <Badge tone={produced > 0 ? 'emerald' : 'neutral'}>{produced.toLocaleString()} 字</Badge>
          {segments.length > 0 && (
            <Badge tone={passed === segments.length ? 'emerald' : 'amber'}>
              门禁 {passed}/{segments.length}
            </Badge>
          )}
          {engine !== 'idle' && (
            <Badge
              tone={engine === 'live' ? 'indigo' : 'neutral'}
              title={engine === 'live' ? '全部文案来自真实模型' : '未配置 API Key：文案由内置仿真引擎生成'}
            >
              {engine === 'live' ? '真实模型' : '仿真引擎'}
            </Badge>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <IconButton title={highlight ? '关闭 AI 套话高亮' : '开启 AI 套话高亮'} onClick={() => onHighlight(!highlight)} active={highlight}>
            <Highlighter className="h-3.5 w-3.5" />
          </IconButton>

          <div className="flex items-center rounded-lg border border-line bg-paper-3 p-0.5 text-[10px]">
            {(
              [
                ['segments', '分段精修'],
                ['full', '全篇连读'],
                ['report', '门禁报告'],
              ] as [ReaderView, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => onView(id)}
                className={`rounded-md px-2 py-1 font-semibold transition-colors ${
                  view === id ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <IconButton title="复制完整稿（Markdown）" onClick={onCopy} disabled={produced === 0}>
            {copied ? <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
          </IconButton>
          <button
            type="button"
            onClick={onExportMarkdown}
            disabled={produced === 0}
            className="flex items-center gap-1 rounded-lg border border-line bg-white px-2 py-1.5 font-mono text-[10px] font-semibold text-zinc-800 hover:border-line-strong disabled:opacity-40"
          >
            <Download className="h-3 w-3" />
            .MD
          </button>
          <button
            type="button"
            onClick={onExportTxt}
            disabled={produced === 0}
            className="hidden items-center gap-1 rounded-lg border border-line bg-white px-2 py-1.5 font-mono text-[10px] font-semibold text-zinc-800 hover:border-line-strong disabled:opacity-40 sm:flex"
          >
            <Download className="h-3 w-3" />
            .TXT
          </button>
          {mode === 'architect' && (
            <button
              type="button"
              onClick={onExportJson}
              disabled={!agent1}
              className="hidden items-center gap-1 rounded-lg border border-line bg-white px-2 py-1.5 font-mono text-[10px] font-semibold text-zinc-800 hover:border-line-strong disabled:opacity-40 sm:flex"
            >
              <FileJson className="h-3 w-3" />
              契约
            </button>
          )}
        </div>
      </header>

      {/* 状态条 */}
      {(isRunning || progress.percent > 0 || recentLogs.length > 0) && (
        <div className="space-y-1.5 border-b border-line bg-paper-3/60 px-3.5 py-2">
          <ProgressBar percent={progress.percent} label={progress.label || '准备中…'} running={isRunning} />
          {mode === 'architect' && memoryBanner && (
            <p className="truncate font-mono text-[10px] text-indigo-800">📎 {memoryBanner}</p>
          )}
          {recentLogs.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {recentLogs.map((entry) => (
                <span
                  key={entry.id}
                  className={`max-w-full truncate rounded border px-1.5 py-0.5 text-[10px] ${LOG_TONE[entry.level]}`}
                  title={entry.text}
                >
                  {entry.agent === 'system' ? 'SYS' : entry.agent.toUpperCase()} · {entry.text}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 正文区 */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-paper p-3.5">
        {segments.length === 0 ? (
          isRunning ? (
            <div className="animate-pulse space-y-3 rounded-2xl border border-line bg-white p-5">
              <div className="h-3 w-1/3 rounded bg-zinc-200" />
              <div className="h-2.5 w-1/2 rounded bg-zinc-100" />
              <div className="space-y-2 pt-3">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div key={i} className={`h-2.5 rounded bg-zinc-100 ${i % 2 ? 'w-11/12' : 'w-full'}`} />
                ))}
              </div>
            </div>
          ) : (
            <EmptyState
              icon={<BookOpen className="h-8 w-8" />}
              title="短故事续写与门禁精修舞台"
              desc={
                <>
                  点击顶部 <strong className="text-zinc-800">“一键全自动续写”</strong>
                  ，流水线将依次完成清洗、诱饵诊断、四拍蓝图、滑动窗口撰写与六道门禁。
                  每段都会给出可追溯的门禁判定，未通过时会带着修改指令自动返工。
                </>
              }
            />
          )
        ) : view === 'segments' ? (
          <div className="space-y-4">
            {segments.map((segment, idx) => {
              const badge = STATUS_BADGE[segment.status];
              const text = lastStage(segment);
              const showCaret = segment.status === 'writing' && Boolean(streaming[idx]);
              const isRewritingThis = rewritingIndex === idx;
              return (
                <article key={segment.segment_index} className="rounded-2xl border border-line bg-white p-4 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line/70 pb-2.5">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone="amber">{segment.segment_role}</Badge>
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                        <Badge tone="neutral" title="本段文案来源">
                          {SOURCE_LABEL[segment.source]}
                        </Badge>
                        {segment.attempts > 1 && <Badge tone="rose">返工 {segment.attempts - 1} 次</Badge>}
                      </div>
                      <h3 className="mt-1 font-serif text-base font-bold text-ink">{segment.title}</h3>
                    </div>
                    <div className="flex items-center gap-2">
                      {segment.gate && <GateDots gate={segment.gate} />}
                      <span className="rounded-lg border border-line bg-paper px-1.5 py-0.5 font-mono text-[10px] font-semibold text-zinc-700">
                        {segment.word_count.toLocaleString()} 字
                      </span>
                      {segment.gate && (
                        <span className="font-mono text-[10px] text-zinc-500">评分 {gateScore(segment.gate)}</span>
                      )}
                      {!isRunning && segment.status !== 'pending' && (
                        <button
                          type="button"
                          onClick={() => onStartRewrite(isRewritingThis ? null : idx)}
                          className="flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-1 text-[10px] font-semibold text-indigo-900 hover:bg-indigo-100"
                        >
                          <RefreshCw className="h-3 w-3" />
                          局部重写
                        </button>
                      )}
                    </div>
                  </div>

                  {isRewritingThis && (
                    <div className="mt-2.5 space-y-1.5 rounded-xl border border-indigo-200 bg-indigo-50/70 p-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-bold text-indigo-950">
                          局部重写第 {segment.segment_index} 段（不影响其它段）
                        </span>
                        <button type="button" onClick={() => onStartRewrite(null)} className="text-zinc-500 hover:text-zinc-900">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div className="flex gap-1.5">
                        <input
                          value={revisionDraft}
                          onChange={(e) => onRevisionDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') onRewrite(idx);
                          }}
                          placeholder="微调要求，例如：打脸不够狠，多加两句反派破防与宾客倒戈的对话"
                          className="flex-1 rounded-lg border border-indigo-300 bg-white px-2.5 py-1.5 text-[11px] text-ink outline-none focus:border-indigo-500"
                        />
                        <button
                          type="button"
                          onClick={() => onRewrite(idx)}
                          disabled={isRewriting}
                          className="flex shrink-0 items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                        >
                          {isRewriting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                          执行重写
                        </button>
                      </div>
                      <p className="text-[10px] text-indigo-900/70">
                        重写后会立即重跑六道门禁；不会重新生成其它段落，也不会改动蓝图。
                      </p>
                    </div>
                  )}

                  {text ? (
                    <div className={`nf-prose mt-3 font-serif text-[14px] leading-[1.95] text-ink ${showCaret ? 'nf-caret' : ''}`}>
                      {text.split(/\n{2,}/).map((para, pIdx) => (
                        <p key={pIdx}>{withHighlight(para, highlight)}</p>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-[11px] text-zinc-400">等待上一步完成…</p>
                  )}

                  {segment.gate && (segment.status === 'forced' || segment.status === 'rejected') && (
                    <GateDetail gate={segment.gate} defaultOpen />
                  )}

                  {segment.segment_index === segments.length && segment.gate?.golden_quote_extracted && (
                    <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/80 p-2.5">
                      <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                      <div className="text-[11px] text-amber-950">
                        <span className="font-bold">终局金句已锁定：</span>
                        <span className="font-serif italic">{segment.gate.golden_quote_extracted}</span>
                      </div>
                    </div>
                  )}

                  {segment.warnings.length > 0 && (
                    <ul className="mt-2 space-y-0.5">
                      {segment.warnings.slice(0, 3).map((w, wIdx) => (
                        <li key={wIdx} className="text-[10px] text-amber-800">
                          ⚠ {w}
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              );
            })}
          </div>
        ) : view === 'full' ? (
          <article className="mx-auto max-w-3xl space-y-5 rounded-2xl border border-line bg-white p-6 shadow-sm md:p-8">
            <header className="border-b border-line pb-3 text-center">
              <p className="font-mono text-[10px] uppercase tracking-widest text-amber-700">
                商业短故事完整完结版 · 全篇约 {(agent1?.total_char_count ?? 0) + produced} 字
              </p>
              <h2 className="mt-1 font-serif text-lg font-bold text-ink">{title}</h2>
            </header>

            <div className="nf-prose font-serif text-[14px] leading-[2] text-zinc-700">
              {sourceText.split(/\n{2,}/).map((para, idx) => (
                <p key={`src-${idx}`}>{para}</p>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <div className="h-px flex-1 bg-amber-300" />
              <span className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 font-mono text-[10px] font-bold text-amber-900">
                ▲ 卡点 · 以下为续写 {produced.toLocaleString()} 字
              </span>
              <div className="h-px flex-1 bg-amber-300" />
            </div>

            <div className="nf-prose font-serif text-[14px] leading-[2] text-ink">
              {segments.map((segment) =>
                segment.text.split(/\n{2,}/).map((para, pIdx) => (
                  <p key={`c-${segment.segment_index}-${pIdx}`}>{withHighlight(para, highlight)}</p>
                )),
              )}
            </div>
          </article>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-line bg-white p-3">
              <div>
                <p className="text-xs font-bold text-zinc-900">六道商业门禁质检报告</p>
                <p className="mt-0.5 text-[10px] text-zinc-500">
                  判定由确定性引擎执行（字数/实体/人称/衔接/套话/金句），报告可随稿件一起导出。
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={passed === segments.length ? 'emerald' : 'amber'}>
                  PASS {passed} / {segments.length}
                </Badge>
                {segments.some((s) => s.source === 'simulation') && <Badge tone="neutral">含仿真稿</Badge>}
              </div>
            </div>

            {segments.map((segment) => (
              <div key={segment.segment_index} className="rounded-2xl border border-line bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/70 pb-2">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[10px] text-zinc-400">#{segment.segment_index}</span>
                    <span className="text-[11px] font-bold text-zinc-900">{segment.segment_role}</span>
                    <Badge
                      tone={segment.gate?.status === 'PASS' ? 'emerald' : segment.gate ? 'rose' : 'neutral'}
                    >
                      {segment.gate?.status ?? '未质检'}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    {segment.gate && <GateDots gate={segment.gate} />}
                    <span className="font-mono text-[10px] text-zinc-500">{segment.word_count} 字</span>
                  </div>
                </div>
                <div className="pt-2">
                  {segment.gate ? <GateRows gate={segment.gate} /> : <p className="text-[10px] text-zinc-400">该段尚未质检</p>}
                </div>
                {segment.gate && segment.gate.revision_instructions.length > 0 && (
                  <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50/70 p-2">
                    <p className="text-[10px] font-bold text-amber-950">修订指令</p>
                    <ul className="mt-1 space-y-0.5">
                      {segment.gate.revision_instructions.map((ins, i) => (
                        <li key={i} className="text-[10px] leading-relaxed text-amber-900">
                          · {ins}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ))}

            {logs.length > 0 && (
              <div className="rounded-2xl border border-line bg-white p-3">
                <p className="mb-1.5 text-[11px] font-bold text-zinc-900">运行日志（{logs.length} 条）</p>
                <ul className="max-h-64 space-y-0.5 overflow-y-auto font-mono text-[10px]">
                  {logs
                    .slice()
                    .reverse()
                    .map((entry) => (
                      <li key={entry.id} className="flex gap-1.5">
                        <span className="shrink-0 text-zinc-400">{new Date(entry.at).toLocaleTimeString('zh-CN')}</span>
                        <span className="shrink-0 uppercase text-indigo-600">{entry.agent}</span>
                        <span className={entry.level === 'error' || entry.level === 'reject' ? 'text-rose-700' : 'text-zinc-700'}>
                          {entry.text}
                        </span>
                      </li>
                    ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function GateDetail({ gate, defaultOpen }: { gate: NonNullable<SegmentDraft['gate']>; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="mt-2 rounded-xl border border-line bg-paper p-2">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-[10px] font-bold text-zinc-700">
        <ChevronDown className="h-3 w-3" />
        六道门禁明细（{gate._meta.judged_by === 'code+llm' ? '代码 + 模型复审' : '确定性引擎'}）
        <ChevronRight className="ml-auto h-3 w-3 text-zinc-400" />
      </summary>
      <div className="pt-1.5">
        <GateRows gate={gate} />
      </div>
    </details>
  );
}
