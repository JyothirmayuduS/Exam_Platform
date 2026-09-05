// Server-signed R2 operations — the ONLY client path to Cloudflare R2.
//
// The browser never holds R2 credentials. Every operation (upload, read,
// list) is minted server-side by the `store-artifact` Supabase Edge Function
// (JWT-gated, credentials in function secrets) and executed with a plain
// fetch. Folder layout is shared with the review side:
//
//   ${examId}/${ownerSegment}/${kind}/${filename}
//
// `ownerSegment` is opaque to R2 — callers pass the candidate's roll number
// or student uuid, and must use the same segment when reading back.

import { getSupabase } from "./supabase";
import { supabaseConfigured } from "./env";

/** Folder names used in the R2 key layout. */
export type R2Kind = "screenshots" | "recordings" | "violations" | "report" | "ai_evidence";

export type R2ListedObject = {
  key: string;
  name: string;
  size: number;
  lastModified: string | null;
};

async function invoke<T>(body: Record<string, unknown>): Promise<T | null> {
  if (!supabaseConfigured) return null;
  const db = getSupabase();
  if (!db) return null;
  try {
    const { data, error } = await db.functions.invoke("store-artifact", { body });
    if (error || !data) {
      console.warn(`[r2Function] store-artifact (${body.op ?? "put"}) failed:`, error?.message ?? "no data");
      return null;
    }
    return data as T;
  } catch (err) {
    console.warn("[r2Function] invoke error:", err);
    return null;
  }
}

/** Presign a PUT for one object, then upload the blob with a plain fetch PUT. */
export async function r2PutBlob(opts: {
  examId: string;
  ownerSegment: string;
  kind: R2Kind;
  name: string;
  blob: Blob;
}): Promise<string | null> {
  const contentType = opts.blob.type || "application/octet-stream";
  const signed = await invoke<{ url: string; key: string }>({
    op: "put",
    examId: opts.examId,
    studentId: opts.ownerSegment,
    kind: opts.kind,
    name: opts.name,
    contentType,
  });
  if (!signed?.url) return null;
  try {
    const res = await fetch(signed.url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: opts.blob,
    });
    if (!res.ok) {
      console.warn("[r2Function] R2 PUT failed:", res.status, res.statusText);
      return null;
    }
    return signed.key;
  } catch (err) {
    console.warn("[r2Function] R2 PUT error:", err);
    return null;
  }
}

/** Short-lived presigned GET URL for a stored object key. */
export async function r2PresignGet(key: string, expiresSec = 3600): Promise<string | null> {
  const res = await invoke<{ url: string }>({ op: "get", key, expiresSec });
  return res?.url ?? null;
}

/** List objects under a prefix (e.g. `${examId}/${owner}/${kind}/`). */
export async function r2List(prefix: string): Promise<R2ListedObject[] | null> {
  const res = await invoke<{ objects: R2ListedObject[] }>({ op: "list", prefix });
  return res?.objects ?? null;
}
