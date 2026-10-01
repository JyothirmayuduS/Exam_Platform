import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useNavigate } from "react-router-dom";
import StudentExam from "./StudentExam";

const { launch, cancel } = vi.hoisted(() => ({ launch: vi.fn(), cancel: vi.fn() }));
vi.mock("../lib/lockdownBridge", () => ({ launchExamInLockdown: launch }));
vi.mock("../lib/platform", () => ({
  lockdownReady: () => false,
  isTauri: () => false,
  downloadUrl: () => "/downloads/test-installer.dmg",
  osLabel: () => "macOS",
  detectOS: () => "macos",
  probeInstaller: async () => "ready",
}));
// Keep this regression isolated to install/launch UI: no authentication,
// backend, proctoring models, capture, or exam submission runs here.
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: null, role: "student", loading: true }) }));
vi.mock("../hooks/useCurrentProfile", () => ({
  default: () => ({ profile: { roll: "R/1 A" }, loading: false }),
}));
vi.mock("../lib/env", () => ({ supabaseConfigured: false, env: {} }));
vi.mock("../lib/examApi", () => ({}));
vi.mock("../lib/examStorage", () => ({}));
vi.mock("../lib/serverProctor", () => ({}));
vi.mock("../hooks/useOfflineSync", () => ({ default: () => {} }));
vi.mock("../hooks/useProctoring", () => ({
  default: () => ({ violations: [], activeViolation: null, setActiveViolation: vi.fn(), flag: vi.fn(), handleAIViolation: vi.fn() }),
}));
vi.mock("../components/ProctorAI", () => ({ default: () => null }));
vi.mock("../components/ProctorCamera", () => ({ default: () => null }));
vi.mock("../components/InvigilatorVoice", () => ({ default: () => null }));

describe("student install confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    launch.mockReturnValue(cancel);
  });

  afterEach(cleanup);

  async function showGate() {
    const view = render(<MemoryRouter initialEntries={["/student/exam?examId=exam%26one"]}><StudentExam /></MemoryRouter>);
    const installed = await screen.findByRole("button", { name: /Done — I've installed it/i });
    return { ...view, installed };
  }

  it("starts the launch and launching state on the FIRST installed click", async () => {
    const { installed } = await showGate();
    fireEvent.click(installed);
    expect(launch).toHaveBeenCalledWith("exam&one", "R/1 A", expect.any(Function));
    expect(screen.getByText("Launching Vignan Exam Browser…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enter exam /" })).not.toBeInTheDocument();
  });

  it("retries with a fresh fallback and cancels the old launch tracking", async () => {
    const { installed } = await showGate();
    fireEvent.click(installed);
    act(() => launch.mock.calls[0][2]());
    fireEvent.click(screen.getByRole("button", { name: "Try again /" }));
    expect(launch).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(screen.getByText("Launching Vignan Exam Browser…")).toBeInTheDocument();
  });

  it("loads a fresh exam session when a warm link changes the exam reference", async () => {
    function WarmLink() {
      const navigate = useNavigate();
      return <button onClick={() => navigate("/student/exam?examId=second-exam")}>Simulate native link</button>;
    }
    render(<MemoryRouter initialEntries={["/student/exam?examId=first-exam"]}><StudentExam /><WarmLink /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /Done — I've installed it/i }));
    expect(screen.getByText("Launching Vignan Exam Browser…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Simulate native link" }));
    fireEvent.click(await screen.findByRole("button", { name: /Done — I've installed it/i }));
    expect(launch).toHaveBeenLastCalledWith("second-exam", "R/1 A", expect.any(Function));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cleans up pending launch tracking when going back or leaving the page", async () => {
    const { installed, unmount } = await showGate();
    fireEvent.click(installed);
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(await screen.findByText("Install Vignan Exam Browser")).toBeInTheDocument();
    unmount();
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
