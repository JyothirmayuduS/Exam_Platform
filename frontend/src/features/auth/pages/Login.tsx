import { useState, useEffect } from "react";
import { useNavigate, useSearchParams, useLocation, Link } from "react-router-dom";
import { getSupabase } from "@/shared/data/supabase";
import { supabaseConfigured } from "@/shared/data/env";
import { isStaffAdmin, useAuth } from "@/features/auth/auth";
import { isTauri } from "@/shared/platform/platform";
import { invoke } from "@tauri-apps/api/core";

type LoginMode = "student" | "teacher" | "proctor";

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  // The desktop app has its own login session. Keep the exam reference from
  // ProtectedRoute across sign-in rather than sending a cold launch home.
  const from = location.state?.from;
  const hasExamReturn = from?.pathname === "/student/exam";
  const studentDestination = hasExamReturn
    ? `/student/exam${typeof from.search === "string" && from.search.startsWith("?") ? from.search : ""}`
    : "/student";
  // In the kiosk a plain sign-in lands on "My exams" — the student's next
  // click is always "Enter exam", so skip the overview console entirely.
  const { signInDemo, user, loading: authLoading } = useAuth();
  const [searchParams] = useSearchParams();
  const queryRole = searchParams.get("role") as LoginMode | null;
  // Inside the Vignan Exam Browser the student signs in once per computer —
  // the session is stored by the kiosk webview and restored on every launch.
  const inKiosk = isTauri();

  // The kiosk is student-only and must never show a signed-in user this page.
  // A deep-link launch restores the session in main.tsx and routes straight to
  // the exam; this covers a cold kiosk start with a persisted session — it
  // goes straight to the student side instead of flashing the login form.
  // The pathname guard keeps a late redirect from fighting an arriving
  // vignan-exam:// deep link that has already changed the route.
  const [mode, setMode] = useState<LoginMode>("student");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The kiosk's identity comes from the exam deep link (or a persisted
  // session). The sign-in form is a hidden fallback behind the waiting screen.
  const [manualSignIn, setManualSignIn] = useState(false);

  useEffect(() => {
    if (queryRole && ["student", "teacher", "proctor"].includes(queryRole)) {
      setMode(queryRole);
    }
  }, [queryRole]);

  // The kiosk is student-only and must never show a signed-in user this page.
  // A deep-link launch restores the session in main.tsx and routes straight to
  // the exam; this covers a cold kiosk start with a persisted session — it
  // goes straight to the student side instead of flashing the login form.
  // The pathname guard keeps a late redirect from fighting an arriving
  // vignan-exam:// deep link that has already changed the route.
  useEffect(() => {
    if (!inKiosk || authLoading || !user) return;
    if (!location.pathname.startsWith("/login")) return;
    navigate(inKiosk && !hasExamReturn ? "/student/exams" : studentDestination, { replace: true });
  }, [inKiosk, authLoading, user, navigate, studentDestination, hasExamReturn, location.pathname]);

  // While the kiosk resolves the persisted session there is nothing to show —
  // render a brief native-style splash instead of the login form, so the
  // Authenticate page never flashes before the redirect above. (Placed after
  // every hook so the splash → form transition keeps hook order stable.)
  if (inKiosk && (authLoading || user)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-none border-4 border-ink border-t-transparent" />
          <p className="mt-4 font-mono text-[11px] uppercase tracking-widest text-ink-soft">Opening Vignan Exam Browser…</p>
        </div>
      </div>
    );
  }

  // Kiosk cold start with no session and no exam handoff yet: NEVER show a
  // credential form. The student's identity arrives with the exam launch —
  // clicking "Enter exam" on the web dashboard fires a vignan-exam:// link
  // that this window picks up automatically (applyDeeplink swaps the route
  // the moment it lands). Manual sign-in stays reachable as a fallback.
  if (inKiosk && !manualSignIn) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6">
        <div className="w-full max-w-md text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center border-2 border-ink font-serif text-2xl font-bold text-ink">V</div>
          <h1 className="mt-6 font-serif text-2xl font-semibold text-ink">Waiting for your exam…</h1>
          <p className="mt-3 text-[13.5px] leading-relaxed text-ink-soft">
            Open this exam from your student dashboard in the web browser and click
            <span className="font-medium text-ink"> Enter exam</span> — this window
            opens it automatically, already signed in.
          </p>
          <p className="mt-3 font-mono text-[10px] uppercase tracking-widest text-ink-soft">
            Keep this window open · it will continue on its own
          </p>
          <button
            type="button"
            onClick={() => setManualSignIn(true)}
            className="mt-8 font-mono text-[10px] uppercase tracking-wider text-ink-soft underline hover:text-ink"
          >
            Sign in on this computer instead
          </button>
          <div className="mt-10">
            <button
              type="button"
              onClick={() => void invoke("exit_app")}
              className="border border-line px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-forest"
            >
              Exit Vignan Exam Browser
            </button>
          </div>
        </div>
      </div>
    );
  }

  const handleModeChange = (newMode: LoginMode) => {
    setMode(newMode);
    setIdentifier("");
    setPassword("");
    setError(null);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const db = getSupabase();
    if (!db) {
      setError("Database connection error");
      setLoading(false);
      return;
    }

    let email = identifier.trim().toLowerCase();
    if (mode === "student") {
      // Students enter registration number (e.g., 21BQ1A0501)
      if (!email.includes("@")) {
        email = `${email}@student.vignan.ac.in`;
      }
    }

    if (!password) {
      setError("Password is required.");
      setLoading(false);
      return;
    }

    const { data, error: signInError } = await db.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      setError("Invalid credentials. Please verify and try again.");
      setLoading(false);
      return;
    }

    if (!data.user) {
      setError("An unexpected error occurred during sign in.");
      setLoading(false);
      return;
    }

    // The kiosk is a student-only surface: after sign-in it always continues
    // to the exam/deep-link return path (or "My exams" for a cold start) —
    // never to a teacher/proctor console or a role switcher.
    if (inKiosk) {
      navigate(hasExamReturn ? studentDestination : "/student/exams", { replace: true });
      return;
    }

    // Check teacher/proctor role
    const { data: teacherData } = await db
      .from("teachers")
      .select("role")
      .eq("auth_id", data.user.id)
      .maybeSingle();

    if (teacherData) {
      if (teacherData.role === "proctor" || mode === "proctor") {
        navigate("/proctor");
      } else if (from?.pathname === "/lti/launch") {
        // Back to the Moodle teacher page to finish linking the Moodle course.
        navigate(`/lti/launch${typeof from.search === "string" && from.search.startsWith("?") ? from.search : ""}`, { replace: true });
      } else {
        navigate((await isStaffAdmin()) ? "/admin" : "/teacher");
      }
    } else {
      navigate(studentDestination, { replace: true });
    }
  };

  return (
    <div className="flex min-h-screen bg-paper">
      {/* Left side: Branding */}
      <div className="hidden w-1/3 flex-col justify-between border-r border-line bg-paper-raised p-8 lg:flex">
        <div>
          <div className="flex h-12 w-12 items-center justify-center border-2 border-ink font-serif text-xl font-bold text-ink">
            V
          </div>
          <h1 className="mt-8 font-serif text-3xl font-semibold leading-tight text-ink">
            Vignan Lockdown OS
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-ink-soft">
            Secure Examination Platform for the Center of Distance Education. 
            Authenticate to access your designated console.
          </p>
        </div>
        <div className="flex items-center justify-between font-mono text-xs uppercase tracking-wider text-ink-soft">
          <span>Semester Exams · 2026</span>
          <Link to="/" className="hover:text-ink hover:underline">← Overview</Link>
        </div>
      </div>

      {/* Right side: Login Form */}
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-sm">
          {/* Mobile logo & back */}
          <div className="mb-6 flex items-center justify-between lg:hidden">
            <div className="flex h-10 w-10 items-center justify-center border-2 border-ink font-serif text-lg font-bold text-ink">
              V
            </div>
            <Link to="/" className="font-mono text-xs uppercase tracking-wider text-ink-soft hover:text-ink">
              ← Overview
            </Link>
          </div>

          <h2 className="font-serif text-3xl font-semibold text-ink">Authenticate</h2>
          <p className="mt-2 text-sm text-ink-soft">
            {inKiosk
              ? "Sign in once with your registration number — your exam opens straight into the system check."
              : "Select your role and sign in to your console."}
          </p>

          {/* 3 Role Tabs — the kiosk is student-only, so it never shows a
              role switcher (teachers/proctors use their own machines). */}
          {!inKiosk && (
          <div className="mt-6 flex rounded-sm border border-line bg-paper-raised p-1">
            <button
              type="button"
              onClick={() => handleModeChange("student")}
              className={`flex-1 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
                mode === "student" ? "bg-paper text-maroon shadow-sm" : "text-ink-soft hover:text-ink"
              }`}
            >
              Student
            </button>
            <button
              type="button"
              onClick={() => handleModeChange("teacher")}
              className={`flex-1 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
                mode === "teacher" ? "bg-paper text-forest shadow-sm" : "text-ink-soft hover:text-ink"
              }`}
            >
              Teacher
            </button>
            <button
              type="button"
              onClick={() => handleModeChange("proctor")}
              className={`flex-1 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
                mode === "proctor" ? "bg-paper text-[#B7791F] shadow-sm" : "text-ink-soft hover:text-ink"
              }`}
            >
              Proctor
            </button>
          </div>
          )}

          <form onSubmit={handleLogin} className="mt-7 space-y-5">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-soft">
                {mode === "student" ? "Registration Number" : `${mode === "teacher" ? "Teacher" : "Proctor"} Email Address`}
              </label>
              <input
                type={mode === "student" ? "text" : "email"}
                required
                placeholder={mode === "student" ? "e.g., 21BQ1A0501" : `${mode}@vignan.ac.in`}
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                className="mt-2 w-full border-b border-line bg-transparent px-0 py-2 text-lg text-ink placeholder:text-ink-soft/40 focus:border-ink focus:outline-none focus:ring-0"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-soft">
                Password
              </label>
              <input
                type="password"
                required
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-2 w-full border-b border-line bg-transparent px-0 py-2 text-lg text-ink placeholder:text-ink-soft/40 focus:border-ink focus:outline-none focus:ring-0"
              />
            </div>

            {error && (
              <div className="rounded border border-maroon/20 bg-maroon/5 p-3 text-xs text-maroon">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !identifier || !password}
              className="mt-4 flex w-full items-center justify-center gap-2 bg-ink py-3.5 text-sm font-medium text-paper transition-colors hover:bg-ink/90 disabled:opacity-50"
            >
              {loading ? (
                <span className="h-4 w-4 animate-spin rounded-none border-2 border-paper border-t-transparent inline-block" />
              ) : (
                inKiosk ? "Sign in" : `Access ${mode.charAt(0).toUpperCase() + mode.slice(1)} Console`
              )}
            </button>
          </form>

          <p className="mt-5 text-center">
            <Link to="/forgot" className="font-mono text-[11px] uppercase tracking-wider text-ink-soft hover:text-forest hover:underline">
              Forgot password?
            </Link>
          </p>

          {inKiosk && (
            <div className="mt-5 border border-line bg-raised p-3">
              <p className="font-mono text-[10px] uppercase tracking-widest text-soft">Vignan Exam Browser</p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
                Sign in once on this computer — the exam app keeps you signed in for future exams. Your exam opens from the student dashboard or your invite link.
              </p>
              {/* Quitting is locked inside the kiosk, so the login screen must
                  always offer a sanctioned way out for pre-exam states. */}
              <button
                type="button"
                onClick={() => void invoke("exit_app")}
                className="mt-2 w-full border border-line px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-forest"
              >
                Exit Vignan Exam Browser
              </button>
            </div>
          )}

          {(import.meta.env.DEV || searchParams.has("demo") || !supabaseConfigured) && !inKiosk && (
            <div className="mt-6 border border-dashed border-amber/60 bg-amber/5 p-4">
              <p className="font-mono text-[10px] uppercase tracking-widest text-amber font-bold">Demo mode — no backend configured</p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
                Sign in with a demo identity to explore the console without a database.
              </p>
              <div className="mt-3 grid gap-2">
                {(["student", "teacher", "proctor"] as const).map((role) => (
                  <button
                    key={role}
                    type="button"
                    onClick={() => {
                      signInDemo!(role);
                      navigate(role === "proctor" ? "/proctor" : role === "teacher" ? "/teacher" : studentDestination, { replace: true });
                    }}
                    className="border border-line bg-paper px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-ink hover:bg-paper-raised hover:border-forest hover:text-forest"
                  >
                    Continue as {role.charAt(0).toUpperCase() + role.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
