// Domain module: the student's one-time registration photo, through the
// registration-photo edge function (the files are private to the server).

import { getSupabase } from "@/shared/data/supabase";

export type PhotoStatus = { required: boolean; hasPhoto: boolean; capturedAt: string | null };

const ERRORS: Record<string, string> = {
  bad_image: "That photo could not be used. Take it again with your face clearly in view.",
  already_taken: "Your registration photo is already saved.",
  students_only: "Only students take a registration photo.",
  sign_in_required: "Sign in again to save your photo.",
};

async function call<T>(body: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; error: string; code?: string }> {
  const db = getSupabase();
  if (!db) return { ok: false, error: "Offline", code: "offline" };
  const { data, error } = await db.functions.invoke("registration-photo", { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    const payload = ctx && typeof ctx.json === "function" ? ((await ctx.json().catch(() => null)) as { error?: string } | null) : null;
    const code = payload?.error;
    return { ok: false, code, error: (code && ERRORS[code]) || "Could not reach the server. Check your connection and try again." };
  }
  return { ok: true, data: data as T };
}

export const loadPhotoStatus = () => call<PhotoStatus>({ op: "status" });
export const uploadRegistrationPhoto = (image: string) => call<{ ok: true; capturedAt: string }>({ op: "upload", image });
