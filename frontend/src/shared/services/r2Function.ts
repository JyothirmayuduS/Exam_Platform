// Server-signed R2 operations — the ONLY client path to Cloudflare R2.
//
// The browser never holds R2 credentials. Every operation (upload, read,
// list) is minted server-side by the `store-artifact` Supabase Edge Function
// (JWT-gated, credentials in function secrets) and executed with a plain
// fetch. Folder layout is shared with the review side:
//
//   ${examFolder}/${ownerSegment}/${kind}/${filename}
//
// `${examFolder}` is the exam id (see examStorage.storageFolderSegment); older
// builds wrote under a slug of the exam name. `ownerSegment` is
// opaque to R2 — callers pass the candidate's roll number or student uuid,
// and must use the same segment when reading back.

import { getSupabase } from "@/shared/data/supabase";
import { supabaseConfigured } from "@/shared/data/env";

/** Folder names used in the R2 key layout. */
export type R2Kind = "screenshots" | "recordings" | "violations" | "report" | "ai_evidence" | "subjective" | "monitor";

export type R2ListedObject = {
  key: string;
  name: string;
  size: number;
  lastModified: string | null;
};

let lastR2Error: string | null = null;
let lastR2Status: number | null = null;

/** Last store-artifact failure, for surfaces that otherwise only see null. */
export function consumeR2Error(): string | null {
  const message = lastR2Error;
  lastR2Error = null;
  return message;
}

async function readInvokeError(error: { message?: string; context?: Response }): Promise<string> {
  let message = error.message || "store-artifact failed";
  try {
    const body = error.context ? await error.context.clone().json() as { error?: string } : null;
    if (body?.error) message = body.error;
  } catch { /* body already consumed or not JSON */ }
  return message;
}

async function invoke<T>(body: Record<string, unknown>): Promise<T | null> {
  lastR2Error = null;
  lastR2Status = null;
  if (!supabaseConfigured) {
    lastR2Error = "Supabase is not configured";
    return null;
  }
  const db = getSupabase();
  if (!db) {
    lastR2Error = "Supabase client is unavailable";
    return null;
  }
  try {
    const { data, error } = await db.functions.invoke("store-artifact", { body });
    if (error || !data) {
      lastR2Status = (error as { context?: Response } | null)?.context?.status ?? null;
      lastR2Error = error ? await readInvokeError(error as { message?: string; context?: Response }) : "store-artifact returned no data";
      console.warn(`[r2Function] store-artifact (${body.op ?? "put"}) failed:`, lastR2Error);
      return null;
    }
    if (typeof data === "object" && data && "error" in data && (data as { error?: string }).error) {
      lastR2Error = String((data as { error: string }).error);
      return null;
    }
    return data as T;
  } catch (err) {
    lastR2Error = err instanceof Error ? err.message : "store-artifact request failed";
    console.warn("[r2Function] invoke error:", err);
    return null;
  }
}

export type R2PutResult =
  | { key: string }
  | { key: null; status: number | null; error: string };

/** Presign a PUT for one object, then upload the blob with a plain fetch PUT. */
export async function r2PutBlob(opts: {
  /** Top-level R2 folder segment — slug of the exam name, or the exam id. */
  examId: string;
  ownerSegment: string;
  kind: R2Kind;
  name: string;
  blob: Blob;
}): Promise<string | null> {
  return (await r2PutBlobResult(opts)).key;
}

