import { describe, expect, it } from "vitest";
import { faceGeometryFromLandmarks, refineDetections } from "@/features/proctoring/domain/refine";
import type { Detection } from "@/features/proctoring/domain/types";

function landmarks() {
  const lms = Array.from({ length: 468 }, () => ({ x: 0.5, y: 0.4 }));
  lms[0] = { x: 0.35, y: 0.15 };
  lms[1] = { x: 0.65, y: 0.65 };
  lms[234] = { x: 0.35, y: 0.38 };
  lms[454] = { x: 0.65, y: 0.38 };
  return lms;
}

const det = (kind: Detection["kind"], x: number, y: number, w: number, h: number): Detection =>
  ({ kind, label: kind === "phone" ? "cell phone" : kind, score: 0.3, bbox: { x, y, width: w, height: h } });

describe("refineDetections", () => {
  const face = faceGeometryFromLandmarks(landmarks(), 1000)!;

  it("turns a small phone box beside the ear into earbuds", () => {
    const out = refineDetections([det("phone", 0.66, 0.38, 0.06, 0.06)], face, 1100);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("earbuds");
  });

  it("drops a small phone box on the chin (finger artefact)", () => {
    expect(refineDetections([det("phone", 0.48, 0.5, 0.06, 0.06)], face, 1100)).toHaveLength(0);
  });

  it("keeps a large phone held in front of the face", () => {
    const out = refineDetections([det("phone", 0.3, 0.3, 0.35, 0.3)], face, 1100);
    expect(out[0].kind).toBe("phone");
  });

  it("relabels a laptop touching the bottom edge as a phone held low", () => {
    const out = refineDetections([det("laptop", 0.3, 0.8, 0.4, 0.2)], null, 1100);
    expect(out[0].kind).toBe("phone");
  });

  it("ignores stale face geometry", () => {
    const out = refineDetections([det("phone", 0.66, 0.38, 0.06, 0.06)], face, 5000);
    expect(out[0].kind).toBe("phone");
  });
});
