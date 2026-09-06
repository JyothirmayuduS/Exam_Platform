// ────────────────────────────────────────────────────────────────────────────
// Bounding-box geometry: IoU matching (used by the object tracker) and ROI
// helpers. Pure math — no DOM.
// ────────────────────────────────────────────────────────────────────────────

import type { BBox } from "./types";

/** Intersection-over-union of two normalized boxes. 0 when disjoint. */
export function iou(a: BBox, b: BBox): number {
  const xA = Math.max(a.x, b.x);
  const yA = Math.max(a.y, b.y);
  const xB = Math.min(a.x + a.width, b.x + b.width);
  const yB = Math.min(a.y + a.height, b.y + b.height);
  const interW = Math.max(0, xB - xA);
  const interH = Math.max(0, yB - yA);
  const inter = interW * interH;
  if (inter === 0) return 0;
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Euclidean distance between two box centers (normalized units). */
export function centerDistance(a: BBox, b: BBox): number {
  const cxA = a.x + a.width / 2;
  const cyA = a.y + a.height / 2;
  const cxB = b.x + b.width / 2;
  const cyB = b.y + b.height / 2;
  return Math.hypot(cxA - cxB, cyA - cyB);
}

/**
 * A detection "largely inside" an ROI? Phones are small objects — the model
 * reliably spots them only when the candidate holds them in the lower part of
 * the webcam frame (desk / hands zone). This returns the crop to run a second
 * detector pass on.
 */
export function lowerRegion(frameHeightFraction = 0.55): BBox {
  return { x: 0, y: 1 - frameHeightFraction, width: 1, height: frameHeightFraction };
}

/** True when the box center lies inside the given ROI box. */
export function insideRoi(box: BBox, roi: BBox, slack = 0.05): boolean {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return (
    cx >= roi.x - slack &&
    cx <= roi.x + roi.width + slack &&
    cy >= roi.y - slack &&
    cy <= roi.y + roi.height + slack
  );
}

/** Smooth EMA of recent confidences (low-pass — kills single-frame spikes). */
export function ema(values: readonly number[], k = 0.5): number {
  if (values.length === 0) return 0;
  let out = values[0] ?? 0;
  for (let i = 1; i < values.length; i++) out = out * (1 - k) + (values[i] ?? 0) * k;
  return out;
}
