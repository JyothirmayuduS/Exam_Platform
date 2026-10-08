// Recording pieces: the only stored copy of each exam recording.
//
// MediaRecorder emits a chunk every 10 s. Each chunk is written to the
// device's disk outbox and uploaded as
//   ${examFolder}/${owner}/recordings/parts/${family}_${seq}.webm
// then deleted locally. Nothing accumulates in memory, and no merged copy is
// uploaded at submit: review stitches the pieces in order (RecordingReview).
// A failed piece stays on disk and retries; on a weak link uploads pause and
// resume when it recovers (submit still drains them).
//
// `seq` is the chunk's wall-clock time in ms (strictly increasing), so a
// recorder restarted after a reload never overwrites an earlier piece.
import { createSnapshotOutbox, type SnapshotStore } from "@/shared/services/snapshotOutbox";
import { r2PutBlob } from "@/shared/services/r2Function";

export type RecordingFamily = "exam" | "screen";

export type PartUploader = {
  enqueue: (blob: Blob) => void;
  setPaused: (on: boolean) => void;
  /** Upload everything still on the device; true when nothing is pending. */
  flush: () => Promise<boolean>;
  pendingCount: () => number;
  stop: () => void;
};

export const PART_RETRY_MS = 10_000;
export const PART_SECONDS = 10;

/** Every family that has ever written pieces (camera_ is legacy ProctorCamera). */
export const PIECE_FAMILIES = [
  { family: "exam", label: "camera", title: "Camera + microphone" },
  { family: "screen", label: "screen", title: "Screen" },
  { family: "camera", label: "camera-legacy", title: "Camera (older kiosk)" },
] as const;

/** Pieces of one recorder family, in recording order. */
export function sortedParts<T extends { kind: string; key: string }>(arts: T[], family: string): T[] {
  const re = new RegExp(`/parts/${family}_(\\d+)\\.webm$`);
  const seq = (k: string) => Number(k.match(re)?.[1] ?? 0);
  return arts
    .filter((a) => a.kind === "recordings" && re.test(a.key))
    .sort((a, b) => seq(a.key) - seq(b.key));
}

export function partName(family: RecordingFamily, seq: number): string {
  return `${family}_${String(seq).padStart(13, "0")}.webm`;
}

export function startPartUploads(opts: {
  folder: string;
  owner: string;
  family: RecordingFamily;
  onError?: (message: string) => void;
  store?: SnapshotStore;
  upload?: (opts: { examId: string; ownerSegment: string; kind: "recordings"; name: string; blob: Blob }) => Promise<string | null>;
  now?: () => number;
}): PartUploader {
  const base = `${opts.folder}/${opts.owner}/recordings/`;
  const put = opts.upload ?? r2PutBlob;
  const now = opts.now ?? Date.now;
  const outbox = createSnapshotOutbox({
    prefix: `${base}parts/${opts.family}_`,
    store: opts.store,
    onError: opts.onError,
    pendingMessage: "Some recording pieces are waiting to upload. Keep the app open and check your connection.",
    upload: async (key, blob) => {
      try {
        return !!await put({ examId: opts.folder, ownerSegment: opts.owner, kind: "recordings", name: key.slice(base.length), blob });
      } catch {
        return false;
      }
    },
  });
  let lastSeq = 0;
  const retry = setInterval(() => outbox.retry(), PART_RETRY_MS);
  return {
    enqueue: (blob) => {
      if (blob.size <= 0) return;
      lastSeq = Math.max(now(), lastSeq + 1);
      outbox.enqueue(`${base}parts/${partName(opts.family, lastSeq)}`, blob);
    },
    setPaused: (on) => outbox.setPaused(on),
    flush: () => outbox.flush(),
    pendingCount: () => outbox.pendingCount(),
    stop: () => clearInterval(retry),
  };
}
