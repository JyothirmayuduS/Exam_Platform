import { describe, it, expect } from "vitest";
import { decideObjectEvent, gazeLabel, FUSION_LABELS } from "./fusion";
import type { GazeFusionState } from "./fusion";
import type { TrackedObject } from "./types";

function confirmedPhone(peak = 0.74, hits = 4): TrackedObject {
  return {
    id: 1,
    kind: "phone",
    label: "cell phone",
    bbox: { x: 0.2, y: 0.5, width: 0.2, height: 0.3 },
    firstSeen: 1000,
    lastSeen: 9000,
    hits,
    misses: 0,
    peak,
    lastScore: peak,
    confidenceHistory: [0.7, 0.72, peak],
    confirmed: true,
    confirmedAt: 9000,
  };
}

function gaze(headDown: boolean, headDownSince: number | null = null, direction: GazeFusionState["direction"] = "center"): GazeFusionState {
  return { headDown, headDownSince, direction };
}

describe("decideObjectEvent — phone + gaze fusion", () => {
  const NOW = 10_000;

  it("head down with NO phone visible is never a phone event", () => {
    // The gaze label is the only thing produced and it must not mention a phone.
    expect(gazeLabel("down")).toBe(FUSION_LABELS.gazeDown);
    expect(FUSION_LABELS.gazeDown.toLowerCase()).not.toContain("phone");
    expect(FUSION_LABELS.gazeDown.toLowerCase()).not.toContain("mobile");
  });

  it("confirmed phone with neutral head / phone_detected only", () => {
    const out = decideObjectEvent(confirmedPhone(), gaze(false), NOW);
    expect(out.fired).toBe(true);
    if (out.fired) {
      expect(out.category).toBe("phone_detected");
      expect(out.label).toContain("Mobile phone detected");
      expect(out.label).not.toContain("possible");
    }
  });

  it("confirmed phone while head tilted down / possible_phone_use (escalated)", () => {
    const out = decideObjectEvent(confirmedPhone(), gaze(true, 8_000, "down"), NOW);
    expect(out.fired).toBe(true);
    if (out.fired) {
      expect(out.category).toBe("possible_phone_use");
      expect(out.label.toLowerCase()).toContain("possible phone use");
      expect(out.confidence).toBeCloseTo(0.74, 2);
    }
  });

  it("head-down that ended more than 2 s ago does NOT escalate", () => {
    const out = decideObjectEvent(confirmedPhone(), gaze(true, 6_000, "down"), NOW);
    expect(out.fired).toBe(true);
    if (out.fired) expect(out.category).toBe("phone_detected");
  });

  it("confirmed earbuds / earbuds_detected regardless of head pose", () => {
    const buds: TrackedObject = {
      ...confirmedPhone(),
      kind: "earbuds",
      label: "headphones",
      peak: 0.66,
    };
    const out = decideObjectEvent(buds, gaze(false), NOW);
    expect(out.fired).toBe(true);
    if (out.fired) {
      expect(out.category).toBe("earbuds_detected");
      expect(out.label).toContain("Earbuds/headphones detected");
    }
  });

  it("laptop confirmations are reported as electronics regardless of head pose", () => {
    const laptop: TrackedObject = {
      id: 2,
      kind: "laptop",
      label: "laptop",
      bbox: { x: 0.1, y: 0.6, width: 0.4, height: 0.3 },
      firstSeen: 1000,
      lastSeen: 9000,
      hits: 3,
      misses: 0,
      peak: 0.88,
      lastScore: 0.88,
      confidenceHistory: [0.8, 0.85, 0.88],
      confirmed: true,
      confirmedAt: 9000,
    };
    const out = decideObjectEvent(laptop, gaze(false), NOW);
    if (out.fired) {
      expect(out.category).toBe("laptop_detected");
      expect(out.label).toContain("laptop");
    }
  });
});
