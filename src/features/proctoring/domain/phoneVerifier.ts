// Second-stage check on every "cell phone" box the COCO detector returns.
//
// The stock detector scores hands on the chin, beards and shirt folds as
// phones as highly as real phones (0.3–0.4). A logistic model over box
// geometry, position relative to the face and box colour separates them.
// Weights come from scripts/proctor-verifier/train_verifier.py, trained on
// labelled exam snapshots; retrain there and paste the output here.

import type { BBox } from "@/features/proctoring/domain/types";

export const PHONE_VERIFIER = {
  names: ["score", "cy", "log_area", "log_aspect", "facezone", "rel_y", "rel_size", "lum", "sat", "bottom", "no_face"],
  mean: [0.17821, 0.63129, -4.68248, 0.22612, 0.42312, 1.22107, 0.30337, 0.55781, 0.12957, 0.69092, 0.01222],
  std: [0.11103, 0.30362, 1.16504, 1.13824, 0.48069, 1.00539, 0.46994, 0.18022, 0.05168, 0.29004, 0.10989],
  weights: [0.2372, 0.3469, 0.174, 0.3598, -0.4825, 0.0175, -0.0773, 0.4281, -0.137, 0.2979, -0.1845],
  bias: 0.0714,
} as const;

/** Phone boxes below this likelihood are dropped before tracking. */
export const PHONE_VERIFY_MIN = 0.7;

/** Mean brightness and colourfulness of the box pixels, both in [0, 1]. */
export type PixelStats = { lum: number; sat: number };

export function phoneFeatures(score: number, box: BBox, face: BBox | null, px: PixelStats): number[] {
  const { x, y, width: w, height: h } = box;
  const cy = y + h / 2;
  let facezone = 0, relY = 2, relSize = 1, noFace = 1;
  if (face) {
    const { x: fx, y: fy, width: fw, height: fh } = face;
    const zx0 = fx - fw * 0.3, zx1 = fx + fw * 1.3, zy0 = fy, zy1 = fy + fh * 1.6;
    const ix = Math.max(0, Math.min(x + w, zx1) - Math.max(x, zx0));
    const iy = Math.max(0, Math.min(y + h, zy1) - Math.max(y, zy0));
    facezone = (ix * iy) / Math.max(w * h, 1e-6);
    relY = Math.max(-2, Math.min(4, (cy - (fy + fh / 2)) / Math.max(fh, 1e-6)));
    relSize = Math.min(4, (w * h) / Math.max(fw * fh, 1e-6));
    noFace = 0;
  }
  return [
    score, cy, Math.log(Math.max(w * h, 1e-4)), Math.log(Math.max(w / Math.max(h, 1e-6), 1e-3)),
    facezone, relY, relSize, px.lum, px.sat, y + h, noFace,
  ];
}

/** Probability (0–1) that a detector "phone" box is a real phone. */
export function phoneLikelihood(score: number, box: BBox, face: BBox | null, px: PixelStats): number {
  const f = phoneFeatures(score, box, face, px);
  let z: number = PHONE_VERIFIER.bias;
  for (let i = 0; i < f.length; i++) {
    z += PHONE_VERIFIER.weights[i] * ((f[i] - PHONE_VERIFIER.mean[i]) / PHONE_VERIFIER.std[i]);
  }
  return 1 / (1 + Math.exp(-z));
}
