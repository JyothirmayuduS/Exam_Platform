import { describe, expect, it } from "vitest";
import { aiFlagCountsTowardLimit } from "./flagLimit";

describe("aiFlagCountsTowardLimit", () => {
  it("counts confident phone, earbud and second-person detections", () => {
    expect(aiFlagCountsTowardLimit("phone_detected", 0.8)).toBe(true);
    expect(aiFlagCountsTowardLimit("possible_phone_use", 0.7)).toBe(true);
    expect(aiFlagCountsTowardLimit("earbuds_detected", 0.6)).toBe(true);
    expect(aiFlagCountsTowardLimit("multiple_faces", 0.9)).toBe(true);
  });

  it("ignores low-confidence detections", () => {
    expect(aiFlagCountsTowardLimit("earbuds_detected", 0.45)).toBe(false);
  });

  it("keeps gaze, face-framing, laptop and audio flags review-only", () => {
    for (const t of ["gaze_away", "no_face", "partial_face", "laptop_detected", "audio_detected"] as const) {
      expect(aiFlagCountsTowardLimit(t, 1)).toBe(false);
    }
  });
});
