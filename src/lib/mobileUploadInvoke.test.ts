import { describe, it, expect, vi } from "vitest";
import { parseInvokeError, invokeMobileUploadWithRetry } from "./mobileUploadInvoke";

const sleep = () => new Promise((r) => setTimeout(r, 0));

/** Fake supabase client whose invoke returns the queued results in order. */
function makeDb(...results: { error: unknown }[]) {
  const invoke = vi.fn();
  results.forEach((r) => invoke.mockResolvedValueOnce(r));
  // After the queued results are consumed, always succeed.
  invoke.mockResolvedValue({ error: null });
  return { db: { functions: { invoke } } as never, invoke };
}

function httpError(status: number, message: string) {
  return {
    message,
    context: {
      status,
      json: async () => ({ error: message }),
    },
  };
}

describe("parseInvokeError", () => {
  it("extracts status + body error from an HTTP function error", async () => {
    const parsed = await parseInvokeError(httpError(403, "Invalid or expired token"));
    expect(parsed.status).toBe(403);
    expect(parsed.message).toBe("Invalid or expired token");
  });

  it("treats a transport error (no context) as having no HTTP status", async () => {
    const parsed = await parseInvokeError({ message: "fetch failed" });
    expect(parsed.status).toBeUndefined();
    expect(parsed.message).toBe("fetch failed");
  });

  it("falls back to parsing a JSON string error message", async () => {
    const parsed = await parseInvokeError({ message: '{"error":"Storage write failed"}' });
    expect(parsed.message).toBe("Storage write failed");
  });
});

describe("invokeMobileUploadWithRetry", () => {
  it("succeeds on the first attempt without retrying", async () => {
    const { db, invoke } = makeDb({ error: null });
    const attempts: number[] = [];
    const res = await invokeMobileUploadWithRetry(db, new FormData(), 3, (n) => attempts.push(n));
    expect(res).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(attempts).toEqual([1]);
  });

  it("retries transport errors and recovers", async () => {
    const { db, invoke } = makeDb(
      { error: { message: "NetworkError" } },
      { error: { message: "NetworkError" } },
      { error: null },
    );
    const res = await invokeMobileUploadWithRetry(db, new FormData(), 3, undefined, 0);
    expect(res).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("retries 5xx errors and recovers", async () => {
    const { db, invoke } = makeDb(
      { error: httpError(500, "Internal Server Error") },
      { error: httpError(500, "Internal Server Error") },
      { error: null },
    );
    const res = await invokeMobileUploadWithRetry(db, new FormData(), 3, undefined, 0);
    expect(res).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a definitive 403 — fails immediately after one attempt", async () => {
    const { db, invoke } = makeDb({ error: httpError(403, "Invalid or expired token") });
    const res = await invokeMobileUploadWithRetry(db, new FormData(), 3, undefined, 0);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.status).toBe(403);
      expect(res.error.message).toBe("Invalid or expired token");
    }
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts when the failure is persistent", async () => {
    const { db, invoke } = makeDb(
      { error: { message: "NetworkError" } },
      { error: { message: "NetworkError" } },
      { error: { message: "NetworkError" } },
    );
    const res = await invokeMobileUploadWithRetry(db, new FormData(), 3, undefined, 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toBe("NetworkError");
    expect(invoke).toHaveBeenCalledTimes(3);
    await sleep(); // let any pending microtasks settle
  });
});