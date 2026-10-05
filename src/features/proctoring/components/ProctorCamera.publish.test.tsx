import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { publish } = vi.hoisted(() => ({ publish: vi.fn(async (_opts: unknown) => null) }));
vi.mock("@/features/proctoring/services/proctor", () => ({ startProctorPublishing: publish }));
vi.mock("@/features/proctoring/services/recorder", () => ({ startVideoRecording: vi.fn() }));

import ProctorCamera from "./ProctorCamera";

describe("ProctorCamera", () => {
  it("starts LiveKit publishing on mount", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => { throw new Error("no camera"); }) },
    });
    render(<ProctorCamera room="EXAM-1" identity="21VGN0314" />);
    await waitFor(() => expect(publish).toHaveBeenCalled());
    expect(publish.mock.calls[0][0]).toMatchObject({ room: "EXAM-1", identity: "21VGN0314" });
  });
});
