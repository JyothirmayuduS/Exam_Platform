import { createContext, useContext, useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";

export type AuthRole = "student" | "teacher" | "proctor" | null;
export type DemoRole = Exclude<AuthRole, null>;

type AuthContextType = {
  user: User | null;
  session: Session | null;
  role: AuthRole;
  loading: boolean;
  signOut: () => Promise<void>;
  signInDemo: (role: DemoRole) => void;
};

const DEMO_KEY = "demo_auth_role";
const DEMO_ROLES: readonly DemoRole[] = ["student", "teacher", "proctor"];

function demoUser(role: DemoRole): User {
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

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  role: null,
  loading: true,
  signOut: async () => {},
  signInDemo: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<AuthRole>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const db = getSupabase();
    if (!db) {
      // Demo mode (no backend configured): honor a stored demo identity so the
      // prototype's role consoles are reachable without a database (used by the
      // E2E suite and local demos).
      const stored = localStorage.getItem(DEMO_KEY) as DemoRole | null;
      if (stored && DEMO_ROLES.includes(stored)) {
        setUser(demoUser(stored));
        setRole(stored);
      }
      setLoading(false);
      return;
    }

    // Get initial session
    db.auth.getSession().then(({ data }: { data: { session: any } }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
      resolveRole(data.session?.user ?? null);
    });

    // Listen for auth state changes
    const { data: { subscription } } = db.auth.onAuthStateChange((_event: string, newSession: any) => {
      setSession(newSession);
      setUser(newSession?.user ?? null);
      resolveRole(newSession?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  async function resolveRole(authUser: User | null) {
    if (!authUser) {
      setRole(null);
      setLoading(false);
      return;
    }
    const db = getSupabase();
    if (!db) { setLoading(false); return; }

    // Check if user is a teacher or proctor (by checking teachers table)
    const { data: teacher } = await db
      .from("teachers")
      .select("id, role")
      .eq("auth_id", authUser.id)
      .maybeSingle();

    if (teacher) {
      setRole(teacher.role === "proctor" ? "proctor" : "teacher");
    } else {
      setRole("student");
    }
    setLoading(false);
  }

  const signInDemo = (role: DemoRole) => {
    localStorage.setItem(DEMO_KEY, role);
    setUser(demoUser(role));
    setRole(role);
    setLoading(false);
  };

  const signOut = async () => {
    localStorage.removeItem(DEMO_KEY);
    const db = getSupabase();
    if (db) await db.auth.signOut();
    setUser(null);
    setSession(null);
    setRole(null);
  };

  return (
    <AuthContext.Provider value={{ user, session, role, loading, signOut, signInDemo }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
