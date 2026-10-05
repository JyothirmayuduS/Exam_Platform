import { beforeEach, describe, expect, it } from "vitest";
import { markUploadHandled, shouldApplyUpload, uploadAnswer } from "@/features/student/services/uploadedAnswers";

describe("shouldApplyUpload", () => {
  beforeEach(() => localStorage.clear());

  it("applies a new upload to a blank answer", () => {
    expect(shouldApplyUpload("a1", "x/q1.pdf", undefined)).toBe(true);
    expect(shouldApplyUpload("a1", "x/q1.pdf", "  ")).toBe(true);
  });

  it("re-applies a handled upload the exam state lost", () => {
    markUploadHandled("a1", "x/q1.pdf");
    expect(shouldApplyUpload("a1", "x/q1.pdf", undefined)).toBe(true);
  });

  it("skips when the answer already shows the file", () => {
    expect(shouldApplyUpload("a1", "x/q1.pdf", uploadAnswer("x/q1.pdf"))).toBe(false);
  });

  it("keeps a typed answer the student wrote after the upload", () => {
    markUploadHandled("a1", "x/q1.pdf");
    expect(shouldApplyUpload("a1", "x/q1.pdf", "my typed answer")).toBe(false);
    expect(shouldApplyUpload("a1", "x/q2.pdf", "my typed answer")).toBe(true);
  });
});
