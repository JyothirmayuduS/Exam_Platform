import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getSupabase } from "../lib/supabase";

/** Destination of the email reset link. Supabase puts the recovery session in
 *  the URL hash; we read it, let the user set a new password, then sign out. */
export default function PasswordRecover() {
  const navigate = useNavigate();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<"checking" | "ready" | "done">("checking");

  useEffect(() => {
    const db = getSupabase();
    if (!db) { setState("ready"); return; }
    void db.auth.getSession().then(({ data }: { data: { session: unknown } | null }) => {
      setState("ready");
      if (!data?.session) setError("This reset link is invalid or expired — request a new one.");
    });
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (pw.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (pw !== pw2) { setError("Passwords do not match."); return; }
    const db = getSupabase();
    if (!db) { setError("Database connection error"); return; }
    const { error: err } = await db.auth.updateUser({ password: pw });
    if (err) { setError(err.message); return; }
    await db.auth.signOut().catch(() => undefined);
    setState("done");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper p-8">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center border-2 border-ink font-serif text-lg font-bold text-ink">V</div>
          <p className="font-mono text-xs uppercase tracking-wider text-ink-soft">Account recovery</p>
        </div>

        {state === "done" ? (
          <div className="rounded border border-success/25 bg-success/5 p-5 text-[13px]">
            <p className="font-medium text-success">Password updated</p>
            <p className="mt-1 text-ink-soft">You can now sign in with your new password.</p>
            <button onClick={() => navigate("/login")} className="mt-4 w-full bg-ink py-3 text-sm font-medium text-paper hover:bg-ink/90">Go to sign in</button>
          </div>
        ) : (
          <>
            <h2 className="font-serif text-3xl font-semibold text-ink">Choose a new password</h2>
            <p className="mt-2 text-sm text-ink-soft">Use at least 8 characters. Don't reuse a password from another service.</p>
            <form onSubmit={(e) => void submit(e)} className="mt-7 space-y-5">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-ink-soft">New password</label>
                <input
                  type="password"
                  required
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  className="mt-2 w-full border-b border-line bg-transparent px-0 py-2 text-lg text-ink focus:border-ink focus:outline-none focus:ring-0"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-ink-soft">Confirm password</label>
                <input
                  type="password"
                  required
                  value={pw2}
                  onChange={(e) => setPw2(e.target.value)}
                  className="mt-2 w-full border-b border-line bg-transparent px-0 py-2 text-lg text-ink focus:border-ink focus:outline-none focus:ring-0"
                />
              </div>
              {error && <p className="rounded border border-maroon/20 bg-maroon/5 p-3 text-xs text-maroon">{error}</p>}
              <button
                type="submit"
                disabled={state === "checking"}
                className="mt-4 flex w-full items-center justify-center bg-ink py-3.5 text-sm font-medium text-paper transition-colors hover:bg-ink/90 disabled:opacity-50"
              >
                {state === "checking" ? "Checking link…" : "Update password"}
              </button>
              <p className="text-center">
                <Link to="/login" className="font-mono text-[11px] uppercase tracking-wider text-ink-soft hover:text-ink">← Back to sign in</Link>
              </p>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
