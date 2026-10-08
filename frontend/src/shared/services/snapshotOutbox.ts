// Persist pending frames on disk, not in a growing array of JPEGs. Upload
// latency must not change the camera sampling cadence. Only this exam/owner's
// prefix is replayed; successfully uploaded evidence is deleted locally.
export type SnapshotStore = {
  keys: (prefix: string) => Promise<string[]>;
  put: (key: string, blob: Blob) => Promise<void>;
  get: (key: string) => Promise<Blob | undefined>;
  remove: (key: string) => Promise<void>;
};

function browserSnapshotStore(): SnapshotStore {
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("exam-snapshot-outbox", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("frames");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const run = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const database = await db;
    return new Promise((resolve, reject) => {
      const tx = database.transaction("frames", mode);
      const request = action(tx.objectStore("frames"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("Snapshot transaction aborted"));
    });
  };
  return {
    keys: async (prefix) => (await run("readonly", (s) => s.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}\uffff`)))).map(String),
    put: async (key, blob) => { await run("readwrite", (s) => s.put(blob, key)); },
    get: (key) => run("readonly", (s) => s.get(key)),
    remove: async (key) => { await run("readwrite", (s) => s.delete(key)); },
  };
}

export function createSnapshotOutbox(opts: {
  prefix: string;
  upload: (key: string, blob: Blob) => Promise<boolean>;
  onError?: (message: string) => void;
  store?: SnapshotStore;
  /** Shown when an upload fails (default: camera snapshots wording). */
  pendingMessage?: string;
}) {
  const fallback = new Map<string, Blob>();
  const pending = new Set<string>();
  const active = new Map<string, Promise<void>>();
  const writes = new Set<Promise<void>>();
  let failed = false;
  // Paused (weak link): items stay on disk; flush() still drains them.
  let paused = false;
  let flushing = 0;
  let store: SnapshotStore | undefined;
  const reportError = () => opts.onError?.(opts.pendingMessage ?? "Some camera snapshots are pending upload. Keep the app open and check your connection.");
  try { store = opts.store ?? browserSnapshotStore(); } catch { /* unavailable browser storage */ }
  const ready = (async () => {
    if (!store) return;
    try { for (const key of await store.keys(opts.prefix)) pending.add(key); }
    catch { store = undefined; opts.onError?.("Local snapshot storage is unavailable. Do not close the app until evidence uploads finish."); }
  })();

  const pump = () => {
    if (failed || (paused && flushing === 0)) return;
    for (const key of pending) {
      if (active.size >= 3) break;
      if (active.has(key)) continue;
      const work = (async () => {
        try {
          const blob = fallback.get(key) ?? await store?.get(key);
          if (!blob || !await opts.upload(key, blob)) throw new Error("Snapshot upload incomplete");
          await store?.remove(key);
          fallback.delete(key);
          pending.delete(key);
        } catch {
          // Keep the original capture timestamp and bytes for a later retry.
          failed = true;
          reportError();
        }
      })().finally(() => { active.delete(key); pump(); });
      active.set(key, work);
    }
  };
  void ready.then(pump);

  return {
    enqueue(key: string, blob: Blob) {
      const write = (async () => {
        await ready;
        try {
          if (!store) throw new Error("Local storage unavailable");
          await store.put(key, blob);
        } catch {
          fallback.set(key, blob);
          opts.onError?.("Snapshot disk storage is unavailable or full. Keep the app open while evidence uploads.");
        }
        pending.add(key);
        pump();
      })();
      writes.add(write);
      void write.finally(() => writes.delete(write));
    },
    retry() { failed = false; void ready.then(pump); },
    setPaused(on: boolean) {
      paused = on;
      if (!on) void ready.then(pump);
    },
    /** Items waiting on disk (or in memory when disk is unavailable). */
    pendingCount: () => pending.size,
    async flush(): Promise<boolean> {
      flushing += 1;
      try {
        await ready;
        await Promise.all([...writes]);
        failed = false;
        pump();
        while (active.size) await Promise.all([...active.values()]);
        return pending.size === 0;
      } finally {
        flushing -= 1;
      }
    },
  };
}
