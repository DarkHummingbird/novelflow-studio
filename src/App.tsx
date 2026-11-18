import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TopBar } from './components/TopBar';
import { LeftPanel } from './components/LeftPanel';
import { BlueprintPanel } from './components/BlueprintPanel';
import { ReaderPanel, type ReaderView } from './components/ReaderPanel';
import { ApiModal, AgentInspector, ProjectsDrawer, snapshotLabel, type ApiTestState } from './components/Modals';
import { Toast, type ToastData } from './components/ui';
import { DEFAULT_API_CONFIG, DEFAULT_DIRECTION, SAMPLE_TEXT } from './config/presets';
import { isApiConfigured, pingLLM } from './lib/api';
import { buildContractJson, buildMarkdown, buildPlainText, copyText, downloadText, safeFilename } from './lib/export';
import { buildArchive, parseArchive, planImport } from './lib/archive';
import { buildShowcase } from './config/showcase';
import { uuid } from './lib/idb';
import { describeSource, rewriteOneSegment, runPipeline, type PipelineHooks } from './lib/pipeline';
import { useProjectStore } from './hooks/useProjectStore';
import { countWords } from './lib/text';
import type {
  Agent1Payload,
  Agent2Payload,
  AgentId,
  AgentStatus,
  ApiConfig,
  Beats,
  LogEntry,
  ProgressState,
  ProjectRecord,
  ProjectState,
  SegmentDraft,
  SourceType,
  TargetTierId,
  WorkspaceMode,
} from './types';

const CFG_KEY = 'novelflow_api_v4';
/** 页面隐藏时的同步应急快照：IndexedDB 的异步写可能来不及在卸载前完成 */
const EMERGENCY_KEY = 'novelflow_emergency_v4';
const BEAT_PREFIX: Record<keyof Beats, string> = { qi: '起', cheng: '承', zhuan: '转', he: '合' };

function loadApiConfig(): ApiConfig {
  try {
    const raw = localStorage.getItem(CFG_KEY) ?? sessionStorage.getItem(CFG_KEY);
    if (raw) return { ...DEFAULT_API_CONFIG, ...(JSON.parse(raw) as Partial<ApiConfig>) };
  } catch {
    /* 忽略损坏的本地配置 */
  }
  return DEFAULT_API_CONFIG;
}

function persistApiConfig(cfg: ApiConfig): void {
  try {
    const serialized = JSON.stringify(cfg);
    if (cfg.persistKey) {
      localStorage.setItem(CFG_KEY, serialized);
      sessionStorage.removeItem(CFG_KEY);
    } else {
      sessionStorage.setItem(CFG_KEY, serialized);
      localStorage.removeItem(CFG_KEY);
    }
  } catch {
    /* 隐私模式忽略 */
  }
}

const EMPTY_PROGRESS: ProgressState = { percent: 0, label: '', active_segment: 0, total_segments: 0 };
const EMPTY_STATUSES: Record<AgentId, AgentStatus> = {
  agent1: 'idle',
  agent2: 'idle',
  agent3: 'idle',
  agent4: 'idle',
};

