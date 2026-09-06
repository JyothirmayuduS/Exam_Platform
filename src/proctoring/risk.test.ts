import { describe, it, expect } from "vitest";
import { RiskEngine, levelForScore } from "./risk";

describe("RiskEngine", () => {
  it("adds weight per category and clamps at 100", () => {
    const r = new RiskEngine();
    r.add("phone_detected"); // +35
    expect(r.state.score).toBe(35);
    expect(r.state.level).toBe("low");

    r.add("multiple_faces"); // +50 → 85
    expect(r.state.score).toBe(85);
    expect(r.state.level).toBe("critical");

    r.add("gaze_away"); // +8 → 93
    r.add("possible_phone_use"); // would be 148 → clamped 100
    expect(r.state.score).toBe(100);
  });

  it("counts each category only once per incident window (no stacking)", () => {
    const r = new RiskEngine();
    const now = 1_000_000;
    r.add("phone_detected", now);
    r.add("phone_detected", now + 5_000); // same incident → no extra points
    expect(r.state.score).toBe(35);
  });

  it("decays toward zero over clean time", () => {
    const now = 1_000_000;
    const r = new RiskEngine(now);
    r.add("no_face", now); // +20
    expect(r.state.score).toBe(20);

    // ~3 minutes later (one full decay constant) → ~7 points.
    r.advance(now + 180_000);
    expect(r.state.score).toBeLessThan(20);
    expect(r.state.score).toBeGreaterThan(5);

    // After several more minutes it floors at 0.
    r.advance(now + 180_000 + 900_000);
    expect(r.state.score).toBe(0);
  });

  it("maps scores to levels", () => {
    expect(levelForScore(0)).toBe("normal");
    expect(levelForScore(40)).toBe("low");
    expect(levelForScore(70)).toBe("high");
    expect(levelForScore(95)).toBe("critical");
  });
});
