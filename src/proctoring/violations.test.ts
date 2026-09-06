import { describe, it, expect } from "vitest";
import { ViolationGate, severityFor } from "./violations";

describe("ViolationGate", () => {
  it("allows the first violation of a category", () => {
    const gate = new ViolationGate();
    expect(gate.allows("gaze_away", 1_000)).toBe(true);
    gate.markFired("gaze_away", 1_000);
  });

  it("blocks a repeat of the same category inside the cooldown", () => {
    const gate = new ViolationGate();
    gate.markFired("gaze_away", 1_000);
    expect(gate.allows("gaze_away", 1_000 + 5_000)).toBe(false); // 10 s cooldown
    expect(gate.allows("gaze_away", 1_000 + 11_000)).toBe(true); // after
  });

  it("never blocks a DIFFERENT category", () => {
    const gate = new ViolationGate();
    gate.markFired("gaze_away", 1_000);
    expect(gate.allows("phone_detected", 1_100)).toBe(true);
    expect(gate.allows("no_face", 1_200)).toBe(true);
  });
});

describe("severityFor", () => {
  it("escalates the fusion verdict and phone/no-face/audio", () => {
    expect(severityFor("possible_phone_use")).toBe("high");
    expect(severityFor("phone_detected")).toBe("high");
    expect(severityFor("no_face")).toBe("high");
    expect(severityFor("audio_detected")).toBe("high");
    expect(severityFor("multiple_faces")).toBe("critical");
  });

  it("keeps pure gaze/pose events as warnings (no phone implication)", () => {
    expect(severityFor("gaze_away")).toBe("warning");
    expect(severityFor("partial_face")).toBe("warning");
    expect(severityFor("laptop_detected")).toBe("warning");
  });
});
