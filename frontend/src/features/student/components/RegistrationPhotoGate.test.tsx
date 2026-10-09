import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const status = vi.fn();
vi.mock("@/shared/data/api/registrationPhoto", () => ({
  loadPhotoStatus: () => status(),
  uploadRegistrationPhoto: vi.fn(),
}));
let userId = "user-1";
vi.mock("@/features/auth/auth", () => ({ useAuth: () => ({ user: { id: userId } }) }));

import RegistrationPhotoGate from "./RegistrationPhotoGate";

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
});
