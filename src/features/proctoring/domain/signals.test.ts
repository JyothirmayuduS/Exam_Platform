import { describe, expect, it } from "vitest";
import { blendshapeScores, LOOK_DOWN, lookDownScore, poseFromMatrix } from "@/features/proctoring/domain/headPose";
import { LipActivity, LIPS, mouthOpenRatio } from "@/features/proctoring/domain/lipActivity";
import { ABSENCE, AbsenceMonitor, classifyAbsence, frameStats } from "@/features/proctoring/domain/absence";
import { DARK_BUD, earPatches, isDarkEarbud } from "@/features/proctoring/domain/darkEarbud";

const rad = (d: number) => (d * Math.PI) / 180;

/** Column-major 4×4 for R = Ry(yaw) with translation z = -40. */
function yawMatrix(yawDeg: number, colMajor = true): number[] {
  const c = Math.cos(rad(yawDeg));
  const s = Math.sin(rad(yawDeg));
  const R = [
    [c, 0, s],
    [0, 1, 0],
    [-s, 0, c],
  ];
  const M = [
    [R[0][0], R[0][1], R[0][2], 0],
    [R[1][0], R[1][1], R[1][2], 0],
    [R[2][0], R[2][1], R[2][2], -40],
    [0, 0, 0, 1],
  ];
  const out: number[] = [];
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) out.push(colMajor ? M[b][a] : M[a][b]);
  return out;
}

describe("head pose", () => {
  it("reads yaw from either matrix layout", () => {
    expect(poseFromMatrix(yawMatrix(20))!.yaw).toBeCloseTo(20, 3);
    expect(poseFromMatrix(yawMatrix(-12, false))!.yaw).toBeCloseTo(-12, 3);
    expect(poseFromMatrix([1, 2, 3])).toBeNull();
  });

  it("flags eyes-down reading but not a screen-facing gaze", () => {
    const reading = blendshapeScores([
      { categoryName: "eyeLookDownLeft", score: 0.56 },
      { categoryName: "eyeLookDownRight", score: 0.56 },
      { categoryName: "eyeBlinkLeft", score: 0.38 },
      { categoryName: "eyeBlinkRight", score: 0.38 },
      { categoryName: "eyeSquintLeft", score: 0.4 },
      { categoryName: "eyeSquintRight", score: 0.4 },
    ]);
    const screen = blendshapeScores([
      { categoryName: "eyeLookDownLeft", score: 0.31 },
      { categoryName: "eyeLookDownRight", score: 0.31 },
      { categoryName: "eyeBlinkLeft", score: 0.04 },
      { categoryName: "eyeBlinkRight", score: 0.04 },
      { categoryName: "eyeSquintLeft", score: 0.17 },
      { categoryName: "eyeSquintRight", score: 0.17 },
    ]);
    expect(lookDownScore(reading, 8)).toBeGreaterThanOrEqual(LOOK_DOWN.MIN);
    expect(lookDownScore(screen, 0)).toBeLessThan(LOOK_DOWN.MIN);
  });
});

describe("lip activity", () => {
  const face = (gap: number) => {
    const lms = Array.from({ length: 20 }, (_, i) => ({ x: 0.5, y: 0.2 + (i / 19) * 0.4 }));
    lms[13] = { x: 0.5, y: 0.5 };
    lms[14] = { x: 0.5, y: 0.5 + gap * 0.4 };
    return lms;
  };

  it("measures the lip gap against face height", () => {
    expect(mouthOpenRatio(face(0.08))).toBeCloseTo(0.08, 3);
  });

  it("counts talking but not a single yawn", () => {
    const talk = new LipActivity();
    let cycles = 0;
    for (let t = 0; t < 2_400; t += 150) cycles = talk.update(Math.floor(t / 300) % 2 ? 0.08 : 0.005, t);
    expect(cycles).toBeGreaterThanOrEqual(LIPS.MIN_CYCLES);

    const yawn = new LipActivity();
    let y = 0;
    for (let t = 0; t < 3_000; t += 150) y = yawn.update(t > 600 && t < 2_000 ? 0.15 : 0.005, t);
    expect(y).toBeLessThan(LIPS.MIN_CYCLES);
  });
});

describe("face absence", () => {
  const fill = (n: number, rgb: [number, number, number]) => {
    const px = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) px.set([...rgb, 255], i * 4);
    return px;
  };

  it("tells a hand over the camera from an empty frame", () => {
    const hand = fill(768, [200, 150, 120]);
    for (let i = 0; i < 200; i++) hand.set([40, 40, 40, 255], i * 4);
    const room = fill(768, [200, 205, 200]);
    for (let i = 0; i < 300; i++) room.set([90, 80, 95, 255], i * 4);
    expect(classifyAbsence(frameStats(hand))).toBe("covered");
    expect(classifyAbsence(frameStats(room))).toBe("out_of_frame");
    expect(classifyAbsence(frameStats(fill(768, [5, 5, 5])))).toBe("covered");
  });

  it("keeps an episode open while the face flickers back", () => {
    const m = new AbsenceMonitor();
    const seq = [true, true, false, true, true, false, true, true, true];
    const out = seq.map((miss, i) => m.update(miss, i * 200));
    expect(out.filter((o) => o === "start")).toHaveLength(1);
    expect(out.indexOf("start")).toBeLessThan(seq.length);
  });

  it("re-arms only after the face is back for a full window", () => {
    const m = new AbsenceMonitor();
    let t = 0;
    for (let i = 0; i < 5; i++) m.update(true, (t += 200));
    for (let i = 0; i < ABSENCE.WINDOW; i++) expect(m.update(false, (t += 200))).toBeNull();
    const again = [0, 1, 2, 3].map(() => m.update(true, (t += 200)));
    expect(again).toContain("start");
  });
});

describe("dark earbud", () => {
  const S = DARK_BUD.SIZE;
  const crop = (paint: (x: number, y: number) => number) => {
    const px = new Uint8ClampedArray(S * S * 4);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const v = paint(x, y);
      px.set([v, v * 0.8, v * 0.7, 255], (y * S + x) * 4);
    }
    return px;
  };

  it("finds a compact dark blob inside the ear", () => {
    expect(isDarkEarbud(crop((x, y) => (Math.hypot(x - 11, y - 12) < 3.5 ? 30 : 190)))).toBe(true);
  });

  it("ignores a hair band along the crop edge and a plain cheek", () => {
    expect(isDarkEarbud(crop((x) => (x < 5 ? 30 : 190)))).toBe(false);
    expect(isDarkEarbud(crop(() => 180))).toBe(false);
  });

  it("only treats the ear on the turned side as visible", () => {
    const lms = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
    lms[1] = { x: 0.6, y: 0.5 };
    lms[234] = { x: 0.3, y: 0.5 };
    lms[454] = { x: 0.7, y: 0.5 };
    const [left, right] = earPatches(lms);
    expect(left!.visible).toBeGreaterThan(DARK_BUD.MIN_VISIBLE);
    expect(right!.visible).toBeLessThan(1);
  });
});
