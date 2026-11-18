import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Code2,
  Database,
  Download,
  Eye,
  EyeOff,
  FileJson,
  History,
  Lock,
  Plus,
  RefreshCw,
  Save,
  Settings,
  Terminal,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { AGENT_BY_ID, GATE_LABELS } from '../config/agentSpecs';
import { API_PRESETS } from '../config/presets';
import { safeStringify } from '../lib/json';
import type {
  Agent1Payload,
  Agent2Payload,
  AgentId,
  AgentStatus,
  ApiConfig,
  ProjectRecord,
  ProjectState,
  SegmentDraft,
  SnapshotRecord,
} from '../types';
import { Badge } from './ui';

/* ------------------------------------------------------------- API 弹窗 */

export interface ApiTestState {
  state: 'idle' | 'testing' | 'success' | 'error';
  message: string;
}

export function ApiModal({
  open,
  config,
  onClose,
  onSave,
  onTest,
  testState,
}: {
  open: boolean;
  config: ApiConfig;
  onClose: () => void;
  onSave: (cfg: ApiConfig) => void;
  onTest: (cfg: ApiConfig) => void;
  testState: ApiTestState;
}) {
  const [draft, setDraft] = useState<ApiConfig>(config);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(config);
      setShowKey(false);
    }
  }, [open, config]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-line bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="flex items-center gap-2">
            <Settings className="h-4 w-4 text-amber-600" />
            <h3 className="text-sm font-bold text-ink">BYOK · 大模型接入配置</h3>
            <Badge tone={config.apiKey ? 'emerald' : 'neutral'}>
              {config.apiKey ? '已配置' : '未配置（仿真引擎）'}
            </Badge>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-zinc-500 hover:bg-paper-3">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">
          <div>
            <p className="mb-1.5 text-[11px] font-semibold text-zinc-700">快捷厂商</p>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {API_PRESETS.map((preset) => {
                const active = draft.model === preset.model && draft.baseUrl === preset.baseUrl;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    title={preset.note}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        provider: preset.provider,
                        baseUrl: preset.baseUrl,
                        model: preset.model,
                      })
                    }
                    className={`rounded-xl border px-2 py-2 text-[11px] font-semibold transition-colors ${
                      active
                        ? 'border-zinc-900 bg-zinc-900 text-white'
                        : 'border-line bg-paper text-zinc-700 hover:border-line-strong'
                    }`}
                  >
                    {preset.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold text-zinc-700">接口协议</span>
              <select
                name="api-provider"
                value={draft.provider}
                onChange={(e) => setDraft({ ...draft, provider: e.target.value as ApiConfig['provider'] })}
                className="w-full rounded-xl border border-line-strong bg-paper px-2.5 py-2 text-[11px] text-ink outline-none"
              >
                <option value="gemini">Google Gemini 原生（支持 SSE 流式）</option>
                <option value="openai">OpenAI 兼容（/chat/completions）</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold text-zinc-700">模型名称</span>
              <input
                name="api-model"
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                className="w-full rounded-xl border border-line-strong bg-paper px-2.5 py-2 font-mono text-[11px] text-ink outline-none"
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-zinc-700">Base URL</span>
            <input
              name="api-base-url"
              value={draft.baseUrl}
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              className="w-full rounded-xl border border-line-strong bg-paper px-2.5 py-2 font-mono text-[11px] text-ink outline-none"
            />
          </label>

          <label className="block">
            <span className="mb-1 flex items-center justify-between text-[11px] font-semibold text-zinc-700">
              <span>API Key</span>
              {draft.apiKey && (
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, apiKey: '' })}
                  className="text-[10px] font-normal text-rose-600 hover:underline"
                >
                  清空
                </button>
              )}
            </span>
            <div className="relative">
              <input
                name="api-key"
                type={showKey ? 'text' : 'password'}
                value={draft.apiKey}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                placeholder="粘贴 API Key；留空则使用内置仿真引擎"
                autoComplete="off"
                className="w-full rounded-xl border border-line-strong bg-paper px-2.5 py-2 pr-9 font-mono text-[11px] text-ink outline-none"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700"
                title={showKey ? '隐藏' : '显示'}
              >
                {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 flex items-center justify-between text-[11px] font-semibold text-zinc-700">
                <span>Temperature</span>
                <span className="font-mono text-zinc-500">{draft.temperature.toFixed(2)}</span>
              </span>
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.05}
                value={draft.temperature}
                onChange={(e) => setDraft({ ...draft, temperature: Number(e.target.value) })}
                className="w-full accent-indigo-600"
              />
            </label>
            <label className="block">
              <span className="mb-1 flex items-center justify-between text-[11px] font-semibold text-zinc-700">
                <span>max tokens（单次输出上限）</span>
              </span>
              <input
                type="number"
                min={256}
                max={8192}
                step={256}
                value={draft.maxTokens}
                onChange={(e) => setDraft({ ...draft, maxTokens: Number(e.target.value) })}
                className="w-full rounded-xl border border-line-strong bg-paper px-2.5 py-2 font-mono text-[11px] text-ink outline-none"
              />
            </label>
          </div>

          <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-line bg-paper p-2.5">
            <input
              type="checkbox"
              checked={draft.persistKey}
              onChange={(e) => setDraft({ ...draft, persistKey: e.target.checked })}
              className="mt-0.5 accent-indigo-600"
            />
            <span>
              <span className="block text-[11px] font-semibold text-zinc-800">
                在本浏览器长期保存密钥（localStorage）
              </span>
              <span className="mt-0.5 block text-[10px] leading-relaxed text-zinc-500">
                不勾选时只写入 sessionStorage，关闭标签页即失效。浏览器端没有真正的密钥保护：
                共用电脑请勿勾选；需要生产级安全请改用 v5.0 的服务端代理。
              </span>
            </span>
          </label>

          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-2.5">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" />
            <p className="text-[10px] leading-relaxed text-amber-900">
              浏览器直连第三方 API 可能被 CORS 拦截（尤其 OpenAI 兼容端点）。若“测试连通性”提示网络失败，
              请换用支持 CORS 的端点，或在 v5.0 中启用服务端代理。
            </p>
          </div>

          {testState.state !== 'idle' && (
            <div
              className={`rounded-xl border p-2.5 text-[11px] leading-relaxed ${
                testState.state === 'success'
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                  : testState.state === 'error'
                    ? 'border-rose-300 bg-rose-50 text-rose-900'
                    : 'border-indigo-300 bg-indigo-50 text-indigo-900'
              }`}
            >
              {testState.state === 'testing' ? '正在发送探测请求…' : testState.message}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-line px-5 py-3">
          <button
            type="button"
            onClick={() => onTest(draft)}
            disabled={testState.state === 'testing' || !draft.apiKey}
            className="flex items-center gap-1.5 rounded-xl border border-line-strong bg-white px-3 py-2 text-[11px] font-semibold text-zinc-800 hover:bg-paper disabled:opacity-40"
          >
            {testState.state === 'testing' ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            测试连通性
          </button>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="rounded-xl px-3 py-2 text-[11px] text-zinc-600 hover:bg-paper-3">
              取消
            </button>
            <button
              type="button"
              onClick={() => onSave(draft)}
              className="flex items-center gap-1.5 rounded-xl bg-zinc-900 px-4 py-2 text-[11px] font-bold text-white hover:bg-zinc-800"
            >
              <Save className="h-3.5 w-3.5" />
              保存配置
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- Agent 检查器 */

const INSPECT_TABS = [
  { id: 'prompt', label: '系统提示词', icon: Code2 },
  { id: 'contract', label: '输出契约', icon: FileJson },
  { id: 'payload', label: '实时载荷', icon: Terminal },
  { id: 'skills', label: '挂载技能', icon: Settings },
] as const;

type InspectTab = (typeof INSPECT_TABS)[number]['id'];

export function AgentInspector({
  agentId,
  agentStatuses,
  agent1,
  agent2,
  segments,
  onClose,
}: {
  agentId: AgentId | null;
  agentStatuses: Record<AgentId, AgentStatus>;
  agent1: Agent1Payload | null;
  agent2: Agent2Payload | null;
  segments: SegmentDraft[];
  onClose: () => void;
}) {
  const [tab, setTab] = useState<InspectTab>('prompt');

  useEffect(() => {
    if (agentId) setTab('prompt');
  }, [agentId]);

  // 注意：hooks 必须在任何 return 之前调用，否则 agentId 变化时会触发
  // React error #310（Rendered more hooks than during the previous render）。
  const payload = useMemo(() => {
    if (!agentId) return {};
    if (agentId === 'agent1') return agent1 ?? { note: '尚未运行 Agent 01' };
    if (agentId === 'agent2') return agent2 ?? { note: '尚未运行 Agent 02' };
    if (agentId === 'agent3') {
      const last = segments[segments.length - 1];
      return last
        ? {
            segment_index: last.segment_index,
            draft_text: `${last.text.slice(0, 1200)}${last.text.length > 1200 ? '…' : ''}`,
            char_count: last.word_count,
            source: last.source,
            attempts: last.attempts,
          }
        : { note: '尚未运行 Agent 03' };
    }
    const last = segments[segments.length - 1];
    return last?.gate ?? { note: '尚未运行 Agent 04' };
  }, [agentId, agent1, agent2, segments]);

  if (!agentId) return null;
  const spec = AGENT_BY_ID[agentId];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-2xl flex-col border-l border-line bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-2 border-b border-line px-5 py-3">
          <div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[10px] font-bold text-amber-700">{spec.code}</span>
              <span className="font-mono text-[10px] text-zinc-500">· {spec.en_name}</span>
              <Badge tone={agentStatuses[agentId] === 'pass' ? 'emerald' : agentStatuses[agentId] === 'running' ? 'indigo' : 'neutral'}>
                {agentStatuses[agentId]}
              </Badge>
            </div>
            <h3 className="mt-0.5 text-base font-bold text-ink">{spec.name}</h3>
            <p className="text-[10px] text-zinc-500">{spec.models}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg bg-paper-3 p-2 text-zinc-700 hover:bg-paper-2">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex gap-1 border-b border-line bg-paper-2 px-3 py-1.5">
          {INSPECT_TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold transition-colors ${
                tab === id ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800'
              }`}
            >
              <Icon className="h-3 w-3" />
              {label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {tab === 'prompt' && (
            <pre className="whitespace-pre-wrap rounded-xl border border-line bg-paper p-3.5 font-mono text-[11px] leading-relaxed text-zinc-800">
              {spec.system_prompt}
            </pre>
          )}
          {tab === 'contract' && (
            <pre className="whitespace-pre-wrap rounded-xl border border-line bg-paper p-3.5 font-mono text-[11px] leading-relaxed text-zinc-800">
              {spec.output_contract}
            </pre>
          )}
          {tab === 'payload' && (
            <pre className="max-h-full overflow-auto whitespace-pre-wrap break-all rounded-xl bg-zinc-900 p-3.5 font-mono text-[10px] leading-relaxed text-emerald-300">
              {safeStringify(payload)}
            </pre>
          )}
          {tab === 'skills' && (
            <div className="space-y-2">
              {spec.skills.map((skill) => (
                <div key={skill.name} className="rounded-xl border border-line bg-paper p-3">
                  <div className="flex items-center justify-between gap-2">
                    <code className="text-[11px] font-bold text-indigo-700">{skill.name}</code>
                    <Badge tone="indigo">{skill.type}</Badge>
                  </div>
                  <p className="mt-1 text-[10px] leading-relaxed text-zinc-600">{skill.desc}</p>
                </div>
              ))}
              {agentId === 'agent4' && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                  <p className="text-[10px] leading-relaxed text-emerald-900">
                    六道门禁的判定由 <code>src/lib/gates.ts</code> 中的确定性函数执行，
                    可用 <code>npm test</code> 复现；LLM 复审只在用户开启时叠加，且不能推翻代码判定的 FAIL。
                  </p>
                  <div className="mt-1.5 grid grid-cols-2 gap-1 text-[10px] text-emerald-900">
                    {Object.entries(GATE_LABELS).map(([key, label]) => (
                      <span key={key}>· {label}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-line px-5 py-2.5">
          <p className="font-mono text-[10px] text-zinc-400">schema: {spec.schema_name}</p>
          <button type="button" onClick={onClose} className="rounded-lg bg-zinc-900 px-3 py-1.5 text-[11px] font-semibold text-white">
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ 作品草稿箱 */

export function ProjectsDrawer({
  open,
  projects,
  currentId,
  snapshots,
  persistence,
  onClose,
  onOpenProject,
  onCreate,
  onDelete,
  onSnapshot,
  onRestore,
  onRefreshSnapshots,
  lastSavedAt,
  onExportArchive,
  onImportArchive,
  snapshotLimit,
}: {
  open: boolean;
  projects: ProjectRecord[];
  currentId: string | null;
  snapshots: SnapshotRecord[];
  persistence: 'idb' | 'memory';
  onClose: () => void;
  onOpenProject: (record: ProjectRecord) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onSnapshot: () => void;
  onRestore: (snapshotId: string) => void;
  onRefreshSnapshots: () => void;
  lastSavedAt: number | null;
  onExportArchive: () => void;
  onImportArchive: (file: File) => void;
  snapshotLimit: number;
}) {
  const openedRef = useRef(open);
  useEffect(() => {
    if (open && !openedRef.current) onRefreshSnapshots();
    openedRef.current = open;
  }, [open, onRefreshSnapshots]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-indigo-600" />
            <h3 className="text-sm font-bold text-ink">作品草稿箱</h3>
            <Badge tone={persistence === 'idb' ? 'emerald' : 'amber'}>
              {persistence === 'idb' ? 'IndexedDB 持久化' : '内存模式（刷新即失效）'}
            </Badge>
            {lastSavedAt && (
              <span className="font-mono text-[10px] text-zinc-400">
                最近保存 {new Date(lastSavedAt).toLocaleTimeString('zh-CN')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onExportArchive}
              disabled={projects.length === 0}
              title="把全部作品与快照导出为一个 JSON 归档"
              className="flex items-center gap-1 rounded-lg border border-line bg-white px-2 py-1.5 text-[10px] font-semibold text-zinc-700 hover:border-line-strong disabled:opacity-40"
            >
              <Download className="h-3 w-3" />
              导出全部
            </button>
            <label
              title="从归档 JSON 恢复作品与快照（重复会另存为新作品）"
              className="flex cursor-pointer items-center gap-1 rounded-lg border border-line bg-white px-2 py-1.5 text-[10px] font-semibold text-zinc-700 hover:border-line-strong"
            >
              <Upload className="h-3 w-3" />
              导入归档
              <input
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onImportArchive(file);
                  e.target.value = '';
                }}
              />
            </label>
            <button
              type="button"
              onClick={onCreate}
              className="flex items-center gap-1 rounded-lg border border-line bg-white px-2 py-1.5 text-[10px] font-semibold text-zinc-700 hover:border-line-strong"
            >
              <Plus className="h-3 w-3" />
              新建
            </button>
            <button type="button" onClick={onClose} className="rounded-lg p-1 text-zinc-500 hover:bg-paper-3">
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <p className="text-[11px] font-bold text-zinc-800">我的作品（{projects.length}）</p>
            {projects.length === 0 && (
              <p className="rounded-xl border border-dashed border-line-strong bg-paper p-4 text-center text-[10px] text-zinc-500">
                还没有作品。点击“新建”或直接开始写作，系统会自动保存草稿。
              </p>
            )}
            {projects.map((project) => {
              const active = project.id === currentId;
              return (
                <div
                  key={project.id}
                  className={`rounded-xl border p-2.5 transition-colors ${
                    active ? 'border-indigo-300 bg-indigo-50/60' : 'border-line bg-paper hover:border-line-strong'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <button type="button" onClick={() => onOpenProject(project)} className="min-w-0 flex-1 text-left">
                      <p className="truncate text-[11px] font-bold text-zinc-900">{project.title}</p>
                      <p className="mt-0.5 text-[10px] text-zinc-500">
                        {project.state.agent1
                          ? `${project.state.agent1.total_char_count.toLocaleString()} 字前文 · `
                          : ''}
                        {project.state.segments.filter((s) => s.text).length} 段稿件 ·{' '}
                        {new Date(project.updated_at).toLocaleString('zh-CN', {
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(project.id)}
                      title="删除该项目及其快照"
                      className="rounded p-1 text-zinc-400 hover:bg-rose-50 hover:text-rose-600"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-bold text-zinc-800">
                版本快照（{snapshots.length}/{snapshotLimit}）
              </p>
              <button
                type="button"
                onClick={onSnapshot}
                disabled={!currentId}
                className="flex items-center gap-1 rounded-lg border border-line bg-white px-2 py-1 text-[10px] font-semibold text-zinc-700 hover:border-line-strong disabled:opacity-40"
              >
                <History className="h-3 w-3" />
                快照当前
              </button>
            </div>
            {snapshots.length === 0 && (
              <p className="rounded-xl border border-dashed border-line-strong bg-paper p-4 text-center text-[10px] text-zinc-500">
                尚无快照。生成正文后点击“快照当前”，可在改写前保留可回滚的版本。
              </p>
            )}
            {snapshots.map((snap) => (
              <div key={snap.id} className="rounded-xl border border-line bg-paper p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1">
                      <Badge tone={snap.kind === 'auto' ? 'indigo' : 'neutral'}>
                        {snap.kind === 'auto' ? '自动' : '手动'}
                      </Badge>
                      <p className="truncate text-[11px] font-semibold text-zinc-800">
                        {snap.reason ?? snap.label}
                      </p>
                    </div>
                    <p className="text-[10px] text-zinc-500">
                      {new Date(snap.created_at).toLocaleString('zh-CN')} ·{' '}
                      {snap.payload.segments.reduce((n, s) => n + s.word_count, 0).toLocaleString()} 字
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRestore(snap.id)}
                    className="shrink-0 rounded-lg border border-line bg-white px-2 py-1 text-[10px] font-semibold text-zinc-700 hover:border-line-strong"
                  >
                    回滚
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-line bg-paper-2 px-5 py-2.5">
          <p className="flex items-center gap-1 text-[10px] text-zinc-500">
            {persistence === 'idb' ? (
              <>
                <Check className="h-3 w-3 text-emerald-600" />
                数据只存在本机浏览器，不会上传；换浏览器/清缓存会丢失 → 用「导出全部」把作品与快照一起带走
              </>
            ) : (
              <>
                <AlertTriangle className="h-3 w-3 text-amber-600" />
                当前浏览器禁用 IndexedDB，草稿仅保存在内存中，刷新即丢失，请及时导出归档
              </>
            )}
          </p>
          <button type="button" onClick={onClose} className="rounded-lg bg-zinc-900 px-3 py-1.5 text-[11px] font-semibold text-white">
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}

export function snapshotLabel(state: ProjectState): string {
  const words = state.segments.reduce((n, s) => n + s.word_count, 0);
  return `快照 · ${new Date().toLocaleTimeString('zh-CN')} · ${words} 字`;
}
