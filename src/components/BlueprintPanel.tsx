import { useState } from 'react';
import { ArrowRight, Check, CircleDot, Flame, Layers, Pencil, RefreshCw, Wand2 } from 'lucide-react';
import { AGENT_BY_ID } from '../config/agentSpecs';
import { targetTierById } from '../config/presets';
import { classifyBait } from '../lib/text';
import type { Agent1Payload, Agent2Payload, Beats, TargetTierId, WorkspaceMode } from '../types';
import { Badge, EmptyState, SectionLabel } from './ui';

const BEAT_KEYS: (keyof Beats)[] = ['qi', 'cheng', 'zhuan', 'he'];
const BEAT_LABEL: Record<keyof Beats, string> = { qi: '开端', cheng: '承接', zhuan: '反转', he: '收尾' };
const BEAT_TONE: Record<keyof Beats, string> = {
  qi: 'bg-sky-50 text-sky-900 border-sky-200',
  cheng: 'bg-amber-50 text-amber-900 border-amber-200',
  zhuan: 'bg-rose-50 text-rose-900 border-rose-200',
  he: 'bg-emerald-50 text-emerald-900 border-emerald-200',
};

const PLAN_MODE_LABEL: Record<Agent2Payload['_meta']['plan_mode'], string> = {
  three_stage: '标准商业三段式',
  early_setup: '蓄势引爆三拍',
  arc_units: '分单元滚动',
};

export interface BlueprintPanelProps {
  agent1: Agent1Payload | null;
  agent2: Agent2Payload | null;
  targetTierId: TargetTierId;
  mode: WorkspaceMode;
  running: boolean;
  hasSegments: boolean;
  onEditBeat: (segmentIndex: number, key: keyof Beats, value: string) => void;
  onRegenerate: () => void;
  onWrite: () => void;
  onInspect: () => void;
  onExpandLeft: () => void;
  isLeftCollapsed: boolean;
}