/** 用前文第一句给项目起个像样的名字，而不是“短故事_11/19 01:29” */
function deriveProjectTitle(text: string): string {
  const first = text
    .trim()
    .replace(/^#+\s*/, '')
    .split(/[。！？\n]/)
    .map((part) => part.trim())
    .find((part) => part.length >= 6);
  const clean = (first ?? '').replace(/[《》“”"'‘’]/g, '').slice(0, 16);
  return clean || `未命名短故事_${new Date().toISOString().slice(5, 10)}`;
}

let uiLogSeq = 0;
function uiLog(agent: AgentId | 'system', level: LogEntry['level'], text: string): LogEntry {
  uiLogSeq += 1;
  return { id: `ui-${Date.now()}-${uiLogSeq}`, at: Date.now(), agent, level, text };
}

export default function App() {
  /* ------------------------------------------------------------- 基础 UI */
  const [mode, setMode] = useState<WorkspaceMode>('creator');
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [view, setView] = useState<ReaderView>('segments');
  const [highlight, setHighlight] = useState(true);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [copied, setCopied] = useState(false);

  /* --------------------------------------------------------------- 配置 */
  const [apiConfig, setApiConfig] = useState<ApiConfig>(loadApiConfig);
  const [apiModalOpen, setApiModalOpen] = useState(false);
  const [apiTest, setApiTest] = useState<ApiTestState>({ state: 'idle', message: '' });
  const [inspectAgent, setInspectAgent] = useState<AgentId | null>(null);
  const [projectsOpen, setProjectsOpen] = useState(false);

  /* --------------------------------------------------------------- 输入 */
  const [sourceText, setSourceText] = useState(SAMPLE_TEXT);
  const [sourceType, setSourceType] = useState<SourceType>('raw_text');
  const [direction, setDirection] = useState(DEFAULT_DIRECTION);
  const [targetTierId, setTargetTierId] = useState<TargetTierId>('standard');
  const [reviewWithLLM, setReviewWithLLM] = useState(false);
  const [maxRevision, setMaxRevision] = useState(1);

  /* --------------------------------------------------------------- 产物 */
  const [agent1, setAgent1] = useState<Agent1Payload | null>(null);
  const [agent2, setAgent2] = useState<Agent2Payload | null>(null);
  const [segments, setSegments] = useState<SegmentDraft[]>([]);
  const [streaming, setStreaming] = useState<Record<number, string>>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState<ProgressState>(EMPTY_PROGRESS);
  const [memoryBanner, setMemoryBanner] = useState('');
  const [engine, setEngine] = useState<'idle' | 'live' | 'simulation'>('idle');
  const [statuses, setStatuses] = useState<Record<AgentId, AgentStatus>>(EMPTY_STATUSES);
  const [isRunning, setIsRunning] = useState(false);
  const [rewritingIndex, setRewritingIndex] = useState<number | null>(null);
  const [revisionDraft, setRevisionDraft] = useState('');
  const [isRewriting, setIsRewriting] = useState(false);

  /* --------------------------------------------------------------- 项目 */
  const store = useProjectStore();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectTitle, setProjectTitle] = useState('未命名作品');
  const [snapshots, setSnapshots] = useState<Awaited<ReturnType<typeof store.snapshotsOf>>>([]);

  const latestStateRef = useRef<ProjectState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const rewriteAbortRef = useRef<AbortController | null>(null);
  const bootstrapped = useRef(false);

  const apiReady = isApiConfigured(apiConfig);
  // 只有显式带 ?sim=1 时才允许无模型的仿真演示（内部测试用，普通用户看不到入口）
  const simAllowed = useMemo(
    () => new URLSearchParams(window.location.search).get('sim') === '1',
    [],
  );
  const canRun = apiReady || simAllowed;
  const showcase = useMemo(() => buildShowcase(), []);
  const diagnostics = useMemo(() => describeSource(sourceText), [sourceText]);
  const producedWords = segments.reduce((n, s) => n + s.word_count, 0);

  const notify = useCallback((kind: ToastData['kind'], text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 5200);
  }, []);

  const requireModel = useCallback(() => {
    notify('err', '续写需要真实模型：请先在右上角「配置 API」接入模型。');
    setApiTest({ state: 'idle', message: '' });
    setApiModalOpen(true);
  }, [notify]);

  /* --------------------------------------------------------- 状态打包 */
  const buildState = useCallback(
    (): ProjectState => ({
      source_text: sourceText,
      source_type: sourceType,
      direction,
      target_tier_id: targetTierId,
      agent1,
      agent2,
      segments,
      logs,
      memory_banner: memoryBanner,
      progress,
      engine,
    }),
    [sourceText, sourceType, direction, targetTierId, agent1, agent2, segments, logs, memoryBanner, progress, engine],
  );

  const applyState = useCallback((state: ProjectState) => {
    setSourceText(state.source_text);
    setSourceType(state.source_type);
    setDirection(state.direction);
    setTargetTierId(state.target_tier_id);
    setAgent1(state.agent1);
    setAgent2(state.agent2);
    setSegments(state.segments);
    setLogs(state.logs);
    setMemoryBanner(state.memory_banner);
    setProgress(state.progress);
    setEngine(state.engine);
    setStreaming({});
  }, []);

  /* -------------------------------------------------------- 自动快照 */
  const lastAutoFingerprint = useRef('');
  const autoSnapshot = useCallback(
    async (reason: string) => {
      if (!agent1) return;
      const hasContent = segments.some((s) => s.text.length > 0) || Boolean(agent2);
      if (!hasContent) return;
      const fingerprint = `${segments.map((s) => `${s.segment_index}:${s.text.length}`).join('|')}#${
        agent2 ? agent2.segment_outlines.map((o) => o.target_words).join(',') : ''
      }`;
      if (fingerprint === lastAutoFingerprint.current) return;
      const state = buildState();
      let id = projectId;
      if (!id) {
        const record = await store.upsert(null, projectTitle, state);
        id = record.id;
        setProjectId(id);
      }
      const words = segments.reduce((n, s) => n + s.word_count, 0);
      const size = words > 0 ? `${words.toLocaleString()} 字` : '仅蓝图';
      await store.takeSnapshot(id, `自动 · ${reason} · ${size}`, state, 'auto', reason);
      lastAutoFingerprint.current = fingerprint;
      void store.snapshotsOf(id).then(setSnapshots);
    },
    [agent1, agent2, buildState, projectId, projectTitle, segments, store],
  );

  /* ------------------------------------------------------ 启动时恢复草稿 */
  useEffect(() => {
    if (!store.ready || bootstrapped.current) return;
    bootstrapped.current = true;
    const latest = store.projects[0];

    // 先看有没有"关闭前未落盘"的同步快照
    let recoveredFromEmergency = false;
    try {
      const raw = localStorage.getItem(EMERGENCY_KEY);
      if (raw) {
        const emergency = JSON.parse(raw) as { saved_at?: number; state?: ProjectState };
        if (emergency.state && typeof emergency.saved_at === 'number') {
          if (!latest || emergency.saved_at > latest.updated_at) {
            applyState(emergency.state);
            if (latest) {
              setProjectId(latest.id);
              setProjectTitle(latest.title);
            }
            recoveredFromEmergency = true;
            notify('info', '已恢复上次关闭前尚未落盘的编辑。');
          }
        }
        localStorage.removeItem(EMERGENCY_KEY);
      }
    } catch {
      /* 隐私模式或损坏数据：忽略 */
    }

    if (!recoveredFromEmergency && latest) {
      applyState(latest.state);
      setProjectId(latest.id);
      setProjectTitle(latest.title);
      notify('info', `已从草稿箱恢复《${latest.title}》，可继续断点续写。`);
    }
  }, [store.ready, store.projects, applyState, notify]);

  /* --------------------------------------------------------- 自动保存 */
  const { scheduleUpsert } = store;
  useEffect(() => {
    if (!store.ready) return;
    // 只要前文有实质内容就落盘：不能等到跑完流水线才保存，
    // 否则"粘贴 3000 字后刷新"就会整段丢失。
    if (!agent1 && segments.length === 0 && sourceText.trim().length < 20) return;
    scheduleUpsert(projectId, projectTitle, buildState(), {
      onSaved: (record) => {
        // 首次保存时把 id 收回来，后续编辑就是同一个项目的增量更新
        setProjectId((prev) => prev ?? record.id);
      },
    });
  }, [scheduleUpsert, store.ready, projectId, projectTitle, buildState, agent1, segments.length, sourceText]);

  /* ------------------------------------------- 页面隐藏前强制落盘 */
  useEffect(() => {
    latestStateRef.current = buildState();
  });

  useEffect(() => {
    const save = () => {
      // 1) 同步写应急快照：一定能在卸载前完成
      try {
        const state = latestStateRef.current;
        if (state) {
          localStorage.setItem(EMERGENCY_KEY, JSON.stringify({ saved_at: Date.now(), state }));
        }
      } catch {
        /* 配额/隐私模式：忽略，仍有下面的异步落盘兜底 */
      }
      // 2) 异步补一次完整落盘（含快照等元数据）
      void store.flush();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') save();
    };
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [store]);

  /* ------------------------------------------------------------ 运行时 */
  const makeHooks = useCallback(
    (resetLogs: boolean): PipelineHooks => {
      if (resetLogs) setLogs([]);
      return {
        onLog: (entry) => setLogs((prev) => [...prev, entry]),
        onAgent: (id, status) => setStatuses((prev) => ({ ...prev, [id]: status })),
        onAgent1: (payload) => setAgent1(payload),
        onAgent2: (payload) => setAgent2(payload),
        onSegments: (next) => setSegments(next),
        onStream: (index, text) => setStreaming((prev) => ({ ...prev, [index]: text })),
        onProgress: (next) => setProgress(next),
        onMemory: (banner) => setMemoryBanner(banner),
        onEngine: (next) => setEngine(next),
      };
    },
    [],
  );

  const runPipelineFlow = useCallback(
    async (opts: { planOnly: boolean; reuse?: boolean }) => {
      if (isRunning) return;
      if (!canRun) {
        requireModel();
        return;
      }
      if (!sourceText.trim()) {
        notify('err', '请先粘贴卡点前文，或点击“载入 4,200 字卡点样本”。');
        return;
      }
      const reuse = opts.reuse && agent1 && agent2;
      await autoSnapshot(opts.planOnly ? '生成蓝图前' : '续写前');
      setIsRunning(true);
      setStatuses(EMPTY_STATUSES);
      if (!opts.planOnly || !reuse) {
        setSegments([]);
        setStreaming({});
      }
      if (opts.planOnly) {
        setAgent2(null);
        setSegments([]);
        setStreaming({});
      }
      const controller = new AbortController();
      abortRef.current = controller;
      const titleForRun = projectTitle === '未命名作品' ? deriveProjectTitle(sourceText) : projectTitle;

      try {
        const outcome = await runPipeline(
          { text: sourceText, sourceType },
          {
            direction,
            targetTierId,
            api: apiConfig,
            reviewWithLLM,
            maxRevision,
            planOnly: opts.planOnly,
            allowSimulation: simAllowed,
            existing: reuse ? { agent1: agent1 ?? undefined, agent2: agent2 ?? undefined } : undefined,
            signal: controller.signal,
          },
          makeHooks(true),
        );
        setAgent1(outcome.agent1);
        setAgent2(outcome.agent2);
        setSegments(outcome.segments);
        setLogs(outcome.logs);
        setProgress(outcome.progress);
        setMemoryBanner(outcome.memoryBanner);
        setStreaming({});

        if (projectTitle === '未命名作品') setProjectTitle(titleForRun);

        if (outcome.aborted) {
          notify('info', '已停止：已完成的内容已保留，可继续局部重写或导出。');
        } else if (opts.planOnly) {
          notify('ok', `四拍蓝图已生成：${outcome.agent2.segment_outlines.length} 段，可逐拍修改后启动主笔。`);
          setView('segments');
        } else {
          const passedCount = outcome.segments.filter((s) => s.status === 'pass').length;
          const total = outcome.segments.length;
          notify(
            passedCount === total ? 'ok' : 'info',
            `续写完成：${total} 段 / ${outcome.segments.reduce((n, s) => n + s.word_count, 0).toLocaleString()} 字，门禁通过 ${passedCount}/${total}。`,
          );
          setView('segments');
        }
        return outcome;
      } catch (err) {
        notify('err', `流水线中断：${err instanceof Error ? err.message : String(err)}`);
        setStatuses((prev) => ({ ...prev, agent1: prev.agent1 === 'running' ? 'error' : prev.agent1 }));
        return null;
      } finally {
        abortRef.current = null;
        setIsRunning(false);
      }
    },
    [
      isRunning,
      canRun,
      requireModel,
      simAllowed,
      sourceText,
      agent1,
      agent2,
      direction,
      targetTierId,
      apiConfig,
      reviewWithLLM,
      maxRevision,
      makeHooks,
      projectTitle,
      notify,
    ],
  );

  const handleRun = useCallback(() => void runPipelineFlow({ planOnly: false }), [runPipelineFlow]);
  const handlePlan = useCallback(() => void runPipelineFlow({ planOnly: true }), [runPipelineFlow]);
  const handleWrite = useCallback(() => {
    if (agent1 && agent2) void runPipelineFlow({ planOnly: false, reuse: true });
    else void runPipelineFlow({ planOnly: false });
  }, [agent1, agent2, runPipelineFlow]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    rewriteAbortRef.current?.abort();
  }, []);

  const handleReset = useCallback(() => {
    if (isRunning) return;
    setAgent1(null);
    setAgent2(null);
    setSegments([]);
    setStreaming({});
    setLogs([]);
    setProgress(EMPTY_PROGRESS);
    setMemoryBanner('');
    setEngine('idle');
    setStatuses(EMPTY_STATUSES);
    setRewritingIndex(null);
  }, [isRunning]);

  /* --------------------------------------------------------- 蓝图编辑 */
  const handleEditBeat = useCallback((segmentIndex: number, key: keyof Beats, value: string) => {
    setAgent2((prev) => {
      if (!prev) return prev;
      const outlines = prev.segment_outlines.map((outline) => {
        if (outline.segment_index !== segmentIndex) return outline;
        return { ...outline, beats: { ...outline.beats, [key]: `${BEAT_PREFIX[key]}：${value}` } };
      });
      return { ...prev, segment_outlines: outlines };
    });
    notify('info', `第 ${segmentIndex} 段【${BEAT_PREFIX[key]}】拍已更新，写作阶段将按新细纲执行。`);
  }, [notify]);

  const handleRegenerate = useCallback(async () => {
    if (isRunning) return;
    if (!canRun) {
      requireModel();
      return;
    }
    if (!agent1) {
      void runPipelineFlow({ planOnly: true });
      return;
    }
    await autoSnapshot('重新推演蓝图前');
    setIsRunning(true);
    setAgent2(null);
    setSegments([]);
    setStatuses((prev) => ({ ...prev, agent2: 'running' }));
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const outcome = await runPipeline(
        { text: sourceText, sourceType },
        {
          direction,
          targetTierId,
          api: apiConfig,
          reviewWithLLM,
          maxRevision,
          planOnly: true,
          allowSimulation: simAllowed,
          existing: { agent1 },
          signal: controller.signal,
        },
        makeHooks(false),
      );
      setAgent1(outcome.agent1);
      setAgent2(outcome.agent2);
      setSegments(outcome.segments);
      setLogs(outcome.logs);
      setProgress(outcome.progress);
      notify('ok', '四拍蓝图已重新推演，请确认后启动主笔。');
    } catch (err) {
      notify('err', `蓝图推演失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      abortRef.current = null;
      setIsRunning(false);
    }
  }, [agent1, apiConfig, direction, isRunning, makeHooks, maxRevision, notify, reviewWithLLM, sourceText, sourceType, targetTierId, runPipelineFlow]);

  /* --------------------------------------------------------- 局部重写 */
  const handleRewrite = useCallback(
    async (index: number) => {
      if (!agent1 || !agent2 || isRewriting) return;
      if (!canRun) {
        requireModel();
        return;
      }
      await autoSnapshot(`重写第 ${index + 1} 段前`);
      setIsRewriting(true);
      const controller = new AbortController();
      rewriteAbortRef.current = controller;
      setStatuses((prev) => ({ ...prev, agent3: 'running', agent4: 'idle' }));
      try {
        const result = await rewriteOneSegment({
          api: apiConfig,
          agent1,
          agent2,
          segments,
          index,
          instruction: revisionDraft,
          signal: controller.signal,
          onStream: (text) => setStreaming((prev) => ({ ...prev, [index]: text })),
        });
        setSegments((prev) =>
          prev.map((segment, i) =>
            i === index
              ? {
                  ...segment,
                  text: result.text,
                  word_count: countWords(result.text),
                  gate: result.gate,
                  source: result.source,
                  status: result.gate.status === 'PASS' ? 'pass' : 'forced',
                  attempts: segment.attempts + 1,
                  warnings: result.warnings.concat(result.gate.revision_instructions),
                }
              : segment,
          ),
        );
        setStatuses((prev) => ({
          ...prev,
          agent3: 'pass',
          agent4: result.gate.status === 'PASS' ? 'pass' : 'reject',
        }));
        setLogs((prev) => [
          ...prev,
          uiLog(
            'agent4',
            result.gate.status === 'PASS' ? 'pass' : 'reject',
            `第 ${index + 1} 段局部重写完成 · 门禁 ${result.gate.status} · ${countWords(result.text)} 字`,
          ),
        ]);
        setRewritingIndex(null);
        setRevisionDraft('');
        notify(
          result.gate.status === 'PASS' ? 'ok' : 'info',
          result.gate.status === 'PASS'
            ? `第 ${index + 1} 段重写完成并通过六道门禁。`
            : `第 ${index + 1} 段已重写，但仍有门禁未通过，详见门禁报告。`,
        );
      } catch (err) {
        if (controller.signal.aborted) notify('info', '已取消局部重写。');
        else notify('err', `局部重写失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setStreaming((prev) => {
          const next = { ...prev };
          delete next[index];
          return next;
        });
        rewriteAbortRef.current = null;
        setIsRewriting(false);
      }
    },
    [agent1, agent2, apiConfig, isRewriting, notify, revisionDraft, segments],
  );

  /* ------------------------------------------------------------ 导出 */
  const exportMarkdown = useCallback(() => {
    downloadText(safeFilename(projectTitle, 'md'), buildMarkdown(buildState(), projectTitle), 'text/markdown;charset=utf-8');
    notify('ok', '已导出 Markdown 完结版（含六道门禁报告）。');
  }, [buildState, notify, projectTitle]);

  const exportTxt = useCallback(() => {
    downloadText(safeFilename(projectTitle, 'txt'), buildPlainText(buildState(), projectTitle));
    notify('ok', '已导出纯文本稿。');
  }, [buildState, notify, projectTitle]);

  const exportJson = useCallback(() => {
    downloadText(
      safeFilename(projectTitle, 'json'),
      buildContractJson(buildState(), projectTitle),
      'application/json;charset=utf-8',
    );
    notify('ok', '已导出 Agent 交接契约 JSON（可交给后端复现）。');
  }, [buildState, notify, projectTitle]);

  const handleCopy = useCallback(async () => {
    const ok = await copyText(buildMarkdown(buildState(), projectTitle));
    setCopied(ok);
    window.setTimeout(() => setCopied(false), 2000);
    notify(ok ? 'ok' : 'err', ok ? '完整稿件已复制到剪贴板。' : '复制失败：浏览器拦截了剪贴板权限。');
  }, [buildState, notify, projectTitle]);

  /* ------------------------------------------------------------ API */
  const handleSaveApi = useCallback(
    (cfg: ApiConfig) => {
      setApiConfig(cfg);
      persistApiConfig(cfg);
      setApiModalOpen(false);
      notify(
        isApiConfigured(cfg) ? 'ok' : 'info',
        isApiConfigured(cfg)
          ? `已切换到真实模型：${cfg.model}${cfg.persistKey ? '（密钥已持久化）' : '（密钥仅本次会话有效）'}`
          : '已清空密钥，将使用内置仿真引擎。',
      );
    },
    [notify],
  );

  const handleTestApi = useCallback(
    async (cfg: ApiConfig) => {
      setApiTest({ state: 'testing', message: '' });
      const res = await pingLLM(cfg);
      setApiTest({ state: res.ok ? 'success' : 'error', message: res.message });
    },
    [],
  );

  /* ------------------------------------------------------------ 项目 */
  const handleOpenProject = useCallback(
    (record: ProjectRecord) => {
      applyState(record.state);
      setProjectId(record.id);
      setProjectTitle(record.title);
      setProjectsOpen(false);
      setStatuses(EMPTY_STATUSES);
      notify('info', `已打开《${record.title}》。`);
    },
    [applyState, notify],
  );

  const handleCreateProject = useCallback(async () => {
    const title = `未命名作品 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
    const record = await store.upsert(null, title, buildState());
    setProjectId(record.id);
    setProjectTitle(title);
    setProjectsOpen(false);
    notify('ok', '已新建作品，编辑将自动保存。');
  }, [buildState, notify, store]);

  const handleDeleteProject = useCallback(
    async (id: string) => {
      await store.remove(id);
      if (id === projectId) {
        setProjectId(null);
        setProjectTitle('未命名作品');
      }
      setSnapshots([]);
      notify('info', '作品已删除。');
    },
    [notify, projectId, store],
  );

  const refreshSnapshots = useCallback(async () => {
    if (!projectId) {
      setSnapshots([]);
      return;
    }
    setSnapshots(await store.snapshotsOf(projectId));
  }, [projectId, store]);

  useEffect(() => {
    if (projectsOpen) void refreshSnapshots();
  }, [projectsOpen, refreshSnapshots]);

  const handleSnapshot = useCallback(async () => {
    if (!projectId) {
      notify('err', '请先保存一个作品再创建快照。');
      return;
    }
    const record = await store.upsert(projectId, projectTitle, buildState());
    setProjectId(record.id);
    await store.takeSnapshot(record.id, snapshotLabel(buildState()), buildState(), 'manual');
    await refreshSnapshots();
    notify('ok', '已创建版本快照，可随时回滚。');
  }, [buildState, notify, projectId, projectTitle, refreshSnapshots, store]);

  const handleRestoreSnapshot = useCallback(
    async (snapshotId: string) => {
      const state = await store.restore(snapshotId);
      if (!state) {
        notify('err', '快照读取失败。');
        return;
      }
      applyState(state);
      setProjectsOpen(false);
      notify('ok', '已回滚到快照版本（当前未保存的改动将被覆盖）。');
    },
    [applyState, notify, store],
  );

  const handleExportArchive = useCallback(async () => {
    try {
      const snaps = await store.allSnapshots();
      const archive = buildArchive(store.projects, snaps);
      downloadText(`NovelFlow归档_${new Date().toISOString().slice(0, 10)}.json`, archive, 'application/json;charset=utf-8');
      notify('ok', `已导出归档：${store.projects.length} 个作品 / ${snaps.length} 个快照`);
    } catch (err) {
      notify('err', `导出归档失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [notify, store]);

  const handleImportArchive = useCallback(
    async (file: File) => {
      try {
        const parsed = parseArchive(await file.text());
        const existing = new Set(store.projects.map((p) => p.id));
        // id 冲突说明是重复导入：给作品名加后缀，避免草稿箱里出现两条同名作品
        const plan = planImport(parsed.projects, existing, uuid).map((item, i) => {
          const original = parsed.projects[i];
          if (!original || item.project.id === original.id) return item;
          return { ...item, project: { ...item.project, title: `${item.project.title}（导入）` } };
        });
        const count = await store.importProjects(plan);
        await store.refresh();
        notify(
          'ok',
          `已导入 ${count} 个作品 / ${parsed.snapshotCount} 个快照（${parsed.totalWords.toLocaleString()} 字）`,
        );
        setProjectsOpen(true);
      } catch (err) {
        notify('err', `导入失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [notify, store],
  );

  const handleLoadSample = useCallback(() => {
    if (isRunning) return;
    setSourceText(SAMPLE_TEXT);
    setProjectTitle('《离婚协议拍在白月光脸上》示例');
    setAgent1(null);
    setAgent2(null);
    setSegments([]);
    setStreaming({});
    setLogs([]);
    setProgress(EMPTY_PROGRESS);
    setEngine('idle');
    setStatuses(EMPTY_STATUSES);
    notify('info', '已载入 4,200 字卡点样本，可直接生成蓝图或一键续写。');
  }, [isRunning, notify]);

  /* ------------------------------------------------------- 快捷键 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        if (!isRunning) handleRun();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleRun, isRunning]);

  /* ------------------------------------------------------------ 渲染 */
  const inputPanel = (
    <LeftPanel
      sourceText={sourceText}
      onSourceTextChange={setSourceText}
      sourceType={sourceType}
      onSourceType={(t) => {
        setSourceType(t);
        setStatuses(EMPTY_STATUSES);
      }}
      direction={direction}
      onDirection={setDirection}
      targetTierId={targetTierId}
      onTargetTierId={setTargetTierId}
      agent1={agent1}
      diagnostics={diagnostics}
      onLoadSample={handleLoadSample}
      canRun={canRun}
      onConfigure={requireModel}
      onAnalyze={() => void handlePlan()}
      running={isRunning}
      hasBlueprint={Boolean(agent2)}
      reviewWithLLM={reviewWithLLM}
      onReviewWithLLM={setReviewWithLLM}
      maxRevision={maxRevision}
      onMaxRevision={setMaxRevision}
      onCollapse={() => setLeftCollapsed(true)}
    />
  );

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink lg:h-screen lg:overflow-hidden">
      <TopBar
        mode={mode}
        onMode={setMode}
        agentStatuses={statuses}
        onInspect={(id) => setInspectAgent(id)}
        isRunning={isRunning}
        onRun={handleRun}
        onPlan={() => void handlePlan()}
        onStop={handleStop}
        onReset={handleReset}
        apiConfigured={apiReady}
        canRun={canRun}
        apiModel={apiConfig.model}
        onOpenApi={() => {
          setApiTest({ state: 'idle', message: '' });
          setApiModalOpen(true);
        }}
        onOpenProjects={() => setProjectsOpen(true)}
        projectTitle={projectTitle}
        savedAt={store.lastSavedAt}
        persistence={store.persistence}
      />

      <main className="mx-auto flex w-full max-w-[1920px] flex-1 flex-col gap-3 p-3 lg:min-h-0 lg:flex-row">
        {!leftCollapsed && (
          <div className="flex min-h-[520px] flex-col lg:min-h-0 lg:w-[25%] lg:min-w-[300px]">{inputPanel}</div>
        )}
        <div className={`flex min-h-[520px] flex-col lg:min-h-0 ${leftCollapsed ? 'lg:w-[42%]' : 'lg:w-[31%]'} lg:min-w-[340px]`}>
          <BlueprintPanel
            agent1={agent1}
            agent2={agent2}
            targetTierId={targetTierId}
            mode={mode}
            running={isRunning}
            hasSegments={segments.some((s) => s.text.length > 0)}
            onEditBeat={handleEditBeat}
            onRegenerate={() => void handleRegenerate()}
            onWrite={handleWrite}
            onInspect={() => setInspectAgent('agent2')}
            onExpandLeft={() => setLeftCollapsed(false)}
            isLeftCollapsed={leftCollapsed}
          />
        </div>
        <div className="flex min-h-[640px] flex-1 flex-col lg:min-h-0">
          <ReaderPanel
            segments={segments}
            streaming={streaming}
            isRunning={isRunning}
            progress={progress}
            memoryBanner={memoryBanner}
            logs={logs}
            mode={mode}
            engine={engine}
            view={view}
            onView={setView}
            highlight={highlight}
            onHighlight={setHighlight}
            sourceText={sourceText}
            agent1={agent1}
            title={projectTitle}
            isLeftCollapsed={leftCollapsed}
            onExpandLeft={() => setLeftCollapsed(false)}
            rewritingIndex={rewritingIndex}
            onStartRewrite={setRewritingIndex}
            revisionDraft={revisionDraft}
            onRevisionDraft={setRevisionDraft}
            onRewrite={(index) => void handleRewrite(index)}
            isRewriting={isRewriting}
            onExportMarkdown={exportMarkdown}
            onExportTxt={exportTxt}
            onExportJson={exportJson}
            onCopy={() => void handleCopy()}
            copied={copied}
            canRun={canRun}
            onConfigure={requireModel}
            showcase={showcase}
          />
        </div>
      </main>

      <footer className="hidden shrink-0 items-center justify-between border-t border-line bg-paper-2 px-3 py-1 font-mono text-[9px] text-zinc-400 lg:flex">
        <span>
          NovelFlow Studio v4.0 · 4-Agent 流水线 · 门禁判定在 <code>src/lib/gates.ts</code> · ⌘/Ctrl + Enter
          一键续写
        </span>
        <span>
          前文 {diagnostics.chars.toLocaleString()} 字 · 续写 {producedWords.toLocaleString()} 字 ·{' '}
          {apiReady ? '真实模型' : '未配置模型'}
        </span>
      </footer>

      <ApiModal
        open={apiModalOpen}
        config={apiConfig}
        onClose={() => setApiModalOpen(false)}
        onSave={handleSaveApi}
        onTest={(cfg) => void handleTestApi(cfg)}
        testState={apiTest}
      />
      <AgentInspector
        agentId={inspectAgent}
        agentStatuses={statuses}
        agent1={agent1}
        agent2={agent2}
        segments={segments}
        onClose={() => setInspectAgent(null)}
      />
      <ProjectsDrawer
        open={projectsOpen}
        projects={store.projects}
        currentId={projectId}
        snapshots={snapshots}
        persistence={store.persistence}
        onClose={() => setProjectsOpen(false)}
        onOpenProject={handleOpenProject}
        onCreate={() => void handleCreateProject()}
        onDelete={(id) => void handleDeleteProject(id)}
        onSnapshot={() => void handleSnapshot()}
        onRestore={(id) => void handleRestoreSnapshot(id)}
        onRefreshSnapshots={() => void refreshSnapshots()}
        lastSavedAt={store.lastSavedAt}
        onExportArchive={() => void handleExportArchive()}
        onImportArchive={(file) => void handleImportArchive(file)}
        snapshotLimit={30}
      />
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
