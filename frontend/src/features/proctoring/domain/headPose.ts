// Absolute head pose + eye-gaze signals from the MediaPipe face landmarker
// (facial transformation matrix + blendshapes).
//
// The landmark-ratio yaw in ProctorAI drifts when the head rolls: a student
// tilting down with a 16° roll read as "turned left" while the true yaw was
// −7°, the same as when facing the screen. The transformation matrix gives
// real angles, and the eyeLookDown / eyeBlink / eyeSquint blendshapes catch
// eyes-down reading that barely moves the head.

export type HeadPose = { yaw: number; pitch: number; roll: number };

export const HEAD_POSE = {
  // Degrees of yaw away from the calibrated neutral that count as a head turn.
  // Screen-facing frames varied ±6° around neutral; real turns were 25°+.
  TURN_DEG: 14,
  UP_DEG: 15,
  // Head bowed toward the desk with the eyes level in the head (phone on lap).
  // Screen-facing pitch stayed within ±10° of neutral.
  DOWN_DEG: 15,
} as const;

// Refitted on 205 labelled frames from a low-camera session: real look-downs
// scored 1.80–2.06 with eyeLookDown ≥ 0.7, screen-facing frames reached 1.06
// (squint + partial blink while reading). MIN 0.79 flagged 95/227 frames of
// an earlier session; 1.5 keeps every labelled look-down. PITCH_REF is a
// screen-facing pitch, so the pitch term is relative to the student's neutral.
export const LOOK_DOWN = {
  MIN: 1.5,
  /** Eyes must actually point down — blink + squint alone is a blink. */
  EYES_MIN: 0.5,
  PITCH_WEIGHT: 0.03,
  PITCH_REF: 2.8,
} as const;

const DEG = 180 / Math.PI;

export function poseFromMatrix(data: ArrayLike<number> | undefined | null): HeadPose | null {
  if (!data || data.length < 16) return null;
  // Column-major keeps the translation (large negative z) at index 14; the
  // row-major layout has it at 11. Read whichever layout this build emits.
  const colMajor = Math.abs(data[14] ?? 0) >= Math.abs(data[11] ?? 0);
  const r = (i: number, j: number) => (colMajor ? data[j * 4 + i] : data[i * 4 + j]) ?? 0;
  return {
    pitch: Math.atan2(r(2, 1), r(2, 2)) * DEG,
    yaw: Math.asin(Math.max(-1, Math.min(1, -r(2, 0)))) * DEG,
    roll: Math.atan2(r(1, 0), r(0, 0)) * DEG,
  };
}

export function blendshapeScores(
  categories: ReadonlyArray<{ categoryName?: string; score?: number }> | undefined | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of categories ?? []) if (c.categoryName) out[c.categoryName] = c.score ?? 0;
  return out;
}

/** `pitchFromNeutral` is degrees below the student's calibrated neutral pitch. */
export function lookDownScore(bs: Record<string, number>, pitchFromNeutral: number): number {
  const avg = (a: string, b: string) => ((bs[a] ?? 0) + (bs[b] ?? 0)) / 2;
  return (
    avg("eyeLookDownLeft", "eyeLookDownRight") +
    avg("eyeBlinkLeft", "eyeBlinkRight") +
    avg("eyeSquintLeft", "eyeSquintRight") +
    LOOK_DOWN.PITCH_WEIGHT * Math.max(0, pitchFromNeutral + LOOK_DOWN.PITCH_REF)
  );
}

export function isLookingDown(bs: Record<string, number>, pitchFromNeutral: number): boolean {
  const eyes = ((bs.eyeLookDownLeft ?? 0) + (bs.eyeLookDownRight ?? 0)) / 2;
  return eyes >= LOOK_DOWN.EYES_MIN && lookDownScore(bs, pitchFromNeutral) >= LOOK_DOWN.MIN;
}
