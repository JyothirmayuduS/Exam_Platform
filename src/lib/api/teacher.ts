// ──────────────────────────────────────────────────────────────────────────
// Domain module: teacher — settings + profile persistence for the signed-in
// teacher row. Extracted from src/lib/examApi.ts.
// ──────────────────────────────────────────────────────────────────────────

import { getSupabase } from "../supabase";

/** Persist a settings blob on the signed-in teacher's row (merged, not replaced). */
export async function saveTeacherSettings(patch: Record<string, unknown>): Promise<boolean> {
  const db = getSupabase();
  if (!db) return false;
  const { data: { user } } = await db.auth.getUser();
  if (!user) return false;
  const { data: me } = await db
    .from("teachers")
    .select("id, settings")
    .eq("auth_id", user.id)
    .maybeSingle();
  if (!me) return false;
  const cur = (me as { settings?: Record<string, unknown> }).settings ?? {};
  const { error } = await db
    .from("teachers")
    .update({ settings: { ...cur, ...patch } })
    .eq("id", (me as { id: string }).id);
  return !error;
}

/** Read the signed-in teacher's settings blob. */
export async function getTeacherSettings(): Promise<Record<string, unknown>> {
  const db = getSupabase();
  if (!db) return {};
  const { data: { user } } = await db.auth.getUser();
  if (!user) return {};
  const { data: me } = await db
    .from("teachers")
    .select("settings")
    .eq("auth_id", user.id)
    .maybeSingle();
  return (me as { settings?: Record<string, unknown> } | null)?.settings ?? {};
}

/** Update the signed-in teacher's profile fields (full_name/department/etc). */
export async function updateTeacherProfile(fields: {
  full_name?: string;
  department?: string;
  designation?: string;
  email?: string;
}): Promise<boolean> {
  const db = getSupabase();
  if (!db) return false;
  const { data: { user } } = await db.auth.getUser();
  if (!user) return false;
  const clean: Record<string, unknown> = {};
  if (fields.full_name !== undefined) clean.full_name = fields.full_name.trim();
  if (fields.department !== undefined) clean.department = fields.department.trim();
  if (fields.designation !== undefined) clean.designation = fields.designation.trim();
  if (fields.email !== undefined) clean.email = fields.email.trim();
  if (Object.keys(clean).length === 0) return false;
  const { error } = await db.from("teachers").update(clean).eq("auth_id", user.id);
  return !error;
}
