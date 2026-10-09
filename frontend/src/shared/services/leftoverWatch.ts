// Recording pieces and webcam snapshots an earlier sitting left on this device
// upload only for the student they belong to: on app start when that student
// is already signed in, otherwise as soon as they sign in. Signing out stops
// them again; they stay on disk. Other students' leftovers are counted in the log.
import type { Session } from "@supabase/supabase-js";
import { getSupabase } from "@/shared/data/supabase";
import { resumeLeftoverPieces, stopLeftoverPieces } from "@/shared/services/recordingParts";
import { resumeLeftoverSnapshots, stopLeftoverSnapshots } from "@/shared/services/snapshotLeftovers";

export function watchLeftoverPieces(): void {
  const db = getSupabase();
  if (!db) return;
  let current: string | null | undefined;
  const onUser = async (userId: string | null) => {
    if (userId === current) return;
    current = userId;
    stopLeftoverPieces();
    stopLeftoverSnapshots();
    let owners: string[] = [];
    if (userId) {
      try {
        const { data } = await db.from("students").select("id, roll").eq("auth_id", userId).maybeSingle();
        if (data) owners = [String(data.roll ?? ""), String(data.id ?? "")].filter(Boolean);
      } catch { /* not a student, or offline: nothing is uploaded */ }
    }
    if (current !== userId) return;
    await resumeLeftoverPieces({ owners });
    await resumeLeftoverSnapshots({ owners });
  };
  db.auth.onAuthStateChange((_event: string, session: Session | null) => {
    // Supabase calls this inside its auth lock; query after it is released.
    setTimeout(() => void onUser(session?.user?.id ?? null), 0);
  });
}
