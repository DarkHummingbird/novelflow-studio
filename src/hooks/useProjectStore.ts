import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectRecord, ProjectState, SnapshotRecord } from '../types';
import * as idb from '../lib/idb';

/** 作品草稿箱：多项目、防抖自动保存、快照与回滚。 */
export function useProjectStore() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [ready, setReady] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [persistence, setPersistence] = useState<'idb' | 'memory'>('idb');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ id: string | null; title: string; state: ProjectState; onSaved?: (r: ProjectRecord) => void } | null>(
    null,
  );

  const refresh = useCallback(async () => {
    const list = await idb.listProjects();
    setProjects(list);
    return list;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await refresh();
        if (typeof indexedDB === 'undefined') setPersistence('memory');
      } catch {
        setPersistence('memory');
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const upsert = useCallback(
    async (id: string | null, title: string, state: ProjectState): Promise<ProjectRecord> => {
      const existing = id ? await idb.getProject(id) : null;
      const record: ProjectRecord = existing
        ? { ...existing, title, state, updated_at: Date.now() }
        : idb.createRecord(title, state);
      await idb.saveProject(record);
      setLastSavedAt(Date.now());
      await refresh();
      return record;
    },
    [refresh],
  );

  /**
   * 防抖保存：编辑正文时不会每敲一个字就写一次 IndexedDB。
   * onSaved 用于把"首次自动保存新建出来的 record.id"回填给调用方，
   * 否则每次自动保存都会新建一个项目，草稿箱里会堆满重复条目。
   */
  const scheduleUpsert = useCallback(
    (
      id: string | null,
      title: string,
      state: ProjectState,
      opts: { delay?: number; onSaved?: (record: ProjectRecord) => void } = {},
    ) => {
      if (timer.current) clearTimeout(timer.current);
      pending.current = { id, title, state, onSaved: opts.onSaved };
      timer.current = setTimeout(() => {
        const job = pending.current;
        pending.current = null;
        if (!job) return;
        void upsert(job.id, job.title, job.state).then((record) => job.onSaved?.(record));
      }, opts.delay ?? 800);
    },
    [upsert],
  );

  /**
   * 立刻落盘：页面隐藏/关闭前调用，避免"刚改完就刷新"丢掉最后一次编辑
   * （防抖窗口内的改动否则会随页面卸载一起消失）。
   */
  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const job = pending.current;
    if (!job) return;
    pending.current = null;
    const record = await upsert(job.id, job.title, job.state);
    job.onSaved?.(record);
  }, [upsert]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const remove = useCallback(
    async (id: string) => {
      await idb.deleteProject(id);
      await refresh();
    },
    [refresh],
  );

  const snapshotsOf = useCallback((id: string) => idb.listSnapshots(id), []);

  const takeSnapshot = useCallback(
    async (id: string, label: string, state: ProjectState, kind: 'auto' | 'manual' = 'manual', reason?: string) =>
      idb.addSnapshot(id, label, state, kind, reason),
    [],
  );

  const allSnapshots = useCallback(() => idb.listAllSnapshots(), []);

  /** 归档导入：先写作品，再按重映射后的 id 写回各自的快照 */
  const importProjects = useCallback(
    async (items: Array<{ project: ProjectRecord; snapshots: SnapshotRecord[] }>) => {
      for (const { project, snapshots } of items) {
        await idb.saveProject(project);
        for (const snap of snapshots) await idb.putSnapshotRaw(snap);
      }
      await refresh();
      return items.length;
    },
    [refresh],
  );

  return {
    projects,
    ready,
    lastSavedAt,
    persistence,
    refresh,
    upsert,
    scheduleUpsert,
    flush,
    remove,
    snapshotsOf,
    allSnapshots,
    takeSnapshot,
    importProjects,
    getProject: idb.getProject,
    getSnapshot: idb.getSnapshot,
    restore: async (snapshotId: string): Promise<ProjectState | null> => {
      const snap: SnapshotRecord | null = await idb.getSnapshot(snapshotId);
      return snap ? snap.payload : null;
    },
  };
}

export type ProjectStore = ReturnType<typeof useProjectStore>;
