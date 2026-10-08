import { describe, expect, it } from "vitest";
import {
  RECOVER_AFTER_MS,
  cameraEncoding,
  classifyConnection,
  remoteConnectionState,
  screenEncoding,
  settleConnection,
  snapshotIntervalMs,
} from "@/shared/services/lowBandwidth";

describe("connection state", () => {
  const base = { online: true, savesFailing: false };

  it("is lost when offline or when answer saves keep failing", () => {
    expect(classifyConnection({ ...base, online: false })).toBe("lost");
    expect(classifyConnection({ ...base, savesFailing: true, videoQuality: "excellent" })).toBe("lost");
  });

  it("is weak on a poor video link or a slow network estimate", () => {
    expect(classifyConnection({ ...base, videoQuality: "poor" })).toBe("weak");
    expect(classifyConnection({ ...base, videoQuality: "lost" })).toBe("weak");
    expect(classifyConnection({ ...base, effectiveType: "3g" })).toBe("weak");
    expect(classifyConnection({ ...base, rttMs: 900 })).toBe("weak");
    expect(classifyConnection({ ...base, downlinkMbps: 0.4 })).toBe("weak");
    expect(classifyConnection({ ...base, saveData: true })).toBe("weak");
  });

  it("is good otherwise, including when live video is not connected", () => {
    expect(classifyConnection({ ...base, videoQuality: "good", effectiveType: "4g", rttMs: 80, downlinkMbps: 10 })).toBe("good");
    expect(classifyConnection({ ...base, videoQuality: "unknown" })).toBe("good");
  });

  it("gets worse at once but only returns to good after a steady period", () => {
    let s = settleConnection({ state: "good", goodSince: null }, "weak", 0);
    expect(s.state).toBe("weak");
    s = settleConnection(s, "good", 1_000);
    expect(s.state).toBe("weak");
    s = settleConnection(s, "good", 1_000 + RECOVER_AFTER_MS - 1);
    expect(s.state).toBe("weak");
    s = settleConnection(s, "good", 1_000 + RECOVER_AFTER_MS);
    expect(s.state).toBe("good");
    // A dip during recovery restarts the wait.
    s = settleConnection({ state: "weak", goodSince: 0 }, "lost", 5_000);
    expect(s).toEqual({ state: "lost", goodSince: null });
  });
});

describe("low-bandwidth caps", () => {
  it("caps the live camera and shrinks the frame on a weak link", () => {
    expect(cameraEncoding(false).maxBitrate).toBeLessThanOrEqual(500_000);
    expect(cameraEncoding(true)).toEqual({ maxBitrate: 150_000, maxFramerate: 10, scaleResolutionDownBy: 2 });
    expect(screenEncoding(true).maxBitrate).toBeLessThan(screenEncoding(false).maxBitrate);
  });

  it("never samples snapshots more often than every 15 s, nor less often than every 30 s", () => {
    for (const low of [false, true]) {
      expect(snapshotIntervalMs(low)).toBeGreaterThanOrEqual(15_000);
      expect(snapshotIntervalMs(low)).toBeLessThanOrEqual(30_000);
    }
  });
});

describe("proctor view of a student's connection", () => {
  const writing = { inRoom: true, writing: true, viewerConnected: true };
  it("maps the LiveKit quality", () => {
    expect(remoteConnectionState({ ...writing, quality: "excellent" })).toBe("good");
    expect(remoteConnectionState({ ...writing, quality: "poor" })).toBe("weak");
    expect(remoteConnectionState({ ...writing, quality: "lost" })).toBe("lost");
  });
  it("is lost when a writing student drops out of the room", () => {
    expect(remoteConnectionState({ ...writing, inRoom: false, quality: undefined })).toBe("lost");
    expect(remoteConnectionState({ ...writing, inRoom: false, writing: false, quality: undefined })).toBeNull();
  });
  it("shows nothing while the proctor's own video link is down", () => {
    expect(remoteConnectionState({ ...writing, viewerConnected: false, quality: "excellent" })).toBeNull();
  });
});
