// ────────────────────────────────────────────────────────────────────────────
// Diagnostics sink (dev overlay).
//
// The detection loop writes a small snapshot of its live state here every
// tick; ProctorDebugOverlay reads it on a timer. Keeping the sink OUTSIDE the
// React tree means the AI loop never triggers renders on its own — the
// overlay simply polls at ~2 fps.
// ────────────────────────────────────────────────────────────────────────────

import type { RiskState, TrackedObject } from "./types";

export interface DiagSnapshot {
  /** Last model-load/run error text, when any. */
  engineError: string | null;
  loadStep: string;
  faceCount: number;
  gazeDirection: string;
  gazeScore: number;
  phoneDetected: boolean;
  voiceLevel: number;
  voiceSpeaking: boolean;
  risk: RiskState;
  /** Live tracked objects (ids, hits, conf). */
  tracks: readonly TrackedObject[];
  /** Last few raw object samples (label → conf), for debugging detection. */
  objectSamples: string[];
  /** rAF cadence of the tick loop. */
  fps: number;
}

const MAX_SAMPLES = 10;

export const proctorDiag: DiagSnapshot = {
  engineError: null,
  loadStep: "idle",
  faceCount: 0,
  gazeDirection: "center",
  gazeScore: 1,
  phoneDetected: false,
  voiceLevel: 0,
  voiceSpeaking: false,
  risk: { score: 0, level: "normal" },
  tracks: [],
  objectSamples: [],
  fps: 0,
};

/** Ring buffer append (dev only — tiny). */
export function pushObjectSample(text: string): void {
  proctorDiag.objectSamples.push(text);
  if (proctorDiag.objectSamples.length > MAX_SAMPLES) {
    proctorDiag.objectSamples.shift();
  }
}
