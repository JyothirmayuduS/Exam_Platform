import { describe, expect, it } from "vitest";
import { severityFor } from "../../supabase/functions/mobile-monitor-session/severity";

describe("severityFor — monitor event severity", () => {
  it("minor under 5s", () => {
    expect(severityFor("FOCUS_LOST", 2_000)).toBe("minor");
    expect(severityFor("VISIBILITY_HIDDEN", 4_999)).toBe("minor");
  });

  it("moderate at 5–20s", () => {
    expect(severityFor("FOCUS_LOST", 5_000)).toBe("moderate");
    expect(severityFor("VISIBILITY_HIDDEN", 20_000)).toBe("moderate");
  });

  it("major over 20s", () => {
    expect(severityFor("FOCUS_LOST", 20_001)).toBe("major");
    expect(severityFor("VISIBILITY_HIDDEN", 60_000)).toBe("major");
  });

  it("disconnect-class events are major regardless of duration", () => {
    expect(severityFor("HEARTBEAT_MISSED")).toBe("major");
    expect(severityFor("CAMERA_STOPPED")).toBe("major");
    expect(severityFor("LIVEKIT_DISCONNECTED")).toBe("major");
  });

  it("repeats escalate minor → moderate → major", () => {
    expect(severityFor("FOCUS_LOST", undefined, 0)).toBe("minor");
    expect(severityFor("FOCUS_LOST", undefined, 2)).toBe("minor");
    expect(severityFor("FOCUS_LOST", undefined, 3)).toBe("moderate");
    expect(severityFor("FOCUS_LOST", undefined, 6)).toBe("major");
  });

  it("unknown event type defaults to minor", () => {
    expect(severityFor("SOMETHING_ELSE")).toBe("minor");
  });
});
