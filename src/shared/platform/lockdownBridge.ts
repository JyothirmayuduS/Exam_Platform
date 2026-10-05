// Bridge between the Vignan lockdown kiosk (Tauri shell) and the web layer.
//
// The shell hands the web app the original `vignan-exam://open?exam=…&roll=…`
// launch URL through `vignan_launch_url` and the deep-link plugin's
// `deep-link://new-url` event. macOS delivers both cold and warm links as OS
// events, not process arguments, so subscribe BEFORE reading the current URL.
// Native subscriptions degrade to a no-op in a normal browser.

type Unlisten = () => void;

/** The minimum Supabase session data needed to open the native app without a second login. */
export type LaunchSession = { access_token: string; refresh_token: string };

function inKiosk(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/** Cold-start launch URL, or null when unavailable / not in the kiosk. */
export async function getLaunchUrl(): Promise<string | null> {
  if (!inKiosk()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const url = await invoke<string | null>("vignan_launch_url");
    return url ?? null;
  } catch {
    return null;
  }
}

/** Subscribe to OS open-URL events, including late-arriving macOS cold starts. */
export async function onVignanDeepLink(cb: (url: string) => void): Promise<Unlisten> {
  if (!inKiosk()) return () => {};
  const unlisteners: Unlisten[] = [];
  const dispose = () => unlisteners.forEach((unlisten) => unlisten());
  try {
    const { listen } = await import("@tauri-apps/api/event");
    unlisteners.push(await listen<string[]>("deep-link://new-url", (e) => {
      for (const url of e.payload) cb(url);
    }));
    // Retain compatibility with shells that emit the old custom event.
    unlisteners.push(await listen<string>("vignan-deeplink", (e) => cb(e.payload)));
    return dispose;
  } catch {
    dispose();
    return () => {};
  }
}

/** Only exam launch links may change the kiosk route; the roll is not auth. */
export function examPathFromDeepLink(url: string, entry = "/student/exam"): string | null {
  try {
    const link = new URL(url);
    const exam = link.searchParams.get("exam");
    if (link.protocol !== "vignan-exam:" || link.hostname !== "open" || !exam?.trim()) return null;
    const roll = link.searchParams.get("roll");
    // The entry MUST be an absolute path. A relative one (e.g. "" from a blank
    // VITE_EXAM_ENTRY_PATH) resolves against whatever route happens to be
    // current, which is how a deep link ended up at /login?examId=… instead of
    // the exam. Fall back to the real exam route rather than misroute.
    const base = entry.trim().startsWith("/") ? entry.trim() : "/student/exam";
    return `${base}?examId=${encodeURIComponent(exam)}${roll ? `&roll=${encodeURIComponent(roll)}` : ""}`;
  } catch {
    return null;
  }
}

/**
 * Read the short-lived session handoff kept in the deep-link fragment. The
 * fragment is not sent to a web server, but is available to the native app so
 * it can restore the student's existing browser session without another login.
 *
 * The OS may percent-encode the URL it forwards (`#access_token=…` arrives as
 * `%23access_token=…` on Windows), so normalise before parsing.
 */
function sessionFromDeepLink(url: string): LaunchSession | null {
  try {
    const link = new URL(url.replace(/%23/, "#"));
    const read = (key: string) => {
      // First the fragment, then the query — some shells move it.
      const fromHash = link.hash ? new URLSearchParams(link.hash.slice(1)).get(key) : null;
      return fromHash ?? link.searchParams.get(key);
    };
    const accessToken = read("access_token");
    const refreshToken = read("refresh_token");
    return accessToken && refreshToken ? { access_token: accessToken, refresh_token: refreshToken } : null;
  } catch {
    return null;
  }
}

/** True when this launch can restore a browser session in the native webview. */
export function hasSessionHandoff(url: string): boolean {
  return sessionFromDeepLink(url) !== null;
}

/** Why a session restore did not happen. */
export type HydrateFailure = "not-kiosk" | "no-handoff" | "no-backend" | "rejected" | "error";

/**
 * Restore the browser's student session inside the native webview. The result
 * distinguishes "nothing to do" (no handoff) from a real failure so the kiosk
 * can decide between staying on the exam and falling back to the dashboard.
 */
export async function hydrateSessionFromDeepLink(url: string): Promise<{ ok: boolean; reason?: HydrateFailure }> {
  const session = sessionFromDeepLink(url);
  if (!session) return { ok: false, reason: "no-handoff" };
  if (!inKiosk()) return { ok: false, reason: "not-kiosk" };
  try {
    const { getSupabase } = await import("@/shared/data/supabase");
    const db = getSupabase();
    if (!db) return { ok: false, reason: "no-backend" };
    const { error } = await db.auth.setSession(session);
    return error ? { ok: false, reason: "rejected" } : { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/** Open the normal student console after the native exam closes. */
export async function openStudentSide(path = "/student/exams"): Promise<boolean> {
  const base = (import.meta.env.VITE_APP_BASE_URL ?? "").replace(/\/$/, "");
  const fallback = typeof window !== "undefined" && /^https?:$/i.test(window.location.protocol)
    ? window.location.origin
    : "http://localhost:5173";
  const url = `${base || fallback}${path.startsWith("/") ? path : `/${path}`}`;
  if (!inKiosk()) {
    window.location.assign(url);
    return true;
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_student_side", { url });
    return true;
  } catch {
    return false;
  }
}

/**
 * Request the OS handler synchronously in the click gesture (never after an
 * await/timer). Browsers cannot confirm installation; offer a retry when the
 * page stays visible, and stop the fallback if the student switches to the app.
 */
export function launchExamInLockdown(examId: string, roll: string, onUnconfirmed: () => void, session?: LaunchSession | null): Unlisten {
  const url = `vignan-exam://open?exam=${encodeURIComponent(examId)}${roll ? `&roll=${encodeURIComponent(roll)}` : ""}${session?.access_token && session.refresh_token ? `#access_token=${encodeURIComponent(session.access_token)}&refresh_token=${encodeURIComponent(session.refresh_token)}` : ""}`;
  const dispose = () => {
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") dispose();
  };
  const timer = window.setTimeout(() => {
    dispose();
    if (document.visibilityState !== "hidden") onUnconfirmed();
  }, 3000);
  document.addEventListener("visibilitychange", onVisibilityChange);
  try {
    window.location.assign(url);
  } catch {
    dispose();
    onUnconfirmed();
  }
  return dispose;
}

/** Lockdown shell notices: blocked conditions and informational pings. */
export type LockdownNotice =
  | { kind: "prohibited-apps"; apps: string }
  | { kind: "vm-detected" }
  | { kind: "quit-attempted" }
  | { kind: "capture-visible" };

export async function onLockdownNotice(cb: (n: LockdownNotice) => void): Promise<Unlisten> {
  if (!inKiosk()) return () => {};
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const un1 = await listen<string>("lockdown:prohibited-apps", (e) =>
      cb({ kind: "prohibited-apps", apps: String(e.payload ?? "") }),
    );
    const un2 = await listen<null>("lockdown:vm-detected", () => cb({ kind: "vm-detected" }));
    const un3 = await listen<null>("lockdown:quit-attempted", () => cb({ kind: "quit-attempted" }));
    const un4 = await listen<null>("lockdown:capture-visible", () => cb({ kind: "capture-visible" }));
    return () => {
      un1();
      un2();
      un3();
      un4();
    };
  } catch {
    return () => {};
  }
}

// ── Native media permissions (kiosk only) ────────────────────────────────────

/**
 * Ask the shell about the OS-level camera/microphone permission.
 * Returns "granted" | "denied" | "prompt" | "unavailable", or null outside
 * the kiosk (a browser re-prompts on its own via getUserMedia).
 */
export async function mediaPermissionStatus(kind: "camera" | "microphone"): Promise<"granted" | "denied" | "prompt" | "unavailable" | null> {
  if (!inKiosk()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<"granted" | "denied" | "prompt" | "unavailable">("media_permission_prompt", { kind });
  } catch {
    return null;
  }
}

/** Open the OS privacy pane (System Settings / Windows Settings) for camera, microphone, or screen recording. */
export async function openMediaSettings(kind: "camera" | "microphone" | "screen"): Promise<boolean> {
  if (!inKiosk()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_media_settings", { kind });
    return true;
  } catch {
    return false;
  }
}

/** True when the OS confirmed the exam window is excluded from screen capture. */
export async function isScreenCaptureExcluded(): Promise<boolean> {
  if (!inKiosk()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("screen_capture_excluded");
  } catch {
    return false;
  }
}

type MediaAnswer = "granted" | "denied" | "prompt";

/** Show the native camera/microphone dialog if undecided and wait for the answer. */
export async function requestMediaAccess(kind: "camera" | "microphone"): Promise<MediaAnswer | null> {
  if (!inKiosk()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<MediaAnswer>("request_media_access", { kind });
  } catch {
    return null;
  }
}

/** Screen Recording permission without prompting. */
export async function screenCaptureStatus(): Promise<"granted" | "denied" | null> {
  if (!inKiosk()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<"granted" | "denied">("screen_capture_status");
  } catch {
    return null;
  }
}

/**
 * Lower the kiosk window so macOS permission dialogs and System Settings show
 * in front of it. Always pair with endPermissionPhase.
 */
export async function beginPermissionPhase(): Promise<void> {
  if (!inKiosk()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("begin_permission_phase");
  } catch {
    /* not available in this shell build */
  }
}

export async function endPermissionPhase(): Promise<void> {
  if (!inKiosk()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("end_permission_phase");
  } catch {
    /* not available in this shell build */
  }
}

export const RESUME_PATH_KEY = "vignan.resumePath";

/**
 * Restart the exam browser so a new Screen Recording grant takes effect, then
 * return to the current page.
 */
export async function relaunchExamBrowser(): Promise<void> {
  if (!inKiosk()) return;
  try {
    localStorage.setItem(
      RESUME_PATH_KEY,
      JSON.stringify({ path: location.pathname + location.search, at: Date.now() }),
    );
  } catch {
    /* storage unavailable: the relaunch still lands on the login page */
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("relaunch_app");
}

/** Check and request the native macOS screen recording permission. */
export async function screenCapturePermissionStatus(): Promise<"granted" | "denied" | "prompt" | null> {
  if (!inKiosk()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<"granted" | "denied" | "prompt">("screen_capture_permission_prompt");
  } catch {
    return null;
  }
}
