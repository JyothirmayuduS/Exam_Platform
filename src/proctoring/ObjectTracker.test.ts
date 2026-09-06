import { describe, it, expect } from "vitest";
import { ObjectTracker } from "./ObjectTracker";
import type { Detection } from "./types";

const T = 900; // object cadence (CADENCE.OBJECT_MS)

function phone(x: number, score = 0.7): Detection {
  return { kind: "phone", label: "cell phone", score, bbox: { x, y: 0.4, width: 0.2, height: 0.25 } };
}

describe("ObjectTracker", () => {
  it("confirms an object only after MIN_HITS sustained samples", () => {
    const tracker = new ObjectTracker();
    let confirmed: ReturnType<ObjectTracker["update"]> = [];

    confirmed = tracker.update([phone(0.1)], T);
    expect(confirmed).toHaveLength(0); // 1 hit

    confirmed = tracker.update([phone(0.11)], T * 2);
    expect(confirmed).toHaveLength(0); // 2 hits

    confirmed = tracker.update([phone(0.09)], T * 3);
    expect(confirmed).toHaveLength(1); // 3 hits → confirmed
    expect(confirmed[0]?.confirmed).toBe(true);
    expect(confirmed[0]?.hits).toBe(3);

    // A single detection never re-fires — confirmation is emitted once.
    confirmed = tracker.update([phone(0.1)], T * 4);
    expect(confirmed).toHaveLength(0);
  });

  it("keeps identity across a single missed sample (persistence)", () => {
    const tracker = new ObjectTracker();
    tracker.update([phone(0.1)], T);
    tracker.update([phone(0.12)], T * 2);
    // Miss one sample — phone dips below threshold for a frame (~1 s). The
    // track survives and keeps its streak.
    tracker.update([], T * 3);
    expect(tracker.live).toHaveLength(1);
    const confirmed = tracker.update([phone(0.11)], T * 4);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]?.hits).toBe(3); // hits survived the miss
  });

  it("drops a track only after TWO consecutive missed samples, then re-confirms a new one", () => {
    const tracker = new ObjectTracker();
    tracker.update([phone(0.1)], T);
    tracker.update([phone(0.12)], T * 2);
    // One missed sample is tolerated (short-term persistence)…
    tracker.update([], T * 3);
    expect(tracker.live).toHaveLength(1);
    // …a second consecutive miss kills the track (~2 s off-frame).
    tracker.update([], T * 4);
    expect(tracker.live).toHaveLength(0);

    const confirmed = tracker.update([phone(0.5)], T * 5);
    expect(confirmed).toHaveLength(0); // brand-new track, needs 3 hits again
    void tracker.update([phone(0.5)], T * 6);
    const final = tracker.update([phone(0.5)], T * 7);
    expect(final).toHaveLength(1);
    expect(final[0]?.confirmed).toBe(true);
  });

  it("never confirms a phone that flickers once across many seconds", () => {
    // One detection every ~9 s — three hits, but never 3 hits inside the
    // CONFIRM_WINDOW_MS, so nothing ever confirms.
    const tracker = new ObjectTracker();
    tracker.update([phone(0.7)], 1_000);
    tracker.update([phone(0.7)], 10_000);
    const fresh = tracker.update([phone(0.7)], 19_000);
    expect(fresh).toHaveLength(0);
    expect(tracker.live.some((t) => t.confirmed)).toBe(false);
  });

  it("never matches different kinds onto the same track", () => {
    const tracker = new ObjectTracker();
    tracker.update([phone(0.1)], T);
    const laptop: Detection = {
      kind: "laptop",
      label: "laptop",
      score: 0.9,
      bbox: { x: 0.1, y: 0.4, width: 0.2, height: 0.25 },
    };
    tracker.update([laptop], T * 2);
    expect(tracker.live).toHaveLength(2);
  });
});
