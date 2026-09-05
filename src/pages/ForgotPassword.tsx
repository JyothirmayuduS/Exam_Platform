import { useState } from "react";
import { Link } from "react-router-dom";
import { getSupabase } from "../lib/supabase";

/** Request a password-reset email (staff + students). Students enter their
 *  roll number, staff their email. */
export default function ForgotPassword() {
  const [identifier, setIdentifier] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const db = getSupabase();
    if (!db) { setError("Database connection error"); return; }
    setLoading(true);
    let email = identifier.trim().toLowerCase();
    if (!email.includes("@")) email = `${email}@student.vignan.ac.in`;
    const { error: err } = await db.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/recover`,
    });
    setLoading(false);
    if (err) { setError(err.message); return; }
    setSentTo(email);
  };

  return (
    <div className="flex min-h-screen bg-paper">
      <div className="hidden w-1/3 flex-col justify-between border-r border-line bg-paper-raised p-8 lg:flex">
        <div className="flex h-12 w-12 items-center justify-center border-2 border-ink font-serif text-xl font-bold text-ink">V</div>
        <p className="text-[13px] leading-relaxed text-ink-soft">
          Password reset is processed by the institution's identity service. Staff accounts reset via their faculty email; students via their roll number.
        </p>
      </div>
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center justify-between lg:hidden">
            <div className="flex h-10 w-10 items-center justify-center border-2 border-ink font-serif text-lg font-bold text-ink">V</div>
            <Link to="/login" className="font-mono text-xs uppercase tracking-wider text-ink-soft hover:text-ink">← Back to sign in</Link>
          </div>
          <h2 className="font-serif text-3xl font-semibold text-ink">Reset password</h2>
          <p className="mt-2 text-sm text-ink-soft">Enter your roll number (students) or faculty email (staff). We'll email you a reset link.</p>

          {sentTo ? (
            <div className="mt-7 rounded border border-success/25 bg-success/5 p-4 text-[13px] text-ink">
              <p className="font-medium text-success">Reset link sent</p>
              <p className="mt-1 text-ink-soft">Check <span className="font-medium text-ink">{sentTo}</span> and open the link to choose a new password. The link expires shortly.</p>
              <Link to="/login" className="mt-4 inline-block font-mono text-[11px] uppercase tracking-wider text-forest hover:underline">Back to sign in</Link>
            </div>
          ) : (
            <form onSubmit={(e) => void submit(e)} className="mt-7 space-y-5">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-ink-soft">Roll number or email</label>
                <input
                  required
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="e.g., 21BQ1A0501 or name@vignan.ac.in"
                  className="mt-2 w-full border-b border-line bg-transparent px-0 py-2 text-lg text-ink placeholder:text-ink-soft/40 focus:border-ink focus:outline-none focus:ring-0"
                />
              </div>
              {error && <p className="rounded border border-maroon/20 bg-maroon/5 p-3 text-xs text-maroon">{error}</p>}
              <button
                type="submit"
                disabled={loading || !identifier}
                className="mt-4 flex w-full items-center justify-center gap-2 bg-ink py-3.5 text-sm font-medium text-paper transition-colors hover:bg-ink/90 disabled:opacity-50"
              >
                {loading ? "Sending…" : "Send reset link"}
              </button>
              <p className="text-center">
                <Link to="/login" className="font-mono text-[11px] uppercase tracking-wider text-ink-soft hover:text-ink">← Back to sign in</Link>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
