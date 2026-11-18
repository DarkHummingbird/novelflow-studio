/**
 * NovelFlow Studio — 领域类型定义
 *
 * 契约字段严格对齐 PRD §4（Agent1Payload / Agent2Payload / GateResult），
 * 以 `_` 前缀命名的字段仅为前端展示与可观测性附加，不参与上下游契约。
 */

/* ------------------------------------------------------------------ 基础 */

export type AgentId = 'agent1' | 'agent2' | 'agent3' | 'agent4';
export type AgentStatus = 'idle' | 'running' | 'pass' | 'reject' | 'error';

export type Provider = 'gemini' | 'openai';

export interface ApiConfig {
  provider: Provider;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  /** true=localStorage（跨会话保留）；false=sessionStorage（关闭标签页即失效） */
  persistKey: boolean;
}

export type WorkspaceMode = 'creator' | 'architect';

/* ------------------------------------------------------- 体量路由 / 字数档 */

/** PRD §3：前文体量三档路由 */
export type LengthTier = 'EARLY_SETUP_UNDER_2500' | 'STANDARD_PAYWALL_30_45_PCT' | 'LONG_FORM_SERIAL_OVER_6000';

/** 续写目标总字数档位（PRD §1.3） */
export type TargetTierId = 'compact' | 'standard' | 'extended';

export interface TargetTier {
  id: TargetTierId;
  label: string;
  totalLabel: string;
  totalWords: number;
  desc: string;
}

export type SourceType = 'raw_text' | 'fast_screen_record';

/* ------------------------------------------------------------- Agent 1 */

export interface Agent1Payload {
  source_type: SourceType;
  cleaned_text: string;
  total_char_count: number;
  length_tier: LengthTier;
  ending_anchor: string;
  paywall_detected: boolean;
  /** 展示层附加：清洗记录与判定来源 */
  _meta: {
    paragraphs: number;
    noise_removed: string[];
    anchor_entities: string[];
    tier_label: string;
    judged_by: 'code' | 'llm';
  };
}

/* ------------------------------------------------------------- Agent 2 */

export interface Beats {
  qi: string;
  cheng: string;
  zhuan: string;
  he: string;
}

export interface SegmentOutline {
  segment_index: number;
  segment_role: string;
  /** 展示用标题提示；契约中可缺省 */
  title_hint?: string;
  target_words: number;
  beats: Beats;
}

export interface CharacterCard {
  name: string;
  role: string;
  traits: string;
  current_state: string;
}

export interface StyleFingerprint {
  avg_sentence_len: number;
  dialogue_ratio: string;
  tone_keywords: string[];
  forbidden_cliches: string[];
}

export interface StoryBible {
  pov: string;
  bait_type: string;
  style_fingerprint: StyleFingerprint;
  characters: CharacterCard[];
}

export interface Agent2Payload {
  story_bible: StoryBible;
  segment_outlines: SegmentOutline[];
  /** 展示层附加 */
  _meta: {
    plan_mode: 'three_stage' | 'early_setup' | 'arc_units';
    judged_by: 'code' | 'llm';
    route_reason: string;
  };
}

/* --------------------------------------------------------- Agent 4 门禁 */

export interface GateFlags {
  word_count_ok: boolean;
  instant_payoff_800_ok: boolean;
  character_pov_ok: boolean;
  seamless_bridge_ok: boolean;
  anti_cliche_ok: boolean;
  golden_ending_ok: boolean;
}

export interface GateResult {
  status: 'PASS' | 'REJECT';
  actual_word_count: number;
  gates: GateFlags;
  cliche_hits: string[];
  golden_quote_extracted: string;
  revision_instructions: string[];
  summary_for_next_segment: string;
  /** 展示层附加：每条门禁的判定说明与判定者 */
  _meta: {
    details: Record<keyof GateFlags, string>;
    judged_by: 'code' | 'code+llm';
    repeat_ratio: number;
  };
}

/* ------------------------------------------------------------- 段落稿件 */

export type SegmentStatus = 'pending' | 'writing' | 'pass' | 'rejected' | 'forced';

export interface SegmentDraft {
  segment_index: number;
  segment_role: string;
  title: string;
  text: string;
  word_count: number;
  status: SegmentStatus;
  gate?: GateResult;
  attempts: number;
  warnings: string[];
  /** llm=真实模型 / simulation=内置仿真引擎 / sample=内置示例脚本 */
  source: 'llm' | 'simulation' | 'sample';
}

export interface LogEntry {
  id: string;
  at: number;
  agent: AgentId | 'system';
  level: 'info' | 'warn' | 'error' | 'pass' | 'reject';
  text: string;
}

/* ----------------------------------------------------------- 工程 / 存档 */

export interface ProgressState {
  percent: number;
  label: string;
  active_segment: number;
  total_segments: number;
}

export interface PipelineOptions {
  direction: string;
  targetTierId: TargetTierId;
  api: ApiConfig;
  reviewWithLLM: boolean;
  maxRevision: number;
  signal?: AbortSignal;
  /** 只跑到 Agent 02（生成/重推蓝图），不进入撰写 */
  planOnly?: boolean;
  /** 复用已确认的 Agent1/Agent2 载荷：跳过规划，直接用（可能被用户编辑过的）蓝图写作 */
  existing?: { agent1?: Agent1Payload; agent2?: Agent2Payload };
  /** 仅测试/演示（?sim=1）才允许在无模型时用仿真引擎；产品路径下必须为 false */
  allowSimulation?: boolean;
}

export interface ProjectState {
  source_text: string;
  source_type: SourceType;
  direction: string;
  target_tier_id: TargetTierId;
  agent1: Agent1Payload | null;
  agent2: Agent2Payload | null;
  segments: SegmentDraft[];
  logs: LogEntry[];
  memory_banner: string;
  progress: ProgressState;
  engine: 'idle' | 'live' | 'simulation';
}

export interface ProjectRecord {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  state: ProjectState;
}

export interface SnapshotRecord {
  id: string;
  project_id: string;
  created_at: number;
  label: string;
  payload: ProjectState;
  /** auto = 关键动作前自动存档；manual = 用户手动快照 */
  kind?: 'auto' | 'manual';
  /** 自动快照的原因，例如「续写前」「重写第 2 段前」 */
  reason?: string;
}

export interface RunResult {
  state: ProjectState;
  aborted: boolean;
}
