import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Login from "@/features/auth/pages/Login";

/**
 * The kiosk is a student-only surface: clicking "Enter exam" in the browser
 * hands the session to the desktop app, so the app itself must never park the
 * student on the role-switching Authenticate page.
 */

const state = { kiosk: false, user: null as unknown, loading: true };

vi.mock("@/shared/platform/platform", () => ({ isTauri: () => state.kiosk }));
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
vi.mock("@/shared/data/supabase", () => ({ getSupabase: () => null }));
vi.mock("@/shared/data/env", () => ({ supabaseConfigured: false, env: {} }));

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login?kiosk=1"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/student/exams" element={<div>MY EXAMS LIST</div>} />
        <Route path="/student" element={<div>OVERVIEW</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("kiosk login (student-only)", () => {
  beforeEach(() => {
    state.kiosk = false;
    state.user = null;
    state.loading = true;
  });

  afterEach(cleanup);

  it("kiosk with a persisted session redirects to My exams — no role tabs, no form", async () => {
    state.kiosk = true;
    state.user = { id: "auth-user-1" };
    state.loading = false;
    renderLogin();
    // Redirect target proves the student skipped the Authenticate page.
    expect(await screen.findByText("MY EXAMS LIST")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Teacher" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Proctor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Student" })).not.toBeInTheDocument();
  });

  it("kiosk still resolving the session shows a splash, not the login form", () => {
    state.kiosk = true;
    state.loading = true;
    renderLogin();
    expect(screen.getByText("Opening Vignan Exam Browser…")).toBeInTheDocument();
    expect(screen.queryByText("Authenticate")).not.toBeInTheDocument();
  });

  it("signed-out kiosk shows a student-only form — no role switcher", () => {
    state.kiosk = true;
    state.loading = false;
    renderLogin();
    expect(screen.getByText("Registration Number")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Teacher" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Proctor" })).not.toBeInTheDocument();
  });

  it("regular browser keeps the role tabs (student/teacher/proctor)", () => {
    state.kiosk = false;
    state.loading = false;
    renderLogin();
    expect(screen.getByRole("button", { name: "Teacher" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Proctor" })).toBeInTheDocument();
  });
});
