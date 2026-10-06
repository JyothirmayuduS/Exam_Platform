// Talking detected from lip movement, for when the microphone misses quiet
// speech or a whisper. One mouth opening (a yawn, a sigh) is not talking;
// repeated open/close cycles within a few seconds are.

export const LIPS = {
  // Lip gap as a fraction of face height. Closed mouths measured ≤0.01,
  // mid-word frames 0.06–0.12.
  OPEN: 0.035,
  CLOSED: 0.015,
  WINDOW_MS: 3_000,
  MIN_CYCLES: 3,
  REPEAT_MS: 4_000,
} as const;

/** Inner-lip gap (landmarks 13/14) over the landmark box height. */
export function mouthOpenRatio(lms: ReadonlyArray<{ x: number; y: number }>): number {
  const upper = lms[13];
  const lower = lms[14];
  if (!upper || !lower) return 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of lms) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return Math.abs(lower.y - upper.y) / Math.max(maxY - minY, 1e-3);
}

export class LipActivity {
  private open = false;
  private onsets: number[] = [];

  /** Returns the number of mouth-open cycles inside the window. */
  update(ratio: number, now: number): number {
    if (!this.open && ratio >= LIPS.OPEN) {
      this.open = true;
      this.onsets.push(now);
    } else if (this.open && ratio <= LIPS.CLOSED) {
      this.open = false;
    }
    while (this.onsets.length && now - this.onsets[0]! > LIPS.WINDOW_MS) this.onsets.shift();
    return this.onsets.length;
  }

  reset(): void {
    this.open = false;
    this.onsets = [];
  }
}
