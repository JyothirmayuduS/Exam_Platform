// ────────────────────────────────────────────────────────────────────────────
// ObjectTracker — identity + temporal confirmation for detected objects.
//
// The raw detector runs at a slow cadence (~1.5 s) and is noisy: a phone dips
// below threshold for one sample, or a 0.46-confidence flash appears for a
// single frame. Naive code turns both into violations. This tracker:
//
//   1. matches raw detections to existing tracks by IoU (same kind),
//   2. keeps short-term persistence (a missed sample does NOT kill the track),
//   3. confirms an object only after MIN_HITS positive samples inside
//      CONFIRM_WINDOW_MS,
//   4. emits the confirmation ONCE — re-arming only after the object is truly
//      gone (track dropped) and later seen again.
//
// Pure logic — no DOM, fully unit-testable.
// ────────────────────────────────────────────────────────────────────────────

import type { Detection, TrackedObject } from "./types";
import { iou } from "./geometry";
import { TRACKING } from "./config";

export interface TrackerConfig {
  iouThreshold: number;
  minHits: number;
  maxMisses: number;
  confirmWindowMs: number;
  maxHistory: number;
}

export const DEFAULT_TRACKER_CONFIG: TrackerConfig = {
  iouThreshold: TRACKING.IOU_THRESHOLD,
  minHits: TRACKING.MIN_HITS,
  maxMisses: TRACKING.MAX_MISSES,
  confirmWindowMs: TRACKING.CONFIRM_WINDOW_MS,
  maxHistory: TRACKING.MAX_HISTORY,
};

export class ObjectTracker {
  private tracks: TrackedObject[] = [];
  private nextId = 1;
  private readonly cfg: TrackerConfig;

  constructor(cfg: Partial<TrackerConfig> = {}) {
    this.cfg = { ...DEFAULT_TRACKER_CONFIG, ...cfg };
  }

  /** All live tracks (for diagnostics / overlay). */
  get live(): readonly TrackedObject[] {
    return this.tracks;
  }

  /**
   * Feed one detection sample. Returns the list of tracks that became
   * CONFIRMED on this sample (empty unless a threshold just crossed).
   */
  update(detections: readonly Detection[], now: number): TrackedObject[] {
    // Group detections by kind so we never match a phone box onto a laptop.
    const byKind = new Map<string, Detection[]>();
    for (const d of detections) {
      const list = byKind.get(d.kind) ?? [];
      list.push(d);
      byKind.set(d.kind, list);
    }

    const matched = new Set<Detection>();

    // 1. Match each track to the best detection of its own kind.
    for (const track of this.tracks) {
      const candidates = byKind.get(track.kind) ?? [];
      let best: Detection | null = null;
      let bestIou = this.cfg.iouThreshold;
      for (const det of candidates) {
        const score = iou(track.bbox, det.bbox);
        if (score > bestIou) {
          bestIou = score;
          best = det;
        }
      }
      if (best) {
        this.applyHit(track, best, now);
        matched.add(best);
      } else {
        track.misses += 1;
        // A phone that vanishes for a few samples keeps its history (short-term
        // persistence) — it only dies after MAX_MISSES consecutive misses.
        if (track.misses > this.cfg.maxMisses) track.confirmed = false;
      }
    }

    // 2. Unmatched detections become new tracks.
    for (const d of detections) {
      if (matched.has(d)) continue;
      this.tracks.push({
        id: this.nextId++,
        kind: d.kind,
        label: d.label,
        bbox: d.bbox,
        firstSeen: now,
        lastSeen: now,
        hits: 1,
        misses: 0,
        peak: d.score,
        lastScore: d.score,
        confidenceHistory: [d.score],
        confirmed: false,
        confirmedAt: null,
      });
    }

    // 3. Drop dead tracks; sweep for freshly confirmed ones.
    this.tracks = this.tracks.filter((t) => t.misses <= this.cfg.maxMisses);
    return this.sweep(now);
  }

  /** Reset all state (exam restart / stream change). */
  reset(): void {
    this.tracks = [];
    this.nextId = 1;
  }

  // ── internals ──────────────────────────────────────────────────────────────
  private applyHit(track: TrackedObject, det: Detection, now: number): void {
    track.bbox = det.bbox;
    track.label = det.label;
    track.lastSeen = now;
    track.misses = 0;
    track.hits += 1;
    track.lastScore = det.score;
    track.peak = Math.max(track.peak, det.score);
    track.confidenceHistory.push(det.score);
    if (track.confidenceHistory.length > this.cfg.maxHistory) {
      track.confidenceHistory.shift();
    }
  }

  /** Emit tracks whose confirmation rule just became satisfied — once. */
  private sweep(now: number): TrackedObject[] {
    const fresh: TrackedObject[] = [];
    for (const track of this.tracks) {
      const withinWindow = now - track.firstSeen <= this.cfg.confirmWindowMs;
      if (!track.confirmed && track.hits >= this.cfg.minHits && withinWindow) {
        track.confirmed = true;
        track.confirmedAt = now;
        fresh.push(track);
      }
    }
    return fresh;
  }
}
