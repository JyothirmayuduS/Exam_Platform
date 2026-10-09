import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const status = vi.fn();
vi.mock("@/shared/data/api/registrationPhoto", () => ({
  loadPhotoStatus: () => status(),
  uploadRegistrationPhoto: vi.fn(),
}));
let userId = "user-1";
vi.mock("@/features/auth/auth", () => ({ useAuth: () => ({ user: { id: userId } }) }));

import RegistrationPhotoGate, { PHOTO_STATUS_TIMEOUT_MS } from "./RegistrationPhotoGate";

const gate = () => render(<RegistrationPhotoGate><p>My exams</p></RegistrationPhotoGate>);

describe("RegistrationPhotoGate", () => {
  beforeEach(() => {
    status.mockReset();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(() => new Promise(() => undefined)) } });
  });

  it("asks a student without a photo to take one before their exams", async () => {
    userId = "no-photo";
    status.mockResolvedValue({ ok: true, data: { required: true, hasPhoto: false, capturedAt: null } });
    gate();
    expect(await screen.findByText("Take your registration photo")).toBeTruthy();
    expect(screen.queryByText("My exams")).toBeNull();
  });

  it("lets a student with a photo straight through", async () => {
    userId = "has-photo";
    status.mockResolvedValue({ ok: true, data: { required: true, hasPhoto: true, capturedAt: "2026-10-01T00:00:00Z" } });
    gate();
    expect(await screen.findByText("My exams")).toBeTruthy();
  });

  it("never blocks an exam when the server can't be reached", async () => {
    userId = "offline";
    status.mockResolvedValue({ ok: false, error: "Could not reach the server." });
    gate();
    expect(await screen.findByText("My exams")).toBeTruthy();
  });

  it("lets the student on when the status check takes too long, and ignores the late answer", async () => {
    vi.useFakeTimers();
    try {
      userId = "slow";
      let answer: (v: unknown) => void = () => undefined;
      status.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
      gate();
      expect(screen.getByText("Loading…")).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(PHOTO_STATUS_TIMEOUT_MS - 100); });
      expect(screen.queryByText("My exams")).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(screen.getByText("My exams")).toBeTruthy();
      await act(async () => { answer({ ok: true, data: { required: true, hasPhoto: false, capturedAt: null } }); });
      expect(screen.getByText("My exams")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the student on when the status check throws", async () => {
    userId = "throws";
    status.mockRejectedValue(new Error("network"));
    gate();
    expect(await screen.findByText("My exams")).toBeTruthy();
  });
});
