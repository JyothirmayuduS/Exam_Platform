import { describe, it, expect } from "vitest";
import { ObjectTracker } from "./ObjectTracker";
import { ViolationGate } from "./violations";
import { decideObjectEvent } from "./fusion";
import type { GazeFusionState } from "./fusion";
import type { Detection, ProctorCategory } from "./types";
import { CADENCE, COOLDOWN_MS, TRACKING, OBJECT } from "./config";

// ── Test harness ─────────────────────────────────────────────────────────────
// Mirrors the wiring in ProctorAI.tsx: raw detections → ObjectTracker (temporal
// confirmation) → decideObjectEvent (gaze/phone fusion) → ViolationGate
// (cooldown dedupe). Gaze_away events are emitted by the head-pose streak logic
// in the component and are therefore exercised by the fusion/unit tests, not
// here — this file validates the OBJECT pipeline end to end.

const T = CADENCE.OBJECT_MS;

interface Emission { category: ProctorCategory; label: string; t: number }

interface Step {
  t: number;
  dets: Detection[];
  gaze?: GazeFusionState;
}

function neutral(): GazeFusionState {
  return { headDown: false, headDownSince: null, direction: "center" };
}

function headDown(): GazeFusionState {
  return { headDown: true, headDownSince: 1_000, direction: "down" };
}

function phone(score: number, x = 0.4): Detection {
  return { kind: "phone", label: "cell phone", score, bbox: { x, y: 0.45, width: 0.22, height: 0.3 } };
}

function run(steps: Step[]): Emission[] {
  const tracker = new ObjectTracker();
  const gate = new ViolationGate();
  const emissions: Emission[] = [];
  for (const s of steps) {
    // Mirror ProctorAI.toDetections: per-kind confidence gate happens BEFORE
    // the tracker — a sub-threshold detection is a "miss", never a hit.
    const gated = s.dets.filter((d) =>
      d.score >= (d.kind === "phone" ? OBJECT.PHONE_MIN_CONF : OBJECT.LAPTOP_MIN_CONF)
    );
    const fresh = tracker.update(gated, s.t);
    for (const track of fresh) {
      const out = decideObjectEvent(track, s.gaze ?? neutral(), s.t);
      if (out.fired && gate.allows(out.category, s.t)) {
        gate.markFired(out.category, s.t);
        emissions.push({ category: out.category, label: out.label, t: s.t });
      }
    }
  }
  return emissions;
}

const every = (n: number, t0 = T, fn: (i: number) => Detection[]): Step[] =>
  Array.from({ length: n }, (_, i) => ({ t: t0 + i * T, dets: fn(i) }));

describe("Proctor pipeline — acceptance", () => {
  it("a visible phone confirms only after 3 hits and fires exactly one phone_detected", () => {
    const emissions = run(every(4, T, () => [phone(0.7)]));
    const phoneEvts = emissions.filter((e) => e.category === "phone_detected");
    expect(phoneEvts).toHaveLength(1);
    expect(phoneEvts[0]?.t).toBe(T * 3); // the confirmation sample
    expect(phoneEvts[0]?.label).toContain("Mobile phone detected");
  });

  it("repeated detection inside the cooldown never spams", () => {
    // Phone stays in view for a long stretch — cooldown (10 s) must suppress
    // every repeat beyond the first.
    const count = Math.ceil(COOLDOWN_MS["phone_detected"] / T) + 5;
    const emissions = run(every(count, T, () => [phone(0.72)]));
    const phoneEvts = emissions.filter((e) => e.category === "phone_detected");
    expect(phoneEvts).toHaveLength(1);
  });

  it("a single accidental detection never becomes a violation", () => {
    const emissions = run([
      { t: T, dets: [phone(0.46)] }, // one flash, then gone
      { t: T * 2, dets: [] },
      { t: T * 3, dets: [] },
      { t: T * 4, dets: [] },
    ]);
    expect(emissions.filter((e) => e.category === "phone_detected")).toHaveLength(0);
  });

  it("a sub-threshold phone never confirms even with repeated samples", () => {
    const emissions = run(every(6, T, () => [phone(0.3)])); // below 0.45 gate
    expect(emissions.filter((e) => e.category === "phone_detected")).toHaveLength(0);
  });

  it("phone disappearing for ONE sample keeps its track and still confirms", () => {
    const emissions = run([
      { t: T, dets: [phone(0.7)] },
      { t: T * 2, dets: [phone(0.7)] },
      { t: T * 3, dets: [] }, // one missed sample — persistence
      { t: T * 4, dets: [phone(0.7)] },
    ]);
    const phoneEvts = emissions.filter((e) => e.category === "phone_detected");
    expect(phoneEvts).toHaveLength(1);
    expect(phoneEvts[0]?.t).toBe(T * 4);
  });

  it("confirmed phone + head tilted down → possible_phone_use (escalated)", () => {
    const emissions = run(every(3, T, () => [phone(0.74)]).map((s, i) =>
      i >= 2 ? { ...s, gaze: headDown() } : s
    ));
    expect(emissions[0]?.category).toBe("possible_phone_use");
    expect(emissions[0]?.label.toLowerCase()).toContain("possible phone use");
    expect(emissions.filter((e) => e.category === "phone_detected")).toHaveLength(0);
  });

  it("a new appearance after the track dies re-confirms AFTER the cooldown", () => {
    // Confirm at t≈2.7s; phone leaves (2 misses) at ~4.5s; new phone at 15s+.
    const emissions = run([
      ...every(3, T, () => [phone(0.7)]),
      { t: T * 3, dets: [] },
      { t: T * 4, dets: [] },
      { t: 20_000, dets: [phone(0.7)] },
      { t: 20_900, dets: [phone(0.7)] },
      { t: 21_800, dets: [phone(0.7)] },
    ]);
    const phoneEvts = emissions.filter((e) => e.category === "phone_detected");
    expect(phoneEvts).toHaveLength(2); // second incident, well past cooldown
  });
});

describe("Proctor pipeline — configuration sanity", () => {
  it("3 hits at the 900 ms cadence confirm inside ~2–3 s, not 9 s", () => {
    // TRACKING.MIN_HITS samples at CADENCE.OBJECT_MS must fit the window.
    const spreadMs = (TRACKING.MIN_HITS - 1) * CADENCE.OBJECT_MS;
    expect(spreadMs).toBeLessThanOrEqual(TRACKING.CONFIRM_WINDOW_MS);
    expect(spreadMs).toBeGreaterThanOrEqual(1_500); // tight enough to matter
  });
});
