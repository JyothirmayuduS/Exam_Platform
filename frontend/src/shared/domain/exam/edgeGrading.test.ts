import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs build script without type declarations
import { staleFiles } from "../../../../scripts/edgeGrading.mjs";

describe("submit-attempt grading copies", () => {
  it("match src/shared/domain/exam (run node scripts/edgeGrading.mjs)", () => {
    expect(staleFiles()).toEqual([]);
  });
});
