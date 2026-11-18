import {
  BookOpen,
  Code2,
  Database,
  Eye,
  FileJson,
  Play,
  RotateCcw,
  Settings,
  Sparkles,
  Square,
  Zap,
} from 'lucide-react';
import { AGENT_SPECS } from '../config/agentSpecs';
import type { AgentId, AgentStatus, WorkspaceMode } from '../types';

const STATUS_STYLE: Record<AgentStatus, string> = {
  idle: 'bg-white text-zinc-600 border-line hover:border-line-strong',
  running: 'bg-indigo-600 text-white border-indigo-600 shadow-sm',
  pass: 'bg-emerald-50 text-emerald-900 border-emerald-300',
  reject: 'bg-rose-50 text-rose-900 border-rose-300',
  error: 'bg-rose-50 text-rose-900 border-rose-300',
};

const DOT_STYLE: Record<AgentStatus, string> = {
  idle: 'bg-zinc-300',
  running: 'bg-amber-300 animate-pulse',
  pass: 'bg-emerald-500',
  reject: 'bg-rose-500',
  error: 'bg-rose-500',
};

export interface TopBarProps {
  mode: WorkspaceMode;
  onMode: (mode: WorkspaceMode) => void;
  agentStatuses: Record<AgentId, AgentStatus>;
  onInspect: (id: AgentId) => void;
  isRunning: boolean;
  onRun: () => void;
  onPlan: () => void;
  onStop: () => void;
  onReset: () => void;
  apiConfigured: boolean;
  apiModel: string;
  onOpenApi: () => void;
  onOpenProjects: () => void;
  projectTitle: string;
  savedAt: number | null;
  persistence: 'idb' | 'memory';
}

