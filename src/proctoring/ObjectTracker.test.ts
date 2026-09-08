import { describe, it, expect } from "vitest";
import { ObjectTracker } from "./ObjectTracker";
import { TRACKING, CADENCE } from "./config";
import type { Detection } from "./types";

const T = CADENCE.OBJECT_MS; // object cadence (500 ms — fast, responsive)
const MIN_HITS = TRACKING.MIN_HITS; // now 2 — a phone confirms in ~1 s when visible

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
    expect(confirmed).toHaveLength(MIN_HITS === 2 ? 1 : 0); // MIN_HITS hits / confirmed (2 now)

    expect(confirmed[0]?.confirmed).toBe(true);
    expect(confirmed[0]?.hits).toBe(MIN_HITS);

    // A single detection never re-fires — confirmation is emitted once.
    confirmed = tracker.update([phone(0.1)], T * 3);
    expect(confirmed).toHaveLength(0);
  });

  it("keeps identity across a single missed sample (persistence)", () => {
    const tracker = new ObjectTracker();
    tracker.update([phone(0.1)], T);
    // Miss one sample — phone dips below threshold for a frame. The track
    // survives and keeps its streak.
    tracker.update([], T * 2);
    expect(tracker.live).toHaveLength(1);
    const confirmed = tracker.update([phone(0.11)], T * 3);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]?.hits).toBe(MIN_HITS); // first hit + resumed hit = MIN_HITS
  });

  it("drops a track only after MAX_MISSES+1 consecutive missed samples (persistence), then re-confirms", () => {
    const tracker = new ObjectTracker();
    tracker.update([phone(0.1)], T);
    // Up to MAX_MISSES consecutive misses are tolerated (short-term persistence)…
    for (let m = 0; m < TRACKING.MAX_MISSES; m++) tracker.update([], T * (2 + m));
    expect(tracker.live).toHaveLength(1);
    // …one more consecutive miss kills the track.
    tracker.update([], T * (2 + TRACKING.MAX_MISSES));
    expect(tracker.live).toHaveLength(0);

    const confirmed = tracker.update([phone(0.5)], T * (3 + TRACKING.MAX_MISSES));
    expect(confirmed).toHaveLength(0); // brand-new track needs MIN_HITS hits again
    const final = tracker.update([phone(0.5)], T * (4 + TRACKING.MAX_MISSES));
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
