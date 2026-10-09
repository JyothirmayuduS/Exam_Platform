// Low-bandwidth proctoring policy: every bitrate, frame size and snapshot
// interval the exam uses, and how the connection state is decided.
//
// Grading, the server deadline, answer saving and violation flags do not read
// anything here; only live video, snapshots and recording uploads do.
//
// Storage for one 2-hour exam, measured with Chromium's encoders
// (frontend/scripts/measure-proctor-storage.mjs; details in
// docs/low-bandwidth-proctoring.md). Each recording is stored once, as 10 s
// pieces; these are the totals for that one copy:
//   before: ~1.02 GB = recordings ~0.85 GB (camera 0.83 GB + screen 21 MB) + 7,201 snapshots ~169 MB
//   after:  ~0.38 GB = recordings ~375 MB  (camera 359 MB  + screen 16 MB) +   361 snapshots ~5 MB

export type ConnectionState = "good" | "weak" | "lost";

/** Periodic webcam snapshot cadence. Violations capture immediately. */
export const SNAPSHOT_INTERVAL_MS = 20_000;
export const WEAK_SNAPSHOT_INTERVAL_MS = 30_000;
export const snapshotIntervalMs = (lowBandwidth: boolean) =>
  lowBandwidth ? WEAK_SNAPSHOT_INTERVAL_MS : SNAPSHOT_INTERVAL_MS;

/** JPEG settings: periodic frames are thumbnails; flagged frames stay readable. */
export const SNAPSHOT_FRAME = { maxEdge: 480, quality: 0.5 } as const;
export const VIOLATION_FRAME = { maxEdge: 960, quality: 0.7 } as const;

/** Stored recordings (MediaRecorder targets). Were 1.6 Mbps and 2.5 Mbps. */
export const RECORDING_BITRATE = { camera: 500_000, screen: 700_000 } as const;

export type VideoEncodingProfile = { maxBitrate: number; maxFramerate: number; scaleResolutionDownBy: number };

/** Live camera sent to the proctor. On a weak link: a quarter of the pixels. */
export function cameraEncoding(lowBandwidth: boolean): VideoEncodingProfile {
  return lowBandwidth
    ? { maxBitrate: 150_000, maxFramerate: 10, scaleResolutionDownBy: 2 }
    : { maxBitrate: 450_000, maxFramerate: 15, scaleResolutionDownBy: 1 };
}

/** Live screen share sent to the proctor. Text stays sharp; frame rate drops. */
export function screenEncoding(lowBandwidth: boolean): VideoEncodingProfile {
  return lowBandwidth
    ? { maxBitrate: 300_000, maxFramerate: 2, scaleResolutionDownBy: 1 }
    : { maxBitrate: 800_000, maxFramerate: 5, scaleResolutionDownBy: 1 };
}

export type ConnectionSignals = {
  /** navigator.onLine */
  online: boolean;
  /** Answer saves are failing (the existing connection-lost rule). */
  savesFailing: boolean;
  /** LiveKit's view of this participant's link, when connected. */
  videoQuality?: "excellent" | "good" | "poor" | "lost" | "unknown" | null;
  /** Network Information API (Chromium / WebView2 only). */
  effectiveType?: string | null;
  rttMs?: number | null;
  downlinkMbps?: number | null;
  saveData?: boolean | null;
};

/** Instant classification from the current signals (no smoothing). */
export function classifyConnection(s: ConnectionSignals): ConnectionState {
  if (!s.online || s.savesFailing) return "lost";
  if (s.videoQuality === "poor" || s.videoQuality === "lost") return "weak";
  if (s.saveData) return "weak";
  if (s.effectiveType && ["slow-2g", "2g", "3g"].includes(s.effectiveType)) return "weak";
  if (s.rttMs != null && s.rttMs > 600) return "weak";
  if (s.downlinkMbps != null && s.downlinkMbps > 0 && s.downlinkMbps < 1) return "weak";
  return "good";
}

/** A connection must look good this long before low-bandwidth mode ends. */
export const RECOVER_AFTER_MS = 20_000;

export type SettledConnection = { state: ConnectionState; goodSince: number | null };

/**
 * Smooth the raw state so the mode does not flap: getting worse applies at
 * once, getting better to "good" only after RECOVER_AFTER_MS of good signals.
 */
export function settleConnection(prev: SettledConnection, raw: ConnectionState, now: number): SettledConnection {
  if (raw !== "good") return { state: raw, goodSince: null };
  if (prev.state === "good") return { state: "good", goodSince: null };
  const since = prev.goodSince ?? now;
  return now - since >= RECOVER_AFTER_MS ? { state: "good", goodSince: null } : { state: prev.state, goodSince: since };
}

/** Proctor side: a student's state from what the LiveKit room reports. */
export function remoteConnectionState(opts: {
  quality: "excellent" | "good" | "poor" | "lost" | "unknown" | null | undefined;
  inRoom: boolean;
  writing: boolean;
  viewerConnected: boolean;
}): ConnectionState | null {
  if (!opts.viewerConnected) return null;
  if (!opts.inRoom) return opts.writing ? "lost" : null;
  if (opts.quality === "lost") return "lost";
  if (opts.quality === "poor") return "weak";
  return "good";
}