export function TopBar(props: TopBarProps) {
  const {
    mode,
    onMode,
    agentStatuses,
    onInspect,
    isRunning,
    onRun,
    onPlan,
    onStop,
    onReset,
    apiConfigured,
    apiModel,
    onOpenApi,
    onOpenProjects,
    projectTitle,
    savedAt,
    persistence,
  } = props;

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-paper/95 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1920px] flex-wrap items-center justify-between gap-2 px-3 py-2">
        {/* 品牌 + Agent 步进条 */}
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-zinc-900 shadow-sm">
              <BookOpen className="h-4 w-4 text-amber-400" />
            </div>
            <div className="leading-tight">
              <div className="flex items-center gap-1.5">
                <h1 className="text-[13px] font-bold tracking-tight text-ink">NovelFlow Studio</h1>
                <span className="rounded border border-amber-300 bg-amber-50 px-1 py-0 font-mono text-[9px] font-bold text-amber-800">
                  v4.0
                </span>
              </div>
              <p className="hidden text-[10px] text-zinc-500 sm:block">短故事付费卡点续写工作台</p>
            </div>
          </div>

          <div className="hidden items-center rounded-xl border border-line bg-paper-3 p-0.5 md:flex">
            {AGENT_SPECS.map((spec, idx) => {
              const status = agentStatuses[spec.id];
              return (
                <button
                  key={spec.id}
                  type="button"
                  onClick={() => onInspect(spec.id)}
                  title={`${spec.name} — 点击查看 System Prompt / 契约 / 实时载荷`}
                  className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium transition-all ${STATUS_STYLE[status]}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${DOT_STYLE[status]}`} />
                  <span className="font-mono text-[10px] opacity-70">0{idx + 1}</span>
                  <span>{spec.short_title}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 右区 */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onOpenProjects}
            title="作品草稿箱：多项目、快照、回滚"
            className="hidden items-center gap-1.5 rounded-xl border border-line bg-white px-2.5 py-1.5 text-[11px] font-semibold text-zinc-700 hover:border-line-strong sm:flex"
          >
            <Database className="h-3.5 w-3.5 text-indigo-600" />
            <span className="max-w-[140px] truncate">{projectTitle}</span>
            {savedAt ? (
              <span className="font-mono text-[9px] font-normal text-emerald-700">
                {persistence === 'idb' ? '已存' : '内存'}
              </span>
            ) : null}
          </button>

          <div className="flex items-center rounded-xl border border-line bg-paper-3 p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => onMode('creator')}
              className={`flex items-center gap-1 rounded-lg px-2 py-1 font-semibold transition-colors ${
                mode === 'creator' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800'
              }`}
            >
              <Eye className="h-3.5 w-3.5 text-amber-600" />
              <span>创作视图</span>
            </button>
            <button
              type="button"
              onClick={() => onMode('architect')}
              className={`flex items-center gap-1 rounded-lg px-2 py-1 font-semibold transition-colors ${
                mode === 'architect' ? 'bg-zinc-900 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-800'
              }`}
            >
              <Code2 className="h-3.5 w-3.5 text-emerald-400" />
              <span>架构师</span>
            </button>
          </div>

          <button
            type="button"
            onClick={onOpenApi}
            className={`flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${
              apiConfigured
                ? 'border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100'
                : 'border-line bg-white text-zinc-700 hover:border-line-strong'
            }`}
            title="BYOK：配置模型 API（仅保存在本地浏览器）"
          >
            <Settings className={`h-3.5 w-3.5 ${apiConfigured ? 'text-emerald-600' : 'text-zinc-500'}`} />
            <span className="hidden max-w-[150px] truncate sm:inline">
              {apiConfigured ? `真实模型 · ${apiModel}` : '仿真引擎 · 配置 API'}
            </span>
            <span className="sm:hidden">API</span>
          </button>

          {isRunning ? (
            <button
              type="button"
              onClick={onStop}
              className="flex items-center gap-1.5 rounded-xl bg-rose-600 px-3 py-1.5 text-[11px] font-bold text-white shadow-sm hover:bg-rose-500"
            >
              <Square className="h-3 w-3 fill-current" />
              <span>停止</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={onRun}
              className="flex items-center gap-1.5 rounded-xl bg-zinc-900 px-3 py-1.5 text-[11px] font-bold text-white shadow-sm transition-colors hover:bg-zinc-800"
            >
              <Zap className="h-3.5 w-3.5 fill-current text-amber-400" />
              <span>一键全自动续写</span>
            </button>
          )}

          <button
            type="button"
            onClick={onPlan}
            disabled={isRunning}
            title="仅生成/重推四拍蓝图（不写正文）"
            className="hidden items-center gap-1 rounded-xl border border-line bg-white px-2 py-1.5 text-[11px] font-semibold text-zinc-700 hover:border-line-strong disabled:opacity-40 lg:flex"
          >
            <Sparkles className="h-3.5 w-3.5 text-amber-600" />
            蓝图
          </button>

          <button
            type="button"
            onClick={onReset}
            disabled={isRunning}
            title="清空当前工作台（不影响已保存项目）"
            className="rounded-xl border border-line bg-white p-1.5 text-zinc-500 hover:border-line-strong hover:text-zinc-900 disabled:opacity-40"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 架构师视图的契约提示条 */}
      {mode === 'architect' && (
        <div className="border-t border-line bg-zinc-900 px-3 py-1">
          <div className="mx-auto flex max-w-[1920px] items-center gap-2 font-mono text-[10px] text-emerald-300">
            <FileJson className="h-3 w-3 shrink-0" />
            <span className="truncate">
              契约模式：Agent1Payload → Agent2Payload → Agent3Draft → GateResult ｜ 判定权在确定性门禁引擎，模型仅补充修订建议
            </span>
            <span className="ml-auto hidden shrink-0 items-center gap-1 text-amber-300 sm:flex">
              <Play className="h-2.5 w-2.5" /> 点击顶部 Agent 查看提交载荷
            </span>
          </div>
        </div>
      )}
    </header>
  );
}
