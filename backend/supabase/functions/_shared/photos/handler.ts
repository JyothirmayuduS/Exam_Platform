// Registration photo for the signed-in student. One photo per student; an admin
// clears it (admin-dashboard op "reset_photo") to allow a retake.
//
// POST { op: "status" }                         → { required, hasPhoto, capturedAt }
// POST { op: "upload", image: "data:image/jpeg;base64,…" } → { ok, capturedAt }

export type PhotoStore = {
  studentByAuth(authId: string): Promise<{ id: string; roll: string } | null>;
  photo(studentId: string): Promise<{ captured_at: string } | null>;
  /** Stores the file and its row; "exists" when the student already has a photo. */
  save(studentId: string, jpeg: Uint8Array, nowIso: string): Promise<{ captured_at: string } | "exists">;
  writeAudit(entry: { actorId: string; studentId: string; bytes: number }): Promise<void>;
};

/** A webcam frame is well above this; anything smaller is not a real photo. */
export const MIN_BYTES = 4_000;
export const MAX_BYTES = 900_000;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

/** JPEG bytes from a data URL, or null when it isn't a JPEG of a sensible size. */
export function decodeJpeg(dataUrl: unknown): Uint8Array | null {
  if (typeof dataUrl !== "string") return null;
  const m = dataUrl.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  if (!m || m[1].length > Math.ceil(MAX_BYTES / 3) * 4 + 4) return null;
  let bin: string;
  try { bin = atob(m[1]); } catch { return null; }
  if (bin.length < MIN_BYTES || bin.length > MAX_BYTES) return null;
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? bytes : null;
}

export function createPhotoHandler(deps: { store: PhotoStore; actor: (req: Request) => Promise<{ authId: string } | null>; now: () => number }) {
  const { store } = deps;
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    try {
      const actor = await deps.actor(req);
      if (!actor) return json({ error: "sign_in_required" }, 401);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const student = await store.studentByAuth(actor.authId);

      if ((body.op ?? "status") === "status") {
        if (!student) return json({ required: false, hasPhoto: false, capturedAt: null });
        const p = await store.photo(student.id);
        return json({ required: true, hasPhoto: !!p, capturedAt: p?.captured_at ?? null });
      }

      if (body.op === "upload") {
        if (!student) return json({ error: "students_only" }, 403);
        const jpeg = decodeJpeg(body.image);
        if (!jpeg) return json({ error: "bad_image" }, 400);
        const saved = await store.save(student.id, jpeg, new Date(deps.now()).toISOString());
        if (saved === "exists") return json({ error: "already_taken" }, 409);
        await store.writeAudit({ actorId: actor.authId, studentId: student.id, bytes: jpeg.length });
        return json({ ok: true, capturedAt: saved.captured_at });
      }

      return json({ error: "unknown_op" }, 400);
    } catch (err) {
      console.error("[registration-photo]", err);
      return json({ error: "server_error" }, 500);
    }
  };
}
