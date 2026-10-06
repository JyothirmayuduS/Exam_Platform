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

  it("ignores state events from a connection it already replaced", async () => {
    const stop = vi.fn();
    type Opts = { onState: (s: string) => void };
    const calls: Opts[] = [];
    publish.mockImplementation(async (opts: unknown) => {
      calls.push(opts as Opts);
      return { room: null, stream: null, stop } as never;
    });
    const { rerender, findByText } = render(<ProctorCamera room="EXAM-1" identity="A" />);
    await waitFor(() => expect(calls.length).toBe(1));
    rerender(<ProctorCamera room="EXAM-1" identity="B" />);
    await waitFor(() => expect(calls.length).toBe(2));
    calls[1]!.onState("connected");
    await findByText("Proctor live");
    calls[0]!.onState("disconnected");
    await new Promise((r) => setTimeout(r, 20));
    await findByText("Proctor live");
    expect(calls.length).toBe(2);
  });

  it("shows why the video link failed", async () => {
    publish.mockImplementation(async () => { throw new Error("video token request failed: 401 unauthorized"); });
    const { findByText } = render(<ProctorCamera room="EXAM-1" identity="C" />);
    await findByText(/Video link failed: video token request failed: 401/);
  });
});
