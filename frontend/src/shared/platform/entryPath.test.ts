import { describe, expect, it } from "vitest";
import { examPathFromDeepLink } from "@/shared/platform/lockdownBridge";

/**
 * Regression: Vercel's CLI writes VITE_EXAM_ENTRY_PATH="" into .env.local.
 * `import.meta.env.X ?? "/student/exam"` does NOT fall back on an empty string,
 * so the kiosk entry path became "" — a cold start was rewritten to the bare
 * origin (marketing landing page) and a deep link resolved to "?examId=…"
 * against the current route, i.e. /login?examId=… instead of the exam.
 *
 * Both helpers must now treat blank/relative values as unset.
 */

const LINK = "vignan-exam://open?exam=exam-1&roll=21VGN0314";

describe("exam entry path normalisation", () => {
  it("routes a deep link to the exam route with a valid entry path", () => {
    expect(examPathFromDeepLink(LINK, "/student/exam")).toBe("/student/exam?examId=exam-1&roll=21VGN0314");
  });

  it.each([
    ["empty string", ""],
    ["whitespace", "   "],
    ["relative path", "student/exam"],
  ])("never produces a relative target when the entry path is %s", (_label, entry) => {
    const target = examPathFromDeepLink(LINK, entry);
    expect(target).not.toBeNull();
    // Must be absolute: a relative target silently resolves against whatever
    // route is current, which is how login/landing pages got in the way.
    expect(target!.startsWith("/")).toBe(true);
    expect(target).toBe("/student/exam?examId=exam-1&roll=21VGN0314");
  });

  it("defaults to the exam route when no entry path is supplied", () => {
    expect(examPathFromDeepLink(LINK)).toBe("/student/exam?examId=exam-1&roll=21VGN0314");
  });

  it("still rejects non-exam and malformed links", () => {
    expect(examPathFromDeepLink("https://example.com/open?exam=exam-1")).toBeNull();
    expect(examPathFromDeepLink("vignan-exam://other?exam=exam-1")).toBeNull();
    expect(examPathFromDeepLink("vignan-exam://open")).toBeNull();
    expect(examPathFromDeepLink("not a url")).toBeNull();
  });
});
