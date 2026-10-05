// Why the camera shows no face: covered (hand / object over the lens, or
// blacked out) versus the student out of frame. In real sessions a hand
// over the camera filled ~50% of the frame with skin tones and a hand over
// the face 34–38%, while an empty seat or a camera turned away showed 11–23%.

export type AbsenceKind = "covered" | "out_of_frame";
export type FrameStats = { lum: number; std: number; skin: number };

export const ABSENCE = {
  WINDOW: 15,       // face ticks (~3 s at FACE_MS=200)
  MIN_MISSING: 4,   // missing ticks inside the window before flagging
  REPEAT_MS: 3_000,
  DARK_LUM: 0.1,
  FLAT_STD: 0.05,
  SKIN_COVERED: 0.3,
} as const;

export const ABSENCE_LABEL: Record<AbsenceKind, { start: string; repeat: string }> = {
  covered: {
    start: "Camera or face covered — something is blocking the camera",
    repeat: "Camera still covered",
  },
  out_of_frame: {
    start: "Student moved out of the camera frame",
    repeat: "Student still out of the camera frame",
  },
};

export function frameStats(px: ArrayLike<number>): FrameStats {
  const n = Math.floor(px.length / 4);
  if (n === 0) return { lum: 0, std: 0, skin: 0 };
  let sum = 0;
  let sq = 0;
  let skin = 0;
  for (let i = 0; i < n * 4; i += 4) {
    const r = px[i]! / 255;
    const g = px[i + 1]! / 255;
    const b = px[i + 2]! / 255;
    const l = (r + g + b) / 3;
    sum += l;
    sq += l * l;
    if (r > 0.35 && r > g * 1.08 && g >= b && r - b > 0.08) skin++;
  }
  const lum = sum / n;
  return { lum, std: Math.sqrt(Math.max(0, sq / n - lum * lum)), skin: skin / n };
}

export function classifyAbsence(s: FrameStats): AbsenceKind {
  if (s.lum < ABSENCE.DARK_LUM || s.std < ABSENCE.FLAT_STD || s.skin >= ABSENCE.SKIN_COVERED) return "covered";
  return "out_of_frame";
}

/**
 * Counts missing-face ticks over a sliding window instead of a consecutive
 * streak, so a face that flickers back for a frame (camera half turned away)
 * still reads as gone.
 */
export class AbsenceMonitor {
  private hist: boolean[] = [];
  private episode = false;
  private lastEmit = -Infinity;

  update(missing: boolean, now: number): "start" | "repeat" | null {
    this.hist.push(missing);
    if (this.hist.length > ABSENCE.WINDOW) this.hist.shift();
    const misses = this.hist.reduce((n, m) => n + (m ? 1 : 0), 0);
    if (misses === 0) {
      this.episode = false;
      return null;
    }
    if (!missing || misses < ABSENCE.MIN_MISSING) return null;
    if (!this.episode) {
      this.episode = true;
      this.lastEmit = now;
      return "start";
    }
    if (now - this.lastEmit >= ABSENCE.REPEAT_MS) {
      this.lastEmit = now;
      return "repeat";
    }
    return null;
  }
}
