// Dark (black) earbuds seated in the ear. The object model never labels them
// and the white-earbud check can't see them; in the session reports they show
// as a compact dark blob ringed by the lighter ear, visible only when the head
// turns enough to show that ear. Hair and curtain stripes at the face edge are
// elongated, touch the crop border, or sit next to other dark pixels.
//
// Refit on five session reports (~760 frames): 10/16 bud frames caught, 1
// false hit (was 3/16 and 2). Buds filling the ear when the head is turned
// hard ran past the old 0.15 area cap; buds deeper in the ear sat on the edge
// of the single patch and merged with hair, so a second patch further out is
// also tried.

import type { BBox } from "./types";

export const DARK_BUD = {
  SIZE: 24,
  // Ear is in view when the face is this many times wider on its side of the nose.
  MIN_VISIBLE: 2.0,
  AREA_MIN: 0.03,
  AREA_MAX: 0.2,
  MAX_TOUCH: 1,
  MAX_ELONGATION: 3,
  MIN_RING: 0.65,
  // 0.35 adds bud crops seen at an angle (blob less square) without new false hits.
  MIN_FILL: 0.35,
  /** Patch centres, as a fraction of face width outward from the jaw landmark. */
  SHIFTS: [0.05, 0.1],
} as const;

export type EarPatch = { box: BBox; visible: number; side: "left" | "right" };

/**
 * Ear crops beside landmarks 234 / 454, with how much of that ear faces the
 * camera. One left/right pair per entry in `DARK_BUD.SHIFTS`, nearest first.
 */
export function earPatches(lms: ReadonlyArray<{ x: number; y: number }>): EarPatch[] {
  const nose = lms[1];
  const left = lms[234];
  const right = lms[454];
  if (!nose || !left || !right) return [];
  let minX = Infinity;
  let maxX = -Infinity;
  for (const p of lms) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
  }
  const fw = maxX - minX;
  const s = fw * 0.32;
  const dl = Math.abs(nose.x - left.x);
  const dr = Math.abs(right.x - nose.x);
  const sides = [
    { q: left, dir: -1, side: "left" as const, visible: dl / Math.max(dr, 1e-6) },
    { q: right, dir: 1, side: "right" as const, visible: dr / Math.max(dl, 1e-6) },
  ];
  return DARK_BUD.SHIFTS.flatMap((shift) =>
    sides.map(({ q, dir, side, visible }) => {
      const cx = q.x + dir * fw * shift;
      const cy = q.y + fw * 0.05;
      return { box: { x: cx - s / 2, y: cy - s / 2, width: s, height: s }, visible, side };
    }),
  );
}

/** `px` is a SIZE×SIZE RGBA crop of one ear patch. */
export function isDarkEarbud(px: ArrayLike<number>): boolean {
  const S: number = DARK_BUD.SIZE;
  const N = S * S;
  if (px.length < N * 4) return false;
  const lum = new Float32Array(N);
  for (let i = 0; i < N; i++) lum[i] = (px[i * 4]! + px[i * 4 + 1]! + px[i * 4 + 2]!) / 765;

  const sorted = Array.from(lum).sort((a, b) => a - b);
  const pos = 0.75 * (N - 1);
  const lo = Math.floor(pos);
  const ref = sorted[lo]! + (sorted[Math.min(lo + 1, N - 1)]! - sorted[lo]!) * (pos - lo);
  const dark = new Uint8Array(N);
  for (let i = 0; i < N; i++) dark[i] = lum[i]! < ref * 0.55 && lum[i]! < 0.35 ? 1 : 0;

  // Largest 4-connected dark component.
  const label = new Int32Array(N);
  let best: number[] = [];
  let next = 1;
  for (let i = 0; i < N; i++) {
    if (!dark[i] || label[i]) continue;
    const comp: number[] = [];
    const stack = [i];
    label[i] = next;
    while (stack.length) {
      const k = stack.pop()!;
      comp.push(k);
      const x = k % S;
      const y = (k - x) / S;
      const nb = [x > 0 ? k - 1 : -1, x < S - 1 ? k + 1 : -1, y > 0 ? k - S : -1, y < S - 1 ? k + S : -1];
      for (const j of nb) {
        if (j >= 0 && dark[j] && !label[j]) {
          label[j] = next;
          stack.push(j);
        }
      }
    }
    next++;
    if (comp.length > best.length) best = comp;
  }
  if (best.length < 4) return false;

  let minX = S, maxX = -1, minY = S, maxY = -1;
  const inBlob = new Uint8Array(N);
  for (const k of best) {
    inBlob[k] = 1;
    const x = k % S;
    const y = (k - x) / S;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const area = best.length / N;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const touch = +(minY === 0) + +(maxY === S - 1) + +(minX === 0) + +(maxX === S - 1);
  const fill = best.length / (w * h);
  const elong = Math.max(w, h) / Math.min(w, h);

  // Two-pixel ring around the blob (two 4-connected dilations).
  let grown = inBlob;
  for (let it = 0; it < 2; it++) {
    const g2 = new Uint8Array(grown);
    for (let k = 0; k < N; k++) {
      if (!grown[k]) continue;
      const x = k % S;
      if (x > 0) g2[k - 1] = 1;
      if (x < S - 1) g2[k + 1] = 1;
      if (k >= S) g2[k - S] = 1;
      if (k < N - S) g2[k + S] = 1;
    }
    grown = g2;
  }
  let ringSum = 0;
  let ringN = 0;
  for (let k = 0; k < N; k++) {
    if (grown[k] && !inBlob[k]) {
      ringSum += lum[k]!;
      ringN++;
    }
  }
  const ring = ringN ? ringSum / ringN / Math.max(ref, 1e-6) : 0;

  return (
    area >= DARK_BUD.AREA_MIN &&
    area <= DARK_BUD.AREA_MAX &&
    touch <= DARK_BUD.MAX_TOUCH &&
    elong <= DARK_BUD.MAX_ELONGATION &&
    ring >= DARK_BUD.MIN_RING &&
    fill >= DARK_BUD.MIN_FILL
  );
}
