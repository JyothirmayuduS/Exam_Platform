/**
 * useCurrentProfile — fetches the logged-in user's profile from the DB.
 *
 * Returns the student or teacher row that corresponds to the Supabase Auth user,
 * so all pages can display a real name / subtitle / role without hardcoding.
 */
import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth";
import { getSupabase } from "../lib/supabase";

export type StudentProfile = {
  kind: "student";
  id: string;
  full_name: string;
  roll: string;
  department: string;
  semester: number | null;
  email: string;
};

export type TeacherProfile = {
  kind: "teacher";
  id: string;
  full_name: string;
  department: string;
  designation: string;
  email: string;
};

export type UserProfile = StudentProfile | TeacherProfile | null;

export default function useCurrentProfile() {
  const { user, role, loading: authLoading } = useAuth();
  const [profile, setProfile] = useState<UserProfile>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { setProfile(null); setLoading(false); return; }

    const db = getSupabase();
    if (!db) { setLoading(false); return; }

    async function load() {
      setLoading(true);
      if (role === "teacher") {
        const { data } = await db!
          .from("teachers")
          .select("id, full_name, department, designation, email")
          .eq("auth_id", user!.id)
          .maybeSingle();

        setProfile(data
          ? { kind: "teacher", ...data, designation: data.designation ?? "Faculty" }
          : null
        );
      } else {
        const { data, error } = await db!
          .from("students")
          .select("id, full_name, roll, branch, section, email")
          .eq("auth_id", user!.id)
          .maybeSingle();

        if (error) {
          console.error("useCurrentProfile: Error loading student profile:", error);
        }

        setProfile(data
          ? { kind: "student", ...data, department: data.branch, semester: null }
          : null
        );
      }
      setLoading(false);
    }

    void load();
  }, [user, role, authLoading]);

  return { profile, loading };
}

/** Returns a human-readable subtitle for the RoleLayout header */
export function profileSubtitle(profile: UserProfile): string {
  if (!profile) return "";
  if (profile.kind === "student") {
    const parts = [profile.roll, profile.department];
    if (profile.semester) parts.push(`Sem ${profile.semester}`);
    return parts.filter(Boolean).join(" · ");
  }
  return `${profile.department} · ${profile.designation}`;
}
