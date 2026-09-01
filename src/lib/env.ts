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

export const env = {
  supabaseUrl: rawUrl,
  supabaseAnonKey: rawKey,
  livekitUrl: import.meta.env.VITE_LIVEKIT_URL ?? "",
  examEntryPath: import.meta.env.VITE_EXAM_ENTRY_PATH ?? "/student/exam",
  // When "true", the exam captures a proctoring screenshot every second and
  // uploads it to R2 via the store-artifact edge function. Off by default so
  // the prototype doesn't attempt uploads without a backend.
  proctorCapture: (import.meta.env.VITE_PROCTOR_CAPTURE ?? "") === "true",
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

/** True when a LiveKit server URL is set (token still minted server-side). */
export const livekitConfigured =
  !!env.livekitUrl && !env.livekitUrl.includes("your-project");
