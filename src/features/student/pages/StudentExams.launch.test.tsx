import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import StudentExams from "@/features/student/pages/StudentExams";

const { launch, cancel } = vi.hoisted(() => ({ launch: vi.fn(), cancel: vi.fn() }));
vi.mock("@/shared/platform/lockdownBridge", () => ({ launchExamInLockdown: launch }));
vi.mock("@/shared/platform/platform", () => ({
  isTauri: () => false,
  detectOS: () => "macos",
  downloadUrl: () => "/downloads/test-installer.dmg",
  osLabel: () => "macOS",
  lockdownReady: () => false,
}));
vi.mock("@/features/auth/auth", () => ({
  useAuth: () => ({
    user: { id: "auth-user-1" },
    session: { access_token: "at-token", refresh_token: "rt-token" },
    role: "student",
    loading: false,
    signOut: async () => {},
  }),
}));
vi.mock("@/features/auth/hooks/useCurrentProfile", () => ({
  default: () => ({ profile: { roll: "21VGN0314", full_name: "S Manasa" }, loading: false }),
  profileSubtitle: () => "",
}));
vi.mock("@/shared/components/RoleLayout", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Minimal Supabase stand-in: StudentExams only needs auth.getUser and two
// chainable table reads (students row lookup resolves to nothing).
vi.mock("@/shared/data/supabase", () => {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: null }),
  };
  const db = {
    auth: { getUser: async () => ({ data: { user: { id: "auth-user-1" } } }) },
    from: () => builder,
  };
  return { getSupabase: () => db };
});
vi.mock("@/shared/data/env", () => ({ supabaseConfigured: true, env: {} }));
vi.mock("@/shared/data/examApi", () => ({
  listEnrolledExamsForAuthUser: async () => [
    { id: "exam-1", name: "DBMS Exam", batch: "CSE", duration_minutes: 60, total_marks: 100, status: "published", scheduled_at: null },
  ],
  subscribeToStudentExams: () => () => {},
}));

describe("browser Enter exam launch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    launch.mockReturnValue(cancel);
  });

  afterEach(cleanup);

  async function showMyExams() {
    const view = render(<MemoryRouter initialEntries={["/student/exams"]}><StudentExams /></MemoryRouter>);
    return { ...view, enter: await screen.findByRole("button", { name: "Enter exam /" }) };
  }

  it("launches the kiosk synchronously WITH the signed-in session handoff", async () => {
    const { enter } = await showMyExams();
    fireEvent.click(enter);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(
      "exam-1",
      "21VGN0314",
      expect.any(Function),
      { access_token: "at-token", refresh_token: "rt-token" },
    );
  });

  it("unconfirmed launch shows a fallback that never links into /student/exam", async () => {
    const { enter } = await showMyExams();
    fireEvent.click(enter);
    // The OS never picked up the deep link — onUnconfirmed fires.
    act(() => launch.mock.calls[0][2]());
    expect(screen.getByText("Vignan Exam Browser didn't open")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again /" })).toBeInTheDocument();
    // Regression guard: the old modal linked to /student/exam?examId=… in a
    // normal browser, which bounced through ProtectedRoute into the login page.
    expect(screen.queryByText("Install Lockdown Browser /")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Install Lockdown Browser/i })).not.toBeInTheDocument();
    // Offered actions: retry the launch and download the right installer.
    expect(screen.getByRole("link", { name: /Download installer \(macOS\)/i })).toHaveAttribute(
      "href",
      "/downloads/test-installer.dmg",
    );
  });

  it("Try again relaunches with the same exam and session handoff", async () => {
    const { enter } = await showMyExams();
    fireEvent.click(enter);
    act(() => launch.mock.calls[0][2]());
    fireEvent.click(screen.getByRole("button", { name: "Try again /" }));
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch).toHaveBeenLastCalledWith(
      "exam-1",
      "21VGN0314",
      expect.any(Function),
      { access_token: "at-token", refresh_token: "rt-token" },
    );
    expect(screen.queryByText("Vignan Exam Browser didn't open")).not.toBeInTheDocument();
  });

  it("Cancel dismisses the fallback without relaunching", async () => {
    const { enter } = await showMyExams();
    fireEvent.click(enter);
    act(() => launch.mock.calls[0][2]());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Vignan Exam Browser didn't open")).not.toBeInTheDocument();
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
