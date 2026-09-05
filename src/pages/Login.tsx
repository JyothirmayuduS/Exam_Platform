import { useState, useEffect } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { getSupabase } from "../lib/supabase";

type LoginMode = "student" | "teacher" | "proctor";

export default function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryRole = searchParams.get("role") as LoginMode | null;

  const [mode, setMode] = useState<LoginMode>("student");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (queryRole && ["student", "teacher", "proctor"].includes(queryRole)) {
      setMode(queryRole);
    }
  }, [queryRole]);

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

    // Check teacher/proctor role
    const { data: teacherData } = await db
      .from("teachers")
      .select("role")
      .eq("auth_id", data.user.id)
      .maybeSingle();

    if (teacherData) {
      if (teacherData.role === "proctor" || mode === "proctor") {
        navigate("/proctor");
      } else {
        navigate("/teacher");
      }
    } else {
      navigate("/student");
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
          <p className="mt-2 text-sm text-ink-soft">Select your role and sign in to your console.</p>

          {/* 3 Role Tabs */}
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
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-paper border-t-transparent inline-block" />
              ) : (
                `Access ${mode.charAt(0).toUpperCase() + mode.slice(1)} Console`
              )}
            </button>
          </form>

          <p className="mt-5 text-center">
            <Link to="/forgot" className="font-mono text-[11px] uppercase tracking-wider text-ink-soft hover:text-forest hover:underline">
              Forgot password?
            </Link>
          </p>

        </div>
      </div>
    </div>
  );
}
