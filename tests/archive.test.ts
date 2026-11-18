import { describe, expect, it } from 'vitest';
import { ARCHIVE_FORMAT, buildArchive, parseArchive, planImport } from '../src/lib/archive';
import type { ProjectRecord, ProjectState, SnapshotRecord } from '../src/types';

function state(source: string, words: number): ProjectState {
  return {
    source_text: source,
    source_type: 'raw_text',
    direction: '绝不原谅',
    target_tier_id: 'standard',
    agent1: null,
    agent2: null,
    segments: words
      ? [
          {
            segment_index: 1,
            segment_role: '第 1 段',
            title: '当众兑现',
            text: '正文'.repeat(words),
            word_count: words * 2,
            status: 'pass',
            attempts: 1,
            warnings: [],
            source: 'simulation',
          },
        ]
      : [],
    logs: [],
    memory_banner: '',
    progress: { percent: 0, label: '', active_segment: 0, total_segments: 0 },
    engine: 'simulation',
  };
}

function project(id: string, title: string): ProjectRecord {
  return { id, title, created_at: 1, updated_at: 2, state: state('卡点前文', 10) };
}

function snapshot(id: string, projectId: string, kind: 'auto' | 'manual'): SnapshotRecord {
  return { id, project_id: projectId, created_at: 3, label: '快照', payload: state('卡点前文', 5), kind };
}

describe('archive', () => {
  it('导出再导入能完整还原作品与快照', () => {
    const projects = [project('p1', '作品一'), project('p2', '作品二')];
    const snapshots = [snapshot('s1', 'p1', 'auto'), snapshot('s2', 'p1', 'manual'), snapshot('s3', 'p2', 'auto')];
    const json = buildArchive(projects, snapshots);
    const parsed = parseArchive(json);

    expect(parsed.projectCount).toBe(2);
    expect(parsed.snapshotCount).toBe(3);
    expect(parsed.projects.map((p) => p.title)).toEqual(['作品一', '作品二']);
    expect(parsed.projects[0].snapshots.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(parsed.projects[1].snapshots[0].kind).toBe('auto');
    expect(JSON.parse(json).format).toBe(ARCHIVE_FORMAT);
    expect(parsed.totalWords).toBeGreaterThan(0);
  });

  it('拒绝非归档文件与损坏文件', () => {
    expect(() => parseArchive('not json')).toThrow(/合法的 JSON/);
    expect(() => parseArchive(JSON.stringify({ format: 'other', version: 1, projects: [] }))).toThrow(/NovelFlow 归档/);
    expect(() => parseArchive(JSON.stringify({ format: ARCHIVE_FORMAT, version: 99, projects: [] }))).toThrow(/版本/);
    expect(() => parseArchive(JSON.stringify({ format: ARCHIVE_FORMAT, version: 1, projects: [] }))).toThrow(/没有任何作品/);
    expect(() =>
      parseArchive(JSON.stringify({ format: ARCHIVE_FORMAT, version: 1, projects: [{ id: 'x' }] })),
    ).toThrow(/没有可识别/);
  });

  it('导入时 id 冲突会重映射，快照跟着改挂', () => {
    const archiveProjects = [
      { ...project('p1', '旧作品'), snapshots: [snapshot('s1', 'p1', 'auto')] },
      { ...project('p9', '新作品'), snapshots: [] },
    ];
    let n = 0;
    const plan = planImport(archiveProjects, new Set(['p1']), () => `new-${++n}`);

    expect(plan[0].project.id).toBe('new-1');
    expect(plan[0].snapshots[0].project_id).toBe('new-1');
    expect(plan[0].snapshots[0].id).toContain('new-1');
    expect(plan[1].project.id).toBe('p9');
  });

  it('没有快照的作品也能导出导入', () => {
    const parsed = parseArchive(buildArchive([project('p1', '空快照')], []));
    expect(parsed.projectCount).toBe(1);
    expect(parsed.projects[0].snapshots).toEqual([]);
  });
});
