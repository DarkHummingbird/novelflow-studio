let database: Promise<IDBDatabase> | undefined;

function openDrafts() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('novelflow-reader', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

export interface Draft {
  text: string;
  needsReview: boolean;
}

export async function loadDraft(): Promise<Draft> {
  const db = await openDrafts();
  return new Promise((resolve, reject) => {
    const request = db.transaction('drafts').objectStore('drafts').get('current');
    request.onsuccess = () => {
      const value = request.result;
      if (typeof value === 'string') return resolve({ text: value, needsReview: false });
      resolve({ text: typeof value?.text === 'string' ? value.text : '', needsReview: value?.needsReview === true });
    };
    request.onerror = () => reject(request.error);
  });
}

export async function saveDraft(draft: Draft) {
  const db = await openDrafts();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.objectStore('drafts').put(draft, 'current');
  });
}
