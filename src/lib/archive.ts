/**
 * 作品归档：把「全部作品 + 全部版本快照」打包成一个 JSON，可跨机器带走。
 * 解决浏览器数据被清 / 换浏览器 / file:// 下 IndexedDB 降级导致的丢稿风险。
 */

import type { ProjectRecord, SnapshotRecord } from '../types';

export const ARCHIVE_FORMAT = 'novelflow-archive';
export const ARCHIVE_VERSION = 1;

export interface ArchiveProject extends ProjectRecord {
  snapshots: SnapshotRecord[];
}

export interface ArchiveFile {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  exported_at: string;
  app: string;
  projects: ArchiveProject[];
}

export function buildArchive(projects: ProjectRecord[], snapshots: SnapshotRecord[]): string {
  const byProject = new Map<string, SnapshotRecord[]>();
  for (const snap of snapshots) {
    const list = byProject.get(snap.project_id) ?? [];
    list.push(snap);
    byProject.set(snap.project_id, list);
  }
  const archive: ArchiveFile = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exported_at: new Date().toISOString(),
    app: 'NovelFlow Studio v4.0',
    projects: projects.map((project) => ({
      ...project,
      snapshots: (byProject.get(project.id) ?? []).sort((a, b) => a.created_at - b.created_at),
    })),
  };
  return JSON.stringify(archive, null, 2);
}

export interface ParsedArchive {
  projects: ArchiveProject[];
  projectCount: number;
  snapshotCount: number;
  totalWords: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 解析并校验归档文件；格式不对就抛错，绝不静默写入半份数据。 */
export function parseArchive(text: string): ParsedArchive {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('不是合法的 JSON 文件');
  }
  if (!isRecord(raw)) throw new Error('归档内容不是对象');
  if (raw.format !== ARCHIVE_FORMAT) throw new Error('不是 NovelFlow 归档文件（format 字段不匹配）');
  if (typeof raw.version !== 'number' || raw.version > ARCHIVE_VERSION) {
    throw new Error(`归档版本不受支持：${String(raw.version)}`);
  }
  const projects = Array.isArray(raw.projects) ? raw.projects : [];
  if (projects.length === 0) throw new Error('归档里没有任何作品');

  const parsed: ArchiveProject[] = [];
  for (const item of projects) {
    if (!isRecord(item)) continue;
    const state = isRecord(item.state) ? item.state : null;
    if (!state || typeof state.source_text !== 'string') continue;
    const snapshots = Array.isArray(item.snapshots)
      ? item.snapshots.filter(
          (snap): snap is SnapshotRecord => isRecord(snap) && isRecord(snap.payload) && typeof snap.label === 'string',
        )
      : [];
    parsed.push({
      id: typeof item.id === 'string' && item.id ? item.id : `imported-${parsed.length + 1}`,
      title: typeof item.title === 'string' && item.title ? item.title : '导入的作品',
      created_at: typeof item.created_at === 'number' ? item.created_at : Date.now(),
      updated_at: typeof item.updated_at === 'number' ? item.updated_at : Date.now(),
      state: state as unknown as ArchiveProject['state'],
      snapshots,
    });
  }
  if (parsed.length === 0) throw new Error('归档里没有可识别的作品（缺少 state.source_text）');

  const snapshotCount = parsed.reduce((n, p) => n + p.snapshots.length, 0);
  const totalWords = parsed.reduce(
    (n, p) => n + p.state.segments.reduce((m, s) => m + (s.word_count || 0), 0),
    0,
  );
  return { projects: parsed, projectCount: parsed.length, snapshotCount, totalWords };
}

/**
 * 导入时的 id 规划：项目 id 已存在则分配新 id，并把它的快照一起改挂到新 id 上。
 * 纯函数，方便单测。
 */
export function planImport(
  archiveProjects: ArchiveProject[],
  existingProjectIds: ReadonlySet<string>,
  newId: () => string,
): Array<{ project: ProjectRecord; snapshots: SnapshotRecord[] }> {
  return archiveProjects.map(({ snapshots, ...project }) => {
    const taken = existingProjectIds.has(project.id);
    const id = taken ? newId() : project.id;
    return {
      project: { ...project, id, updated_at: Date.now() },
      snapshots: snapshots.map((snap) => ({
        ...snap,
        project_id: id,
        id: `${snap.id}-${id.slice(-6)}`,
      })),
    };
  });
}
