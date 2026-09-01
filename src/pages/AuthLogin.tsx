import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { loginWithPassword, roleHomePath, sendMagicLink, useAuthProfile } from "../lib/auth";

function safeNext(target: string | null): string | null {
  if (!target) return null;
  if (!target.startsWith("/")) return null;
  if (target.startsWith("//")) return null;
  return target;
}

export default function AuthLogin() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const { profile, loading } = useAuthProfile();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [magicBusy, setMagicBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const next = useMemo(() => safeNext(search.get("next")), [search]);

  useEffect(() => {
    if (loading || !profile) return;
    navigate(next ?? roleHomePath(profile.role), { replace: true });
  }, [loading, profile, navigate, next]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    const res = await loginWithPassword(email.trim(), password);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const currentRole = profile?.role;
    navigate(next ?? (currentRole ? roleHomePath(currentRole) : "/"), { replace: true });
  }

  async function onMagicLink() {
    setMagicBusy(true);
    setError(null);
    setMessage(null);
    const res = await sendMagicLink(email.trim());
    setMagicBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setMessage("Login link sent. Check your email inbox.");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6">
      <div className="w-full max-w-md border border-line bg-paper p-7">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Authentication</p>
        <h1 className="mt-2 font-serif text-3xl font-semibold">Sign in</h1>
        <p className="mt-2 text-[13px] text-ink-soft">Use your registered exam account.</p>

        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <label className="block text-[11px] uppercase tracking-wider text-ink-soft">
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1.5 block w-full border border-line-strong bg-paper px-3 py-3 text-[14px] outline-none focus:border-forest"
              placeholder="you@vignan.ac.in"
            />
          </label>
          <label className="block text-[11px] uppercase tracking-wider text-ink-soft">
            Password
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1.5 block w-full border border-line-strong bg-paper px-3 py-3 text-[14px] outline-none focus:border-forest"
              placeholder="••••••••"
            />
          </label>

          {error && <p className="border border-alert/40 bg-alert/5 px-3 py-2 text-[12px] text-alert">{error}</p>}
          {message && <p className="border border-success/40 bg-success/5 px-3 py-2 text-[12px] text-success">{message}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full border border-forest bg-forest py-3 font-mono text-[11px] uppercase tracking-wider text-paper hover:bg-forest-light disabled:opacity-70"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <button
          type="button"
          onClick={onMagicLink}
          disabled={magicBusy || !email.trim()}
          className="mt-3 w-full border border-line-strong py-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-forest disabled:opacity-70"
        >
          {magicBusy ? "Sending link…" : "Send magic link"}
        </button>

        <Link to="/" className="mt-4 block text-center font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink">
          Back to role selection
        </Link>
      </div>
    </div>
  );
}
