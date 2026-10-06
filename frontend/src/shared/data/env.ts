// Reads Vite env vars once and reports whether the backend is wired up.
// Everything degrades gracefully: if the keys are missing (or still the
// placeholder), the app falls back to its built-in demo data so the prototype
// keeps working without a backend.

const rawUrl = import.meta.env.VITE_SUPABASE_URL ?? "";
const rawKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";

const placeholder = (v: string) =>
  !v ||
  v.includes("YOUR-PROJECT") ||
  v.includes("PASTE_YOUR") ||
  v === "your-anon-public-key";

/**
 * Normalize a LiveKit server URL for `Room.connect`.
 * Accepts `wss://`, `ws://`, or `https://`/`http://` (rewritten to ws), and
 * host-only values like `exam.livekit.cloud` (prefixed with `wss://`).
 * Returns "" when the value is empty, a pull placeholder, or unusable.
 */
export function normalizeLivekitUrl(raw: string | null | undefined): string {
  let v = String(raw ?? "").trim().replace(/^["']|["']$/g, "");
  if (!v) return "";
  if (/^\[.+\]$/.test(v) || v.toLowerCase() === "sensitive") return "";
  if (v.includes("your-project") || v.includes("YOUR-PROJECT") || v.includes("PASTE_YOUR")) return "";
  if (/^https:\/\//i.test(v)) v = `wss://${v.slice("https://".length)}`;
  else if (/^http:\/\//i.test(v)) v = `ws://${v.slice("http://".length)}`;
  else if (!/^wss?:\/\//i.test(v)) {
    // Host-only LiveKit Cloud URLs are common in dashboards — coerce them.
    if (/^[A-Za-z0-9.-]+\.livekit\.cloud\/?$/i.test(v)) v = `wss://${v.replace(/\/$/, "")}`;
    else return "";
  }
  try {
    const u = new URL(v);
    if (u.protocol !== "wss:" && u.protocol !== "ws:") return "";
    if (!u.hostname) return "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

/**
 * Prefer the Edge Function's LIVEKIT_URL when it is a valid ws(s) URL; otherwise
 * fall back to the Vite build-time URL. Prevents a bad/empty server secret from
 * overriding a good client config (the "Failed to construct 'URL'" failure mode).
 */
export function resolveLivekitUrl(...candidates: Array<string | null | undefined>): string {
  for (const c of candidates) {
    const n = normalizeLivekitUrl(c);
    if (n) return n;
  }
  return "";
}

const rawLivekit = import.meta.env.VITE_LIVEKIT_URL ?? "";

export const env = {
  supabaseUrl: rawUrl,
  supabaseAnonKey: rawKey,
  livekitUrl: normalizeLivekitUrl(rawLivekit),
  // An empty or non-absolute VITE_EXAM_ENTRY_PATH is treated as unset — see
  // the same normalisation in main.tsx. Accepting "" here silently routed
  // deep links to a bare "?examId=…" relative path.
  examEntryPath: (() => {
    const configured = (import.meta.env.VITE_EXAM_ENTRY_PATH ?? "").trim();
    return configured.startsWith("/") ? configured : "/student/exam";
  })(),
  // When "true", the exam captures a proctoring screenshot every second and
  // uploads it to R2 via the store-artifact edge function. Off by default so
  // the prototype doesn't attempt uploads without a backend.
  proctorCapture: (import.meta.env.VITE_PROCTOR_CAPTURE ?? "") === "true",
  // Diagnostics overlay for the AI engine. The ?proctorDebug=1 URL override is
  // honored ONLY in dev builds — in production it would let a student watch the
  // live detection boxes / risk scores and tune their cheating to stay under
  // thresholds, so the URL param is ignored there. A production operator can
  // still force it on with the VITE_PROCTOR_DEBUG=1 build-time env var.
  proctorDebug:
    (import.meta.env.VITE_PROCTOR_DEBUG ?? "") === "1" ||
    (import.meta.env.DEV &&
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("proctorDebug")),

  // Where a student in a normal browser downloads the lockdown desktop app.
  // A single release page is enough; the per-OS overrides enable one-click
  // direct downloads when you host the built installers yourself.
  lockdownDownloadUrl: import.meta.env.VITE_LOCKDOWN_DOWNLOAD_URL ?? "",
  lockdownDownloadWin: import.meta.env.VITE_LOCKDOWN_DOWNLOAD_WIN ?? "",
  lockdownDownloadMac: import.meta.env.VITE_LOCKDOWN_DOWNLOAD_MAC ?? "",
  lockdownDownloadLinux: import.meta.env.VITE_LOCKDOWN_DOWNLOAD_LINUX ?? "",
};

/** True only when a real Supabase project + anon key are configured. */
export const supabaseConfigured = !placeholder(rawUrl) && !placeholder(rawKey);

/** True when LiveKit can be reached: the livekit-token function returns the
 *  server URL with each token, so Supabase alone is enough. */
export const livekitConfigured = !!env.livekitUrl || supabaseConfigured;
