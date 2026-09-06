import type { getSupabase } from "./supabase";

export type InvokeError = { status?: number; message: string; body?: unknown };

/** Parse a supabase-js functions.invoke error into { status, message, body }. */
export async function parseInvokeError(error: unknown): Promise<InvokeError> {
  const anyErr = error as { context?: { status?: number; json?: () => Promise<unknown> }; message?: string };
  const context = anyErr?.context;
  const status = typeof context?.status === "number" ? context.status : undefined;
  if (context && typeof context.json === "function") {
    try {
      const body = await context.json();
      const msg = (body as { error?: string } | null)?.error;
      return { status, message: msg || anyErr?.message || "Upload failed", body };
    } catch {
      // fall through to message parsing below
    }
  }
  const raw = anyErr?.message || "Upload failed";
  let message = raw;
  if (raw.includes("{") && raw.includes("}")) {
    try { message = (JSON.parse(raw) as { error?: string }).error || raw; } catch { /* keep raw */ }
  }
  return { status, message, body: raw };
}

/**
 * Invoke mobile-upload with backoff retries. Only TRANSIENT failures are
 * retried: transport errors (no HTTP status — the request never completed, so
 * the session row is untouched) and 5xx server errors. 4xx responses are
 * definitive (bad/used/expired token) and fail immediately — retrying cannot
 * fix them.
 */
export async function invokeMobileUploadWithRetry(
  db: NonNullable<ReturnType<typeof getSupabase>>,
  formData: FormData,
  maxAttempts = 3,
  onAttempt?: (attempt: number, total: number) => void,
  backoffMs = 1200,
): Promise<{ ok: true } | { ok: false; error: InvokeError }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, backoffMs * (attempt - 1)));
    onAttempt?.(attempt, maxAttempts);
    const { error } = await db.functions.invoke("mobile-upload", { body: formData });
    if (!error) return { ok: true };
    const parsed = await parseInvokeError(error);
    const retryable = parsed.status === undefined || parsed.status >= 500;
    if (!retryable || attempt === maxAttempts) return { ok: false, error: parsed };
  }
  return { ok: false, error: { message: "Upload failed" } };
}