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
  mean: [0.17728, 0.63284, -4.334, 0.02257, 0.58919, 0.86713, 0.30717, 0.5247, 0.13823, 0.7088, 0.01221],
  std: [0.11018, 0.25719, 1.22797, 0.99685, 0.47254, 0.95002, 0.4493, 0.1691, 0.05401, 0.25372, 0.10984],
  weights: [0.3524, 0.2356, 0.037, 0.3564, -0.5472, 0.2255, 0.1066, 0.5357, -0.4074, 0.1778, -0.2425],
  bias: -0.0926,
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
