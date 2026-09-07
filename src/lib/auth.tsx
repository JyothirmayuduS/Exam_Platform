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

    // A stored demo identity may be honored ONLY when there is no real backend
    // (pure prototype) or in a DEV / E2E build. In production (Supabase
    // configured AND not DEV) a planted localStorage role is IGNORED — access
    // requires a real signed-in session. This one predicate gates every
    // demo-fallback path below so none of them can be bypassed individually.
    const demoAllowed = !db || import.meta.env.DEV;
    }

    // Get initial session — a REAL Supabase session always wins over a stored
    // demo identity.
    db.auth.getSession().then(({ data }: { data: { session: any } }) => {
      if (data.session) {
        setSession(data.session);
        setUser(data.session?.user ?? null);
        resolveRole(data.session?.user ?? null);
        return;
      }
      // No real session: honor a stored demo identity only when allowed
      // (DEV/E2E). Otherwise finish loading with no identity so the app doesn't
      // hang on the loading screen.
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
