/** 导出与剪贴板（交付物：Markdown / TXT / 架构师 JSON 契约）。 */

import type { ProjectState } from '../types';
import { countWords } from './text';
import { GATE_ORDER } from './gates';
import { GATE_LABELS } from '../config/agentSpecs';

function gateBadge(ok: boolean): string {
  return ok ? '✅' : '❌';
}

export function buildMarkdown(state: ProjectState, title = '未命名作品'): string {
  const produced = state.segments.reduce((n, s) => n + s.word_count, 0);
  const sourceWords = countWords(state.source_text);
  const lines: string[] = [];

  lines.push(`# ${title}`);
  lines.push('');
  lines.push(
    `> 商业短故事完整完结版 ｜ 全篇约 ${(sourceWords + produced).toLocaleString()} 字（卡点前文 ${sourceWords.toLocaleString()} 字 + 续写 ${produced.toLocaleString()} 字）`,
  );
  if (state.agent1) {
    lines.push(`> 体量路由：${state.agent1._meta.tier_label} ｜ 卡点诱饵：${state.agent2?.story_bible.bait_type ?? '—'}`);
  }
  lines.push(`> 续写走向：${state.direction || '—'} ｜ 目标档位：${state.target_tier_id}`);
  lines.push(`> 导出时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 卡点前文（原文）');
  lines.push('');
  lines.push(state.source_text.trim());
  lines.push('');
  lines.push('---');
  lines.push('');

  state.segments.forEach((seg) => {
    lines.push(`## ${seg.title || seg.segment_role}`);
    lines.push('');
    lines.push(`*${seg.segment_role} ｜ ${seg.word_count} 字 ｜ ${seg.status === 'pass' ? '六道门禁 PASS' : '存在未通过门禁'}*`);
    lines.push('');
    lines.push(seg.text.trim());
    lines.push('');
  });

  lines.push('---');
  lines.push('');
  lines.push('## 附：六道商业门禁质检报告');
  lines.push('');
  state.segments.forEach((seg) => {
    if (!seg.gate) return;
    lines.push(`### 第 ${seg.segment_index} 段 · ${seg.gate.status}`);
    GATE_ORDER.forEach((key) => {
      lines.push(`- ${gateBadge(seg.gate!.gates[key])} ${GATE_LABELS[key]}：${seg.gate!._meta.details[key]}`);
    });
    if (seg.gate.cliche_hits.length) lines.push(`- 命中套话：${seg.gate.cliche_hits.join('、')}`);
    if (seg.gate.revision_instructions.length) {
      lines.push(`- 待修正：${seg.gate.revision_instructions.join('；')}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}

export function buildPlainText(state: ProjectState, title = '未命名作品'): string {
  const produced = state.segments.reduce((n, s) => n + s.word_count, 0);
  return [
    title,
    `全篇约 ${(countWords(state.source_text) + produced).toLocaleString()} 字`,
    '',
    state.source_text.trim(),
    '',
    ...state.segments.map((s) => `${s.text.trim()}\n`),
  ].join('\n');
}

export function buildContractJson(state: ProjectState, title = '未命名作品'): string {
  return JSON.stringify(
    {
      product: 'NovelFlow Studio v4.0',
      exported_at: new Date().toISOString(),
      title,
      agent1_payload: state.agent1,
      agent2_payload: state.agent2,
      gate_results: state.segments.map((s) => ({
        segment_index: s.segment_index,
        status: s.status,
        source: s.source,
        attempts: s.attempts,
        gate: s.gate,
      })),
      logs: state.logs,
    },
    null,
    2,
  );
}

export function downloadText(filename: string, content: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function safeFilename(title: string, ext: string): string {
  const base = (title || 'novelflow').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
  return `${base}_${new Date().toISOString().slice(0, 10)}.${ext}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 降级到 execCommand */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
