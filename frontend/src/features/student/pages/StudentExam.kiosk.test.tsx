import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import StudentExam from "@/features/student/pages/StudentExam";
import ProtectedRoute from "@/features/auth/components/ProtectedRoute";

/**
 * THE regression this covers: "click Enter exam and land on a login / role page
 * again". A vignan-exam:// deep link must render the exam's FIRST system check
 * directly — no install gate, no credential form, no role switcher — whether or
 * not the webview has finished restoring the session.
 */

const state = { user: null as unknown, loading: false };

vi.mock("@/shared/platform/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/platform/platform")>();
  // lockdownReady() true = we ARE the packaged kiosk app.
  return { ...actual, isTauri: () => true, lockdownReady: () => true };
});
vi.mock("@/shared/platform/lockdownBridge", () => ({
  launchExamInLockdown: vi.fn(() => () => {}),
  enterLockdown: vi.fn(async () => {}),
  leaveLockdown: vi.fn(async () => {}),
  LAUNCHED_FROM_LINK_KEY: "vignan.launchedFromLink",
  openStudentSide: vi.fn(async () => true),
  mediaPermissionStatus: vi.fn(async () => "granted"),
  openMediaSettings: vi.fn(async () => true),
  isScreenCaptureExcluded: vi.fn(async () => true),
  onLockdownNotice: vi.fn(async () => () => {}),
}));
vi.mock("@/features/auth/auth", () => ({
  useAuth: () => ({
    user: state.user,
    session: state.user ? { access_token: "at", refresh_token: "rt" } : null,
    role: state.user ? "student" : null,
    loading: state.loading,
    signOut: async () => {},
    signInDemo: undefined,
  }),
}));
vi.mock("@/features/auth/hooks/useCurrentProfile", () => ({
  default: () => ({ profile: { roll: "21VGN0314", full_name: "S Manasa" }, loading: false }),
  profileSubtitle: () => "",
}));
// No backend in this test: the paper never loads, but the pre-flight check is
// rendered before any DB work and is the surface under test.
vi.mock("@/shared/data/env", () => ({ supabaseConfigured: false, env: {} }));
vi.mock("@/shared/data/examApi", () => ({}));
vi.mock("@/shared/services/examStorage", () => ({}));
vi.mock("@/features/proctoring/services/serverProctor", () => ({}));
vi.mock("@/features/student/hooks/useOfflineSync", () => ({ default: () => {} }));
vi.mock("@/features/proctoring/hooks/useProctoring", () => ({
  default: () => ({ violations: [], activeViolation: null, setActiveViolation: vi.fn(), flag: vi.fn(), handleAIViolation: vi.fn() }),
}));
vi.mock("@/features/proctoring/components/ProctorAI", () => ({ default: () => null }));
vi.mock("@/features/proctoring/components/ProctorCamera", () => ({ default: () => null }));
vi.mock("@/features/proctoring/components/InvigilatorVoice", () => ({ default: () => null }));
vi.mock("@/features/auth/pages/Login", () => ({ default: () => <div>LOGIN PAGE</div> }));

const DEEP_LINK_PATH = "/student/exam?examId=exam-1&roll=21VGN0314";

describe("kiosk deep-link entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.user = { id: "auth-user-1" };
    state.loading = false;
  });

  afterEach(cleanup);

  /** Route exactly as the app does: /student/exam behind ProtectedRoute. */
  function renderDeepLink() {
    return render(
      <MemoryRouter initialEntries={[DEEP_LINK_PATH]}>
        <ProtectedRoute allowedRole="student">
          <StudentExam />
        </ProtectedRoute>
      </MemoryRouter>,
    );
  }

  it("signed in: opens straight on the system readiness check", async () => {
    renderDeepLink();
    expect(await screen.findByText("System readiness check")).toBeInTheDocument();
    expect(screen.queryByText("LOGIN PAGE")).not.toBeInTheDocument();
    // The browser install gate and the transient "Enter exam" step are kiosk-only.
    expect(screen.queryByText("Install Vignan Exam Browser")).not.toBeInTheDocument();
    expect(screen.queryByText("Vignan Exam Browser installed!")).not.toBeInTheDocument();
  });

  it("signed out (session still hydrating): still the check, never the login page", async () => {
    // ProtectedRoute's nativeExamLaunch bypass must hold while the webview
    // restores the session — otherwise the candidate sees a credential form.
    state.user = null;
    state.loading = true;
    renderDeepLink();
    expect(await screen.findByText("System readiness check")).toBeInTheDocument();
    expect(screen.queryByText("LOGIN PAGE")).not.toBeInTheDocument();
  });
});
