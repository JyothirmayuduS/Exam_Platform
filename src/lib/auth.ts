import { createContext, useContext, useEffect, useState } from "react";
import { User, Session } from "@supabase/supabase-js";
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
  loading: true 
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<AuthRole>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) {
      setLoading(false);
      return;
    }

    const checkUserRole = async (currentUser: User | null) => {
      if (!currentUser) {
        setRole(null);
        return;
      }
      
      // Check if user is in students table
      const { data, error } = await supabase
        .from("students")
        .select("id")
        .eq("auth_id", currentUser.id)
        .single();
        
      if (!error && data) {
        setRole("student");
      } else {
        // If they are not a student, assume teacher for this prototype
        setRole("teacher");
      }
    };

    // Initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        checkUserRole(session.user).then(() => setLoading(false));
      } else {
        setLoading(false);
      }
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        setLoading(true);
        checkUserRole(session.user).then(() => setLoading(false));
      } else {
        setRole(null);
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  return (
    <AuthContext.Provider value={{ user, session, role, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
