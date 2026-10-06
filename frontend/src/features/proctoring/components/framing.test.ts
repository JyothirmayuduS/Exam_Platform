import { describe, expect, it } from "vitest";
import { classifyFraming } from "./ProctorAI";

const box = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x0, y: y1 }, { x: x1, y: y1 },
];

describe("classifyFraming", () => {
  it("accepts a centred face of normal size", () => {
    expect(classifyFraming(box(0.38, 0.3, 0.62, 0.62))).toBe("ok");
  });
  it("flags faces that are cut off, too far, too close or off-centre", () => {
    expect(classifyFraming(box(0.4, 0.0, 0.6, 0.3))).toBe("cut_off");
    expect(classifyFraming(box(0.46, 0.4, 0.54, 0.5))).toBe("too_far");
    expect(classifyFraming(box(0.15, 0.1, 0.85, 0.95))).toBe("too_close");
    expect(classifyFraming(box(0.05, 0.3, 0.3, 0.62))).toBe("off_left");
    expect(classifyFraming(box(0.38, 0.62, 0.62, 0.95))).toBe("too_low");
  });
});
