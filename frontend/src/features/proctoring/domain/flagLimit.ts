import type { ProctorCategory } from "./types";

/** AI detections that can push a candidate over the exam's flag limit.
 *  Gaze, partial face, laptop and audio flags stay review-only: they fire on
 *  innocent behaviour too often to end someone's exam automatically. */
const STRIKE_CATEGORIES = new Set<ProctorCategory>([
  "multiple_faces",
  "phone_detected",
  "possible_phone_use",
  "earbuds_detected",
]);

export const STRIKE_MIN_CONFIDENCE = 0.6;

export function aiFlagCountsTowardLimit(type: ProctorCategory, confidence: number): boolean {
  return STRIKE_CATEGORIES.has(type) && confidence >= STRIKE_MIN_CONFIDENCE;
}
