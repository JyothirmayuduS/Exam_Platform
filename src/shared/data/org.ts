import { getSupabase } from "@/shared/data/supabase";

/** Active organization from Supabase. Empty fields when none is configured. */
export async function getOrg(): Promise<{ id: string; name: string; slug: string } | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data } = await db
    .from("organizations")
    .select("id, name, slug")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    id: String(data.id),
    name: String(data.name ?? ""),
    slug: String(data.slug ?? ""),
  };
}
