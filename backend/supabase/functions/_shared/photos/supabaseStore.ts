// Postgres + Storage implementation of PhotoStore. Needs a service-role client.
// deno-lint-ignore-file no-explicit-any
import type { PhotoStore } from "./handler.ts";

export const PHOTO_BUCKET = "student-photos";

export function supabasePhotoStore(db: any): PhotoStore {
  return {
    async studentByAuth(authId) {
      const { data, error } = await db.from("students").select("id, roll").eq("auth_id", authId).maybeSingle();
      if (error) throw new Error(error.message);
      return data ? { id: String(data.id), roll: data.roll ?? "" } : null;
    },

    async photo(studentId) {
      const { data, error } = await db.from("student_photos").select("captured_at").eq("student_id", studentId).maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? null;
    },

    async save(studentId, jpeg, nowIso) {
      if (await this.photo(studentId)) return "exists";
      const path = `${studentId}/${nowIso.replace(/[:.]/g, "-")}.jpg`;
      const up = await db.storage.from(PHOTO_BUCKET).upload(path, jpeg, { contentType: "image/jpeg", upsert: false });
      if (up.error) throw new Error(up.error.message);
      const { data, error } = await db.from("student_photos")
        .insert({ student_id: studentId, storage_path: path, bytes: jpeg.length, captured_at: nowIso })
        .select("captured_at").maybeSingle();
      if (error) {
        await db.storage.from(PHOTO_BUCKET).remove([path]);
        if (error.code === "23505") return "exists";
        throw new Error(error.message);
      }
      return { captured_at: data?.captured_at ?? nowIso };
    },

    async writeAudit({ actorId, studentId, bytes }) {
      const { error } = await db.from("audit_logs").insert({
        actor_id: actorId, actor_role: "system", action: "student.photo_registered", target_type: "student", target_id: studentId, meta: { bytes },
      });
      if (error) throw new Error(error.message);
    },
  };
}