export function BlueprintPanel(props: BlueprintPanelProps) {
  const {
    agent1,
    agent2,
    targetTierId,
    mode,
    running,
    hasSegments,
    onEditBeat,
    onRegenerate,
    onWrite,
    onInspect,
    onExpandLeft,
    isLeftCollapsed,
  } = props;

  const [editing, setEditing] = useState<{ seg: number; key: keyof Beats } | null>(null);
  const [draft, setDraft] = useState('');
  const tier = targetTierById(targetTierId);
  const bait = agent1 ? classifyBait(agent1.ending_anchor, agent1.cleaned_text) : null;
  const plannedWords = agent2?.segment_outlines.reduce((n, o) => n + o.target_words, 0) ?? 0;

  const startEdit = (seg: number, key: keyof Beats, value: string) => {
    setEditing({ seg, key });
    setDraft(value.replace(/^[起承转合]（.*?）：|^[起承转合]：/, ''));
  };

  const commit = () => {
    if (!editing) return;
    onEditBeat(editing.seg, editing.key, draft.trim());
    setEditing(null);
  };

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-paper-2 px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {isLeftCollapsed && (
            <button
              type="button"
              onClick={onExpandLeft}
              className="flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-1.5 py-1 text-[10px] font-semibold text-amber-900"
            >
              <ArrowRight className="h-3 w-3 rotate-180" />
              素材
            </button>
          )}
          <Layers className="h-4 w-4 shrink-0 text-indigo-600" />
          <h2 className="truncate text-xs font-bold text-ink">2. 悬念类型与分段大纲</h2>
          {agent2 && (
            <Badge tone="indigo" className="hidden sm:inline-flex">
              {PLAN_MODE_LABEL[agent2._meta.plan_mode]}
            </Badge>
          )}
        </div>
        {mode === 'architect' && agent2 && (
          <button
            type="button"
            onClick={onInspect}
            className="font-mono text-[10px] text-indigo-700 hover:underline"
          >
            Agent2Payload
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3.5">
        {!agent2 ? (
          <EmptyState
            icon={<Flame className="h-7 w-7" />}
            title="等待判断悬念类型并生成分段大纲"
            desc={
              <>
                左侧填好前文和<strong className="text-zinc-700">想怎么写</strong>之后，点“生成分段大纲”。
                大纲生成后每一段都能直接改，写正文时会严格按改过的大纲执行。
              </>
            }
          />
        ) : (
          <>
            {/* 卡点诊断 */}
            <div className="space-y-1.5 rounded-xl border border-amber-200 bg-amber-50/70 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1 text-[11px] font-bold text-amber-950">
                  <Flame className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                  悬念类型诊断
                </span>
                <span className="rounded-full bg-amber-600 px-2 py-0.5 text-[10px] font-bold text-white">
                  {agent2.story_bible.bait_type}
                </span>
              </div>
              {bait && (
                <>
                  <p className="text-[10px] leading-relaxed text-amber-900/90">
                    <strong>机制：</strong>
                    {bait.bait_mechanism}
                  </p>
                  <p className="text-[10px] leading-relaxed text-amber-900/90">
                    <strong>开头必须做到：</strong>
                    {bait.first_800w_payoff_mandate}
                  </p>
                </>
              )}
              <p className="text-[10px] text-amber-800">
                怎么判断的：{agent2._meta.judged_by === 'llm' ? '主编模型（Agent 02）' : '确定性分类器'} ·{' '}
                {agent2._meta.route_reason}
              </p>
            </div>

            {/* 人物与文风设定 */}
            <div className="space-y-1.5 rounded-xl border border-line bg-paper p-3">
              <SectionLabel icon={<CircleDot className="h-3.5 w-3.5 text-indigo-600" />}>
                人物与文风设定（人设与文风特征）
              </SectionLabel>
              <div className="flex flex-wrap gap-1">
                <Badge tone="indigo">{agent2.story_bible.pov}</Badge>
                <Badge tone="neutral">平均句长 {agent2.story_bible.style_fingerprint.avg_sentence_len} 字</Badge>
                <Badge tone="neutral">对话 {agent2.story_bible.style_fingerprint.dialogue_ratio}</Badge>
                {agent2.story_bible.style_fingerprint.tone_keywords.slice(0, 3).map((k) => (
                  <Badge key={k} tone="amber">
                    {k}
                  </Badge>
                ))}
              </div>
              <ul className="space-y-1 pt-1">
                {agent2.story_bible.characters.slice(0, 4).map((c) => (
                  <li key={`${c.name}-${c.role}`} className="text-[10px] leading-relaxed text-zinc-600">
                    <span className="font-semibold text-zinc-800">{c.name}</span>
                    <span className="text-zinc-400">（{c.role}）</span>：{c.traits}
                    <span className="text-zinc-500"> — {c.current_state}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* 分段大纲 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold text-zinc-900">
                  分段大纲
                  <span className="ml-1 font-normal text-zinc-500">
                    · 目标 {plannedWords.toLocaleString()} 字 / {agent2.segment_outlines.length} 段
                  </span>
                </span>
                <button
                  type="button"
                  onClick={onRegenerate}
                  disabled={running}
                  className="flex items-center gap-1 text-[10px] font-semibold text-indigo-700 hover:underline disabled:opacity-40"
                >
                  <RefreshCw className="h-3 w-3" />
                  重新生成
                </button>
              </div>

              {agent2.segment_outlines.map((outline, segIdx) => (
                <div key={outline.segment_index} className="space-y-1.5 rounded-xl border border-line bg-white p-2.5 shadow-sm">
                  <div className="flex items-start justify-between gap-2 border-b border-line/70 pb-1.5">
                    <div className="min-w-0">
                      <Badge tone="indigo">{outline.segment_role}</Badge>
                      {outline.title_hint && (
                        <p className="mt-1 truncate text-[11px] font-bold text-zinc-900">{outline.title_hint}</p>
                      )}
                    </div>
                    <span className="shrink-0 font-mono text-[10px] font-semibold text-zinc-600">
                      ~{outline.target_words}字
                    </span>
                  </div>

                  <div className="space-y-1">
                    {BEAT_KEYS.map((key) => {
                      const isEditing = editing?.seg === segIdx && editing.key === key;
                      const raw = outline.beats[key];
                      const text = raw.replace(/^[起承转合]（.*?）：|^[起承转合]：/, '');
                      return (
                        <div key={key} className="flex items-start gap-1.5">
                          <span
                            className={`mt-0.5 w-4 shrink-0 rounded border text-center text-[9px] font-bold leading-4 ${BEAT_TONE[key]}`}
                          >
                            {BEAT_LABEL[key]}
                          </span>
                          {isEditing ? (
                            <div className="flex flex-1 items-center gap-1">
                              <input
                                autoFocus
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') commit();
                                  if (e.key === 'Escape') setEditing(null);
                                }}
                                className="flex-1 rounded-md border border-indigo-500 bg-white px-1.5 py-0.5 text-[10px] text-zinc-900 outline-none"
                              />
                              <button
                                type="button"
                                onClick={commit}
                                className="rounded bg-emerald-600 p-0.5 text-white"
                                title="保存（Enter）"
                              >
                                <Check className="h-3 w-3" />
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => startEdit(segIdx, key, raw)}
                              className="group flex flex-1 items-start justify-between gap-1 rounded-md border border-dashed border-line px-1.5 py-0.5 text-left text-[10px] leading-relaxed text-zinc-600 hover:border-indigo-400 hover:bg-indigo-50/40"
                            >
                              <span>{text}</span>
                              <Pencil className="mt-0.5 h-2.5 w-2.5 shrink-0 text-zinc-300 group-hover:text-indigo-600" />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}

              <button
                type="button"
                onClick={onWrite}
                disabled={running}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-zinc-900 py-2.5 text-[11px] font-bold text-white shadow-sm transition-colors hover:bg-zinc-800 disabled:opacity-50"
              >
                <Wand2 className="h-3.5 w-3.5 text-amber-400" />
                {hasSegments ? `按当前大纲重写正文（${tier.totalLabel}）` : `确认大纲，开始写（${tier.totalLabel}）`}
              </button>
              {mode === 'architect' && (
                <p className="text-center font-mono text-[9px] text-zinc-400">
                  {AGENT_BY_ID.agent2.schema_name} → {AGENT_BY_ID.agent3.schema_name}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
