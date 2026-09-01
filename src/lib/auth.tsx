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
  loading: true 
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Since authentication is disabled, we mock the session with the first student
  // from seed.sql ("Priya Nikitha") so that all Phase 3 database queries still work
  // seamlessly without requiring a login.
  const mockUser = {
    id: "11111111-1111-1111-1111-111111111111",
    email: "priya.nikitha@vignan.edu",
    app_metadata: {},
    user_metadata: {},
    aud: "authenticated",
    created_at: new Date().toISOString(),
  } as User;

  return (
    <AuthContext.Provider value={{ 
      user: mockUser, 
      session: { access_token: "mock", refresh_token: "mock", expires_in: 3600, token_type: "bearer", user: mockUser }, 
      role: "student", // Default to student for queries, RoleLayout overrides UI 
      loading: false 
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
