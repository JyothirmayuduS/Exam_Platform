import { describe, expect, it } from "vitest";
import { phoneLikelihood, PHONE_VERIFY_MIN } from "@/features/proctoring/domain/phoneVerifier";
import type { BBox } from "@/features/proctoring/domain/types";

const box = ([x, y, width, height]: number[]): BBox => ({ x, y, width, height });

// Probabilities produced by the Python trainer on the same boxes.
const PARITY = [
  { score: 0.2792, b: [0.4639, 0.9407, 0.2583, 0.0519], f: [0.3972, 0.137, 0.2083, 0.2778], lum: 0.8168, sat: 0.0691, p: 0.9385 },
  { score: 0.5241, b: [0.4389, 0.8778, 0.2528, 0.1111], f: [0.3694, 0.1889, 0.2722, 0.363], lum: 0.6175, sat: 0.1031, p: 0.9228 },
  { score: 0.138, b: [0.6667, 0.9185, 0.2306, 0.0741], f: [0.3806, 0.1259, 0.2194, 0.2926], lum: 0.6961, sat: 0.2261, p: 0.8304 },
  { score: 0.2145, b: [0.3222, 0.1519, 0.0722, 0.0815], f: [0.3306, 0.1185, 0.2111, 0.2815], lum: 0.2998, sat: 0.1356, p: 0.1017 },
];

describe("phoneLikelihood", () => {
  it("matches the trained model", () => {
    for (const c of PARITY) {
      expect(phoneLikelihood(c.score, box(c.b), box(c.f), { lum: c.lum, sat: c.sat })).toBeCloseTo(c.p, 2);
    }
  });

  it("keeps a phone at the bottom edge and drops a hand-on-chin box", () => {
    const face = box([0.38, 0.12, 0.22, 0.3]);
    const deskPhone = phoneLikelihood(0.2, box([0.45, 0.92, 0.25, 0.07]), face, { lum: 0.78, sat: 0.08 });
    const chinHand = phoneLikelihood(0.35, box([0.42, 0.3, 0.07, 0.12]), face, { lum: 0.42, sat: 0.18 });
    expect(deskPhone).toBeGreaterThanOrEqual(PHONE_VERIFY_MIN);
    expect(chinHand).toBeLessThan(PHONE_VERIFY_MIN);
  });
});
