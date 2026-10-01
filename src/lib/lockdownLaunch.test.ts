import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { examPathFromDeepLink, launchExamInLockdown } from "./lockdownBridge";

describe("exam launch routes", () => {
  it("round-trips encoded exam and roll without adding authentication tokens", () => {
    expect(examPathFromDeepLink("vignan-exam://open?exam=exam%26one&roll=R%2F1%20A"))
      .toBe("/student/exam?examId=exam%26one&roll=R%2F1%20A");
    expect(examPathFromDeepLink("vignan-exam://open?exam=one"))
      .toBe("/student/exam?examId=one");
  });

  it("honors the configured entry route", () => {
    expect(examPathFromDeepLink("vignan-exam://open?exam=one", "/candidate/exam"))
      .toBe("/candidate/exam?examId=one");
  });

  it.each([
    "not a URL",
    "https://open?exam=one",
    "vignan-exam://other?exam=one",
    "vignan-exam://open",
    "vignan-exam://open?exam=%20",
  ])("ignores an invalid launch URL: %s", (url) => {
    expect(examPathFromDeepLink(url)).toBeNull();
  });
});

describe("browser OS launch request", () => {
  let assign: ReturnType<typeof vi.fn>;
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    assign = vi.fn();
    // jsdom's Location is read-only; stub only the browser surface the helper
    // uses. No external protocol or real native kiosk is opened by these tests.
    vi.stubGlobal("window", {
      location: { assign },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("launches synchronously with encoded parameters and offers a fallback", () => {
    const fallback = vi.fn();
    dispose = launchExamInLockdown("exam&one", "R/1 A", fallback);
    expect(assign).toHaveBeenCalledWith("vignan-exam://open?exam=exam%26one&roll=R%2F1%20A");
    expect(fallback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("does not mark the launch failed after the page becomes hidden", () => {
    const fallback = vi.fn();
    dispose = launchExamInLockdown("exam-one", "", fallback);
    expect(assign).toHaveBeenCalledWith("vignan-exam://open?exam=exam-one");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.advanceTimersByTime(3000);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("cleans up a pending fallback on back, retry or unmount", () => {
    const fallback = vi.fn();
    dispose = launchExamInLockdown("exam-one", "", fallback);
    dispose();
    vi.advanceTimersByTime(3000);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("offers the fallback when navigation is blocked synchronously", () => {
    assign.mockImplementation(() => { throw new Error("blocked protocol"); });
    const fallback = vi.fn();
    dispose = launchExamInLockdown("exam-one", "", fallback);
    expect(fallback).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(3000);
    expect(fallback).toHaveBeenCalledOnce();
  });
});
