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

/** The device's evidence store, or undefined where IndexedDB is unavailable. */
export function defaultSnapshotStore(): SnapshotStore | undefined {
  if (typeof indexedDB === "undefined") return undefined;
  try { return browserSnapshotStore(); } catch { return undefined; }
}

/**
 * What an upload attempt returned. `refused` is a permanent answer from
 * storage (a 4xx such as a bad name or a forbidden folder): retrying the same
 * request cannot succeed. `final` gives up on the first refusal.
 */
export type UploadResult = boolean | { refused: number; reason: string; final?: boolean };

/** Permanent refusals of one item before it stops being retried. */
export const REFUSAL_LIMIT = 3;

export type SnapshotOutbox = {
  enqueue: (key: string, blob: Blob) => void;
  retry: () => void;
  setPaused: (on: boolean) => void;
  /** Items waiting on disk (or in memory when disk is unavailable). Excludes refused items. */
  pendingCount: () => number;
  /** Items storage refused for good: kept on disk, no longer retried. */
  refused: () => { key: string; reason: string }[];
  /** True once a refusal listed in `haltOn` stopped all uploads. */
  halted: () => boolean;
  /** Nothing waiting, writing or uploading. */
  idle: () => boolean;
  flush: () => Promise<boolean>;
  /**
   * Stop uploading and hand over: resolves once in-flight writes and uploads
   * have settled, with the items held only in memory. Items on disk are left
   * for the successor's own scan.
   */
  retire: () => Promise<Map<string, Blob>>;
};

export function createSnapshotOutbox(opts: {
  prefix: string;
  upload: (key: string, blob: Blob) => Promise<UploadResult>;
  onError?: (message: string) => void;
  store?: SnapshotStore;
  /** Shown when an upload fails (default: camera snapshots wording). */
  pendingMessage?: string;
  /** A retiring predecessor's handover; nothing is scanned or uploaded before it settles. */
  after?: Promise<Map<string, Blob>>;
  /** Called whenever the outbox becomes idle after work. */
  onIdle?: () => void;
  /**
   * Refusal statuses that stop every upload at once (items stay on disk), e.g.
   * 401/403 for pieces of a student who is not signed in.
   */
  haltOn?: number[];
  onHalt?: (status: number, reason: string) => void;
}): SnapshotOutbox {
  const fallback = new Map<string, Blob>();
  const pending = new Set<string>();
  const active = new Map<string, Promise<void>>();
  const writes = new Set<Promise<void>>();
  let failed = false;
  let retired = false;
  let halted = false;
  const refusals = new Map<string, number>();
  const refused = new Map<string, string>();
  // Paused (weak link): items stay on disk; flush() still drains them.
  let paused = false;
  let flushing = 0;
  let store: SnapshotStore | undefined;
  const reportError = () => opts.onError?.(opts.pendingMessage ?? "Some camera snapshots are pending upload. Keep the app open and check your connection.");
  try { store = opts.store ?? browserSnapshotStore(); } catch { /* unavailable browser storage */ }
  const isIdle = () => pending.size === 0 && active.size === 0 && writes.size === 0;
  const ready = (async () => {
    if (opts.after) {
      try {
        for (const [key, blob] of await opts.after) { fallback.set(key, blob); pending.add(key); }
      } catch { /* predecessor had nothing to hand over */ }
    }
    if (!store) return;
    try { for (const key of await store.keys(opts.prefix)) pending.add(key); }
    catch { store = undefined; opts.onError?.("Local snapshot storage is unavailable. Do not close the app until evidence uploads finish."); }
  })();

  const pump = () => {
    if (retired || halted || failed || (paused && flushing === 0)) return;
    for (const key of pending) {
      if (active.size >= 3) break;
      if (active.has(key)) continue;
      const work = (async () => {
        try {
          const blob = fallback.get(key) ?? await store?.get(key);
          if (!blob) {
            // Gone from disk and memory: another uploader already sent it.
            pending.delete(key);
            return;
          }
          const result = await opts.upload(key, blob);
          if (typeof result === "object") {
            if (opts.haltOn?.includes(result.refused)) {
              halted = true;
              opts.onHalt?.(result.refused, result.reason);
              return;
            }
            const count = (refusals.get(key) ?? 0) + 1;
            refusals.set(key, count);
            if (result.final || count >= REFUSAL_LIMIT) {
              // Stays on disk; only this outbox stops retrying it.
              refused.set(key, `${result.reason} (HTTP ${result.refused})`);
              pending.delete(key);
              return;
            }
            throw new Error(result.reason);
          }
          if (!result) throw new Error("Snapshot upload incomplete");
          await store?.remove(key);
          fallback.delete(key);
          pending.delete(key);
          refusals.delete(key);
        } catch {
          // Keep the original capture timestamp and bytes for a later retry.
          failed = true;
          reportError();
        }
      })().finally(() => {
        active.delete(key);
        pump();
        if (isIdle()) opts.onIdle?.();
      });
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
    pendingCount: () => pending.size,
    refused: () => [...refused].map(([key, reason]) => ({ key, reason })),
    halted: () => halted,
    idle: isIdle,
    async flush(): Promise<boolean> {
      flushing += 1;
      try {
        await ready;
        await Promise.all([...writes]);
        failed = false;
        pump();
        while (active.size) await Promise.all([...active.values()]);
        return pending.size === 0 && !halted;
      } finally {
        flushing -= 1;
      }
    },
    async retire(): Promise<Map<string, Blob>> {
      retired = true;
      await ready.catch(() => undefined);
      while (writes.size || active.size) await Promise.all([...writes, ...active.values()]);
      const handover = new Map<string, Blob>();
      for (const key of pending) {
        const blob = fallback.get(key);
        if (blob) handover.set(key, blob);
      }
      return handover;
    },
  };
}
