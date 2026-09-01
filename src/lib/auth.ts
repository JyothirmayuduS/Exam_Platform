import { useEffect, useState } from "react";
import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";

export type AppRole = "student" | "teacher" | "proctor" | "admin";

export type AuthProfile = {
  id: string;
  email: string;
  role: AppRole;
  batch: string | null;
  fullName: string;
  department: string | null;
  photoUrl: string | null;
};

const VALID_ROLES = new Set<AppRole>(["student", "teacher", "proctor", "admin"]);

function safeRole(user: User): AppRole | null {
  const raw = (user.app_metadata as Record<string, unknown> | undefined)?.role;
  if (typeof raw !== "string") return null;
  return VALID_ROLES.has(raw as AppRole) ? (raw as AppRole) : null;
}

function toProfile(user: User): AuthProfile | null {
  const role = safeRole(user);
  if (!role) return null;
  const appMeta = user.app_metadata as Record<string, unknown> | undefined;
  const userMeta = user.user_metadata as Record<string, unknown> | undefined;
  const fallbackName = typeof userMeta?.full_name === "string" ? userMeta.full_name : user.email ?? "User";
  return {
    id: user.id,
    email: user.email ?? "",
    role,
    batch: typeof appMeta?.batch === "string" ? appMeta.batch : null,
    fullName: typeof appMeta?.full_name === "string" ? appMeta.full_name : fallbackName,
    department: typeof appMeta?.department === "string" ? appMeta.department : null,
    photoUrl: typeof appMeta?.photo_url === "string" ? appMeta.photo_url : null,
  };
}

export async function getCurrentSession(): Promise<Session | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data } = await db.auth.getSession();
  return data.session ?? null;
}

export async function getCurrentUser(): Promise<User | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data } = await db.auth.getUser();
  return data.user ?? null;
}

export async function getCurrentProfile(): Promise<AuthProfile | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  return toProfile(user);
}

export async function loginWithPassword(email: string, password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getSupabase();
  if (!db) return { ok: false, error: "Supabase is not configured" };
  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function sendMagicLink(email: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getSupabase();
  if (!db) return { ok: false, error: "Supabase is not configured" };
  const { error } = await db.auth.signInWithOtp({ email });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function logout(): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  await db.auth.signOut();
}

export function onAuthChange(cb: (event: AuthChangeEvent, session: Session | null) => void): () => void {
  const db = getSupabase();
  if (!db) return () => undefined;
  const { data } = db.auth.onAuthStateChange((event, session) => cb(event, session));
  return () => data.subscription.unsubscribe();
}

export function roleHomePath(role: AppRole): string {
  if (role === "teacher") return "/teacher";
  if (role === "proctor") return "/proctor";
  if (role === "admin") return "/teacher";
  return "/student";
}

export function useAuthProfile() {
  const [profile, setProfile] = useState<AuthProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const next = await getCurrentProfile();
      if (!active) return;
      setProfile(next);
      setLoading(false);
    };
    void load();
    const unsub = onAuthChange(() => void load());
    return () => {
      active = false;
      unsub();
    };
  }, []);

  return { profile, loading };
}
