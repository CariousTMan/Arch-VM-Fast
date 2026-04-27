const DB_NAME = "linux-vm-disks";
const DB_VERSION = 1;
const META_STORE = "meta";
const BLOCKS_STORE = "blocks";
export const CHUNK_BYTES = 256 * 1024;

interface DiskMeta {
  isoId: string;
  byteLength: number;
  createdAt: number;
  updatedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
      if (!db.objectStoreNames.contains(BLOCKS_STORE)) {
        db.createObjectStore(BLOCKS_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("disk db open failed"));
  });
  return dbPromise;
}

function txPromise<T>(
  store: IDBObjectStore,
  body: () => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = body();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("idb op failed"));
    store.transaction.onerror = () =>
      reject(store.transaction.error ?? new Error("idb tx failed"));
  });
}

export interface DiskInfo {
  isoId: string;
  byteLength: number;
  usedBytes: number;
  blockCount: number;
  createdAt: number;
  updatedAt: number;
}

export async function getDiskMeta(isoId: string): Promise<DiskMeta | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readonly");
    const req = tx.objectStore(META_STORE).get(isoId);
    req.onsuccess = () => resolve((req.result as DiskMeta | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error("getDiskMeta failed"));
  });
}

export async function ensureDiskMeta(
  isoId: string,
  byteLength: number,
): Promise<DiskMeta> {
  const db = await openDb();
  const existing = await new Promise<DiskMeta | undefined>(
    (resolve, reject) => {
      const tx = db.transaction(META_STORE, "readonly");
      const req = tx.objectStore(META_STORE).get(isoId);
      req.onsuccess = () =>
        resolve((req.result as DiskMeta | undefined) ?? undefined);
      req.onerror = () =>
        reject(req.error ?? new Error("ensureDiskMeta read failed"));
    },
  );
  if (existing && existing.byteLength === byteLength) return existing;
  if (existing && existing.byteLength !== byteLength) {
    await deleteDisk(isoId);
  }
  const meta: DiskMeta = {
    isoId,
    byteLength,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).put(meta, isoId);
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error("ensureDiskMeta write failed"));
  });
  return meta;
}

export async function deleteDisk(isoId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, BLOCKS_STORE], "readwrite");
    tx.objectStore(META_STORE).delete(isoId);
    const range = IDBKeyRange.bound(`${isoId}:`, `${isoId};`, false, true);
    tx.objectStore(BLOCKS_STORE).delete(range);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("deleteDisk failed"));
  });
}

export async function listDisks(): Promise<DiskInfo[]> {
  const db = await openDb();
  const metas = await new Promise<DiskMeta[]>((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readonly");
    const req = tx.objectStore(META_STORE).openCursor();
    const out: DiskMeta[] = [];
    req.onsuccess = () => {
      const c = req.result;
      if (c) {
        out.push(c.value as DiskMeta);
        c.continue();
      } else resolve(out);
    };
    req.onerror = () => reject(req.error ?? new Error("listDisks failed"));
  });
  const results: DiskInfo[] = [];
  for (const m of metas) {
    const usage = await diskUsage(m.isoId);
    results.push({ ...m, ...usage });
  }
  return results.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function diskUsage(
  isoId: string,
): Promise<{ usedBytes: number; blockCount: number }> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BLOCKS_STORE, "readonly");
    const range = IDBKeyRange.bound(`${isoId}:`, `${isoId};`, false, true);
    const req = tx.objectStore(BLOCKS_STORE).openCursor(range);
    let usedBytes = 0;
    let blockCount = 0;
    req.onsuccess = () => {
      const c = req.result;
      if (c) {
        const v = c.value as ArrayBuffer;
        usedBytes += v.byteLength;
        blockCount += 1;
        c.continue();
      } else resolve({ usedBytes, blockCount });
    };
    req.onerror = () => reject(req.error ?? new Error("diskUsage failed"));
  });
}

type LoadableCallback = (arg?: unknown) => void;

export class IndexedDbDisk {
  byteLength: number;
  block_cache: Map<number, Uint8Array>;
  block_cache_is_write: Set<number>;
  onload: ((arg?: unknown) => void) | undefined;
  onprogress: ((arg?: unknown) => void) | undefined;

  private isoId: string;
  private chunkBytes: number;
  private chunkCache: Map<number, Uint8Array>;
  private dirtyChunks: Set<number>;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private maxCachedChunks: number;

