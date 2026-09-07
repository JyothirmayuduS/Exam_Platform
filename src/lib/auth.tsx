import { createContext, useContext, useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";

export type AuthRole = "student" | "teacher" | "proctor" | null;
type AuthContextType = {
  user: User | null; session: Session | null; role: AuthRole; loading: boolean;
  signOut: () => Promise<void>; signInDemo?: (r: Exclude<AuthRole, null>) => void;
};
const AuthContext = createContext<AuthContextType>({ user: null, session: null, role: null, loading: true, signOut: async () => {}, signInDemo: undefined });

// Stored demo identity (dev / no-backend only — see demoAllowed below). The
// exam platform's CI and local dev run WITHOUT a Supabase backend; the Login
// page offers demo identities so the consoles are explorable. The stored role
// survives full page reloads, which the E2E suite relies on after page.goto.
const DEMO_ROLE_KEY = "vignan.demo_role";

function demoUser(role: Exclude<AuthRole, null>): User {
  return {
    id: `demo-${role}`,
    aud: "demo",
    role: "authenticated",
    email: `${role}@demo.vignan.local`,
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
  } as unknown as User;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<AuthRole>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const db = getSupabase();

    // A stored demo identity may be honored ONLY when there is no real backend
    // (pure prototype / CI / E2E). In production (Supabase configured AND not
    // DEV) a planted localStorage role is IGNORED — access requires a real
    // signed-in session. This one predicate gates every demo path below.
    const demoAllowed = !db || import.meta.env.DEV;
    if (demoAllowed) {
      const stored = (localStorage.getItem(DEMO_ROLE_KEY) ?? "") as Exclude<AuthRole, null> | "";
      if (stored === "student" || stored === "teacher" || stored === "proctor") {
        setUser(demoUser(stored));
        setSession(null);
        setRole(stored);
        setLoading(false);
        return;
      }
      setLoading(false);
      // No stored identity — fall through so a configured backend can still
      // resolve a real session (dev against staging).
    }

    if (!db) { setLoading(false); return; }

    // Get initial session — a REAL Supabase session always wins.
    db.auth.getSession().then(({ data }: { data: { session: any } }) => {
      if (data.session) { setSession(data.session); setUser(data.session.user ?? null); resolveRole(data.session.user ?? null); }
      else { setUser(null); setSession(null); setRole(null); setLoading(false); }
    });
    const { data: { subscription } } = db.auth.onAuthStateChange((_: any, s: Session | null) => {
      setSession(s); setUser(s?.user ?? null); if (s?.user) resolveRole(s.user); else { setRole(null); setLoading(false); }
    });
    return () => subscription.unsubscribe();

    async function resolveRole(u: User | null) {
      if (!u) { setRole(null); setLoading(false); return; }
      const db = getSupabase(); if (!db) { setLoading(false); return; }
      const { data: t } = await db.from("teachers").select("id, role").eq("auth_id", u.id).maybeSingle();
      setRole(t ? (t.role === "proctor" ? "proctor" : "teacher") : "student");
      setLoading(false);
    }
  }, []);

  // Demo sign-in (Login page, dev/no-backend only). Role alone is not enough:
  // ProtectedRoute gates on a signed-in user, so a demo identity carries a
  // synthetic user (id prefixed "demo-", never a real auth account) and is
  // persisted for reloads. signOut clears both.
  const signInDemo = (r: Exclude<AuthRole, null>) => {
    setUser(demoUser(r));
    setSession(null);
    setRole(r);
    setLoading(false);
    try { localStorage.setItem(DEMO_ROLE_KEY, r); } catch { /* private mode */ }
  };

  const signOut = async () => {
    const db = getSupabase();
    if (db) await db.auth.signOut();
    try { localStorage.removeItem(DEMO_ROLE_KEY); } catch { /* ignore */ }
    setUser(null); setSession(null); setRole(null);
  };

  return <AuthContext.Provider value={{ user, session, role, loading, signOut, signInDemo }}>{children}</AuthContext.Provider>;
}
export const useAuth = () => useContext(AuthContext);
