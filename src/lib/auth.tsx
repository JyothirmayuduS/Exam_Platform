import { createContext, useContext, useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";

export type AuthRole = "student" | "teacher" | null;

type AuthContextType = {
  user: User | null;
  session: Session | null;
  role: AuthRole;
  loading: boolean;
};

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  role: null,
  loading: true,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<AuthRole>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const db = getSupabase();
    if (!db) {
      setLoading(false);
      return;
    }

    // Get initial session
    db.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
      resolveRole(data.session?.user ?? null);
    });

    // Listen for auth state changes
    const { data: { subscription } } = db.auth.onAuthStateChange((_event, newSession) => {
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

    // Check if user is a teacher (by checking teachers table)
    const { data: teacher } = await db
      .from("teachers")
      .select("id")
      .eq("auth_id", authUser.id)
      .maybeSingle();

    setRole(teacher ? "teacher" : "student");
    setLoading(false);
  }

  return (
    <AuthContext.Provider value={{ user, session, role, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