/** Like r2PutBlob, with the HTTP status of a refusal (storage or edge function). */
export async function r2PutBlobResult(opts: {
  /** Top-level R2 folder segment — slug of the exam name, or the exam id. */
  examId: string;
  ownerSegment: string;
  kind: R2Kind;
  name: string;
  blob: Blob;
}): Promise<R2PutResult> {
  const contentType = opts.blob.type || "application/octet-stream";
  const signed = await invoke<{ url: string; key: string }>({
    op: "put",
    examId: opts.examId,
    studentId: opts.ownerSegment,
    kind: opts.kind,
    name: opts.name,
    contentType,
  });
  if (!signed?.url) return { key: null, status: lastR2Status, error: lastR2Error ?? "store-artifact failed" };
  try {
    const res = await fetch(signed.url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: opts.blob,
    });
    if (!res.ok) {
      console.warn("[r2Function] R2 PUT failed:", res.status, res.statusText);
      return { key: null, status: res.status, error: `R2 PUT failed: ${res.status}` };
    }
    return { key: signed.key };
  } catch (err) {
    console.warn("[r2Function] R2 PUT error:", err);
    return { key: null, status: null, error: err instanceof Error ? err.message : "R2 PUT error" };
  }
}

/** Short-lived presigned GET URL for a stored object key. */
export async function r2PresignGet(key: string, expiresSec = 3600): Promise<string | null> {
  const res = await invoke<{ url: string }>({ op: "get", key, expiresSec });
  return res?.url ?? null;
}

/** Presigned GETs for many keys, 500 per edge call. Missing keys are omitted. */
export async function r2PresignGetMany(keys: string[], expiresSec = 3600, opts: { strict?: boolean } = {}): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const batches: string[][] = [];
  for (let i = 0; i < keys.length; i += 500) batches.push(keys.slice(i, i + 500));
  await Promise.all(batches.map(async (batch) => {
    const res = await invoke<{ urls: Record<string, string> }>({ op: "get-many", keys: batch, expiresSec });
    if (!res && opts.strict) throw new Error(lastR2Error ?? "batch presign failed");
    for (const [k, v] of Object.entries(res?.urls ?? {})) out.set(k, v);
  }));
  return out;
}

/** List objects under a prefix (e.g. `${examId}/${owner}/${kind}/`). */
export async function r2List(prefix: string): Promise<R2ListedObject[] | null> {
  const objects = new Map<string, R2ListedObject>();
  const seenTokens = new Set<string>();
  let continuationToken: string | undefined;
  do {
    const res = await invoke<{ objects: R2ListedObject[]; nextContinuationToken?: string | null }>({
      op: "list", prefix, ...(continuationToken ? { continuationToken } : {}),
    });
    // Never present a partial list as a complete exam if a later page failed.
    if (!res?.objects) return null;
    for (const object of res.objects) objects.set(object.key, object);
    continuationToken = res.nextContinuationToken || undefined;
    if (continuationToken) {
      if (seenTokens.has(continuationToken)) return null;
      seenTokens.add(continuationToken);
    }
  } while (continuationToken);
  return [...objects.values()];
}

/**
 * Read one object's BYTES via the edge function (base64 relay).
 *
 * Unlike a presigned GET, the response is same-origin (the function adds CORS
 * headers), so callers can decode it into an ImageBitmap / canvas without
 * tainting it. Required for PDF report thumbnails and zip export — direct
 * presigned-R2 fetches break canvas readback when the bucket lacks CORS.
 * Returns null when unavailable.
 */
export async function r2FetchData(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const res = await invoke<{ data: string; contentType: string }>({ op: "fetch-data", key });
  if (!res?.data) return null;
  try {
    const binary = atob(res.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, contentType: res.contentType ?? "application/octet-stream" };
  } catch (err) {
    console.warn("[r2Function] fetch-data decode failed:", err);
    return null;
  }
}

/**
 * List the IMMEDIATE sub-folders under a prefix (R2 CommonPrefixes). Pass ""
 * for the top-level exam folders, "<exam>/" for the students of one exam, or
 * "<exam>/<roll>/" for the kind folders of one candidate. Entries include the
 * trailing slash: ["Test-3/", "Midterm/"]. Returns null on failure.
 */
export async function r2ListFolders(prefix: string): Promise<string[] | null> {
  const res = await invoke<{ folders: string[] }>({ op: "folders", prefix });
  return res?.folders ?? null;
}
