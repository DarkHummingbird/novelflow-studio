/** IndexedDB 作品草稿箱（PRD §1.3 v4.1 / §5.4）：多项目、快照、断点续写。 */

import type { ProjectRecord, ProjectState, SnapshotRecord } from '../types';

const DB_NAME = 'novelflow_studio';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_SNAPSHOTS = 'snapshots';
const MAX_SNAPSHOTS = 30;

interface MemoryDB {
  projects: Map<string, ProjectRecord>;
  snapshots: SnapshotRecord[];
}

let memory: MemoryDB | null = null;

function available(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

export function uuid(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch {
    /* 降级 */
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function useMemory(): MemoryDB {
  if (!memory) memory = { projects: new Map(), snapshots: [] };
  return memory;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
        const store = db.createObjectStore(STORE_SNAPSHOTS, { keyPath: 'id' });
        store.createIndex('by_project', 'project_id', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(storeName: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDB();
  return new Promise<T | undefined>((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let result: T | undefined;
    try {
      const req = fn(store);
      if (req) req.onsuccess = () => (result = req.result);
    } catch (err) {
      reject(err);
      return;
    }
    transaction.oncomplete = () => {
      db.close();
      resolve(result);
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

/* ------------------------------------------------------------------ 项目 */

export async function listProjects(): Promise<ProjectRecord[]> {
  if (!available()) return [...useMemory().projects.values()].sort((a, b) => b.updated_at - a.updated_at);
  try {
    const all = (await tx<ProjectRecord[]>(STORE_PROJECTS, 'readonly', (s) => s.getAll())) ?? [];
    return all.sort((a, b) => b.updated_at - a.updated_at);
  } catch {
    return [...useMemory().projects.values()].sort((a, b) => b.updated_at - a.updated_at);
  }
}

export async function getProject(id: string): Promise<ProjectRecord | null> {
  if (!available()) return useMemory().projects.get(id) ?? null;
  try {
    const rec = await tx<ProjectRecord>(STORE_PROJECTS, 'readonly', (s) => s.get(id));
    return rec ?? null;
  } catch {
    return useMemory().projects.get(id) ?? null;
  }
}

export async function saveProject(record: ProjectRecord): Promise<void> {
  if (!available()) {
    useMemory().projects.set(record.id, record);
    return;
  }
  try {
    await tx(STORE_PROJECTS, 'readwrite', (s) => s.put(record));
  } catch {
    useMemory().projects.set(record.id, record);
  }
}

export async function deleteProject(id: string): Promise<void> {
  if (!available()) {
    useMemory().projects.delete(id);
    useMemory().snapshots = useMemory().snapshots.filter((s) => s.project_id !== id);
    return;
  }
  try {
    await tx(STORE_PROJECTS, 'readwrite', (s) => s.delete(id));
    const snaps = await listSnapshots(id);
    const db = await openDB();
    await new Promise<void>((resolve) => {
      const tr = db.transaction(STORE_SNAPSHOTS, 'readwrite');
      const store = tr.objectStore(STORE_SNAPSHOTS);
      for (const snap of snaps) store.delete(snap.id);
      tr.oncomplete = () => {
        db.close();
        resolve();
      };
      tr.onerror = () => {
        db.close();
        resolve();
      };
    });
  } catch {
    useMemory().projects.delete(id);
  }
}

export function createRecord(title: string, state: ProjectState): ProjectRecord {
  const now = Date.now();
  return { id: uuid(), title, created_at: now, updated_at: now, state };
}

/* ---------------------------------------------------------------- 快照 */

export async function addSnapshot(
  projectId: string,
  label: string,
  payload: ProjectState,
  kind: SnapshotRecord['kind'] = 'manual',
  reason?: string,
): Promise<SnapshotRecord> {
  const snapshot: SnapshotRecord = {
    id: uuid(),
    project_id: projectId,
    created_at: Date.now(),
    label,
    payload,
    kind,
    reason,
  };
  if (!available()) {
    useMemory().snapshots.push(snapshot);
    return snapshot;
  }
  try {
    await tx(STORE_SNAPSHOTS, 'readwrite', (s) => s.put(snapshot));
    await pruneSnapshots(projectId);
  } catch {
    useMemory().snapshots.push(snapshot);
  }
  return snapshot;
}

export async function listSnapshots(projectId: string): Promise<SnapshotRecord[]> {
  if (!available()) {
    return useMemory()
      .snapshots.filter((s) => s.project_id === projectId)
      .sort((a, b) => b.created_at - a.created_at);
  }
  try {
    const db = await openDB();
    return await new Promise<SnapshotRecord[]>((resolve) => {
      const tr = db.transaction(STORE_SNAPSHOTS, 'readonly');
      const index = tr.objectStore(STORE_SNAPSHOTS).index('by_project');
      const req = index.getAll(projectId);
      req.onsuccess = () => {
        db.close();
        resolve((req.result ?? []).sort((a, b) => b.created_at - a.created_at));
      };
      req.onerror = () => {
        db.close();
        resolve([]);
      };
    });
  } catch {
    return [];
  }
}

/** 按原始 id 写入（归档导入用；项目 id 冲突时由调用方重映射） */
export async function putSnapshotRaw(snapshot: SnapshotRecord): Promise<void> {
  if (!available()) {
    useMemory().snapshots.push(snapshot);
    return;
  }
  try {
    await tx(STORE_SNAPSHOTS, 'readwrite', (s) => s.put(snapshot));
  } catch {
    useMemory().snapshots.push(snapshot);
  }
}

export async function listAllSnapshots(): Promise<SnapshotRecord[]> {
  if (!available()) return [...useMemory().snapshots].sort((a, b) => b.created_at - a.created_at);
  try {
    const all = (await tx<SnapshotRecord[]>(STORE_SNAPSHOTS, 'readonly', (s) => s.getAll())) ?? [];
    return all.sort((a, b) => b.created_at - a.created_at);
  } catch {
    return [...useMemory().snapshots].sort((a, b) => b.created_at - a.created_at);
  }
}

export async function getSnapshot(id: string): Promise<SnapshotRecord | null> {
  if (!available()) return useMemory().snapshots.find((s) => s.id === id) ?? null;
  try {
    const rec = await tx<SnapshotRecord>(STORE_SNAPSHOTS, 'readonly', (s) => s.get(id));
    return rec ?? null;
  } catch {
    return null;
  }
}

export async function pruneSnapshots(projectId: string, keep = MAX_SNAPSHOTS): Promise<void> {
  const snaps = await listSnapshots(projectId);
  if (snaps.length <= keep) return;
  const drop = snaps.slice(keep);
  const db = await openDB();
  await new Promise<void>((resolve) => {
    const tr = db.transaction(STORE_SNAPSHOTS, 'readwrite');
    const store = tr.objectStore(STORE_SNAPSHOTS);
    for (const snap of drop) store.delete(snap.id);
    tr.oncomplete = () => {
      db.close();
      resolve();
    };
    tr.onerror = () => {
      db.close();
      resolve();
    };
  });
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
    }
  } catch {
    /* ignore */
  }
  return null;
}
