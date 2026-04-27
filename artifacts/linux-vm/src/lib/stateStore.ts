const DB_NAME = "linux-vm-state";
const STORE = "states";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

export interface SavedStateMeta {
  key: string;
  iso: string;
  size: number;
  createdAt: number;
}

export async function saveState(
  key: string,
  iso: string,
  state: ArrayBuffer,
): Promise<SavedStateMeta> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const meta: SavedStateMeta = {
      key,
      iso,
      size: state.byteLength,
      createdAt: Date.now(),
    };
    store.put({ meta, state }, key);
    tx.oncomplete = () => {
      db.close();
      resolve(meta);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("saveState transaction failed"));
    };
  });
}

export async function loadState(
  key: string,
): Promise<{ meta: SavedStateMeta; state: ArrayBuffer } | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => {
      db.close();
      const result = req.result as
        | { meta: SavedStateMeta; state: ArrayBuffer }
        | undefined;
      resolve(result ?? null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error ?? new Error("loadState failed"));
    };
  });
}

export async function deleteState(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("deleteState failed"));
    };
  });
}

export async function listStates(): Promise<SavedStateMeta[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).openCursor();
    const out: SavedStateMeta[] = [];
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        const v = cursor.value as { meta: SavedStateMeta };
        out.push(v.meta);
        cursor.continue();
      } else {
        db.close();
        resolve(out.sort((a, b) => b.createdAt - a.createdAt));
      }
    };
    req.onerror = () => {
      db.close();
      reject(req.error ?? new Error("listStates failed"));
    };
  });
}