  constructor(isoId: string, byteLength: number) {
    this.isoId = isoId;
    this.byteLength = byteLength;
    this.chunkBytes = CHUNK_BYTES;
    this.block_cache = new Map();
    this.block_cache_is_write = new Set();
    this.chunkCache = new Map();
    this.dirtyChunks = new Set();
    this.maxCachedChunks = Math.max(64, Math.min(512, Math.floor((512 * 1024 * 1024) / this.chunkBytes)));
  }

  load(): void {
    setTimeout(() => {
      this.onload?.(Object.create(null));
    }, 0);
  }

  private async readChunk(chunkIdx: number): Promise<Uint8Array> {
    const cached = this.chunkCache.get(chunkIdx);
    if (cached) return cached;
    const db = await openDb();
    const stored = await new Promise<ArrayBuffer | undefined>(
      (resolve, reject) => {
        const tx = db.transaction(BLOCKS_STORE, "readonly");
        const req = tx
          .objectStore(BLOCKS_STORE)
          .get(`${this.isoId}:${chunkIdx}`);
        req.onsuccess = () =>
          resolve((req.result as ArrayBuffer | undefined) ?? undefined);
        req.onerror = () =>
          reject(req.error ?? new Error("chunk read failed"));
      },
    );
    const buf = stored
      ? new Uint8Array(stored.slice(0))
      : new Uint8Array(this.chunkBytes);
    this.cachePut(chunkIdx, buf);
    return buf;
  }

  private cachePut(chunkIdx: number, buf: Uint8Array): void {
    this.chunkCache.set(chunkIdx, buf);
    if (this.chunkCache.size > this.maxCachedChunks) {
      for (const key of this.chunkCache.keys()) {
        if (this.dirtyChunks.has(key)) continue;
        this.chunkCache.delete(key);
        if (this.chunkCache.size <= this.maxCachedChunks) break;
      }
    }
  }

  get(start: number, length: number, cb: (data: Uint8Array) => void): void {
    void (async () => {
      try {
        const out = new Uint8Array(length);
        let pos = 0;
        let cursor = start;
        const end = start + length;
        while (cursor < end) {
          const chunkIdx = Math.floor(cursor / this.chunkBytes);
          const chunkOffset = cursor - chunkIdx * this.chunkBytes;
          const take = Math.min(end - cursor, this.chunkBytes - chunkOffset);
          const chunk = await this.readChunk(chunkIdx);
          out.set(chunk.subarray(chunkOffset, chunkOffset + take), pos);
          pos += take;
          cursor += take;
        }
        cb(out);
      } catch (err) {
        console.error("IndexedDbDisk.get failed", err);
        cb(new Uint8Array(length));
      }
    })();
  }

  set(start: number, slice: Uint8Array, cb: LoadableCallback): void {
    void (async () => {
      try {
        let pos = 0;
        let cursor = start;
        const end = start + slice.byteLength;
        while (cursor < end) {
          const chunkIdx = Math.floor(cursor / this.chunkBytes);
          const chunkOffset = cursor - chunkIdx * this.chunkBytes;
          const take = Math.min(end - cursor, this.chunkBytes - chunkOffset);
          const chunk = await this.readChunk(chunkIdx);
          chunk.set(slice.subarray(pos, pos + take), chunkOffset);
          this.dirtyChunks.add(chunkIdx);
          pos += take;
          cursor += take;
        }
        this.scheduleFlush();
        cb();
      } catch (err) {
        console.error("IndexedDbDisk.set failed", err);
        cb();
      }
    })();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 1000);
  }

  async flush(): Promise<void> {
    if (this.dirtyChunks.size === 0) return;
    const dirty = Array.from(this.dirtyChunks);
    this.dirtyChunks.clear();
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([BLOCKS_STORE, META_STORE], "readwrite");
      const blocks = tx.objectStore(BLOCKS_STORE);
      for (const idx of dirty) {
        const buf = this.chunkCache.get(idx);
        if (!buf) continue;
        blocks.put(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), `${this.isoId}:${idx}`);
      }
      const meta = tx.objectStore(META_STORE);
      const getReq = meta.get(this.isoId);
      getReq.onsuccess = () => {
        const m = getReq.result as DiskMeta | undefined;
        if (m) {
          m.updatedAt = Date.now();
          meta.put(m, this.isoId);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("flush failed"));
    });
  }

  get_state(): unknown[] {
    return [[]];
  }

  set_state(_state: unknown): void {
    // disk persists independently in IndexedDB; snapshot disk state is ignored
  }

  get_buffer(cb: (buf: ArrayBuffer | null) => void): void {
    cb(null);
  }
}
