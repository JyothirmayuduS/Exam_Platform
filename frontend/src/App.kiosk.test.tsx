import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import App from "@/App";

/**
 * A candidate on the lockdown browser sees exactly one surface: the exam flow.
 * The marketing root, the staff consoles and the 404 are unreachable there —
 * this is the structural guard for the "click Enter exam and land on the role
 * picker again" regression.
 */

const state = { kiosk: false, user: null as unknown };
const navigateTo = vi.fn();

vi.mock("@/shared/platform/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/platform/platform")>();
  return { ...actual, isTauri: () => state.kiosk, lockdownReady: () => state.kiosk };
});
vi.mock("@/features/auth/auth", () => ({
  useAuth: () => ({
    user: state.user,
    session: state.user ? { access_token: "at", refresh_token: "rt" } : null,
    role: state.user ? "student" : null,
    loading: false,
    signOut: async () => {},
    signInDemo: undefined,
  }),
}));
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => navigateTo,
  };
});

// Replace every page with a marker so assertions are about WHICH surface the
// router picked, not about that page's internals.
vi.mock("@/shared/pages/Landing", () => ({ default: () => <div>LANDING PAGE</div> }));
vi.mock("@/shared/pages/ErrorPage", () => ({ default: () => <div>ERROR PAGE</div> }));
vi.mock("@/features/auth/pages/Login", () => ({ default: () => <div>LOGIN PAGE</div> }));
vi.mock("@/features/auth/pages/ForgotPassword", () => ({ default: () => <div>FORGOT PAGE</div> }));
vi.mock("@/features/auth/pages/PasswordRecover", () => ({ default: () => <div>RECOVER PAGE</div> }));
vi.mock("@/features/auth/components/ProtectedRoute", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/features/student/components/RegistrationPhotoGate", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/features/student/pages/StudentExams", () => ({ default: () => <div>STUDENT EXAMS PAGE</div> }));
vi.mock("@/features/student/pages/StudentHome", () => ({ default: () => <div>STUDENT HOME PAGE</div> }));
vi.mock("@/features/student/pages/StudentExam", () => ({ default: () => <div>STUDENT EXAM PAGE</div> }));
vi.mock("@/features/student/pages/StudentExamDetail", () => ({ default: () => <div>EXAM DETAIL PAGE</div> }));
vi.mock("@/features/student/pages/PracticeModeExam", () => ({ default: () => <div>PRACTICE PAGE</div> }));
vi.mock("@/features/student/pages/StudentResults", () => ({ default: () => <div>RESULTS PAGE</div> }));
vi.mock("@/features/student/pages/StudentResultDetail", () => ({ default: () => <div>RESULT DETAIL PAGE</div> }));
vi.mock("@/features/student/pages/StudentHelp", () => ({ default: () => <div>HELP PAGE</div> }));
vi.mock("@/features/teacher/pages/TeacherDashboard", () => ({ default: () => <div>TEACHER PAGE</div> }));
vi.mock("@/features/teacher/pages/TeacherProctoring", () => ({ default: () => <div>TEACHER PROCTORING PAGE</div> }));
vi.mock("@/features/proctoring/pages/ProctorGrid", () => ({ default: () => <div>PROCTOR PAGE</div> }));
vi.mock("@/features/mobile/pages/MobileUpload", () => ({ default: () => <div>MOBILE UPLOAD PAGE</div> }));
vi.mock("@/features/mobile/pages/MobileMonitor", () => ({ default: () => <div>MOBILE MONITOR PAGE</div> }));
vi.mock("@/shared/components/SystemCheckPage", () => ({ default: () => <div>STANDALONE SYSTEM CHECK PAGE</div> }));
vi.mock("@/shared/components/OfflineIndicator", () => ({ default: () => null }));
vi.mock("@/shared/components/LockdownNotice", () => ({ default: () => null }));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
      {/* Catch the redirect target so a kiosk-only redirect can be observed
          without mounting the real destination pages. */}
      <Routes>
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("kiosk routing surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.kiosk = true;
    state.user = { id: "auth-user-1" };
  });

  afterEach(cleanup);

  it("signed-in kiosk at / goes to My exams, never the landing page", () => {
    renderAt("/");
    expect(screen.queryByText("LANDING PAGE")).not.toBeInTheDocument();
    expect(screen.getByText("STUDENT EXAMS PAGE")).toBeInTheDocument();
  });

  it.each([
    ["/teacher", "TEACHER PAGE"],
    ["/teacher/proctoring", "TEACHER PROCTORING PAGE"],
    ["/proctor", "PROCTOR PAGE"],
    ["/proctor/recordings", "PROCTOR PAGE"],
  ])("kiosk never renders the staff console at %s", (path, marker) => {
    renderAt(path);
    expect(screen.queryByText(marker)).not.toBeInTheDocument();
    expect(screen.getByText("STUDENT EXAMS PAGE")).toBeInTheDocument();
  });

  it.each(["/forgot", "/recover", "/nope", "/student/exams/abc/nonsense"])(
    "kiosk never renders a non-exam page at %s",
    (path) => {
      renderAt(path);
      expect(screen.queryByText("ERROR PAGE")).not.toBeInTheDocument();
      expect(screen.queryByText("FORGOT PAGE")).not.toBeInTheDocument();
      expect(screen.queryByText("RECOVER PAGE")).not.toBeInTheDocument();
      expect(screen.getByText("STUDENT EXAMS PAGE")).toBeInTheDocument();
    },
  );

  it("normal browser keeps every page: landing, teacher and 404 all reachable", () => {
    state.kiosk = false;
    renderAt("/");
    expect(screen.getByText("LANDING PAGE")).toBeInTheDocument();
    cleanup();
    renderAt("/teacher");
    expect(screen.getByText("TEACHER PAGE")).toBeInTheDocument();
    cleanup();
    renderAt("/definitely-missing");
    expect(screen.getByText("ERROR PAGE")).toBeInTheDocument();
  });
});
