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
    return `${entry}?examId=${encodeURIComponent(exam)}${roll ? `&roll=${encodeURIComponent(roll)}` : ""}`;
  } catch {
    return null;
  }
}

/**
 * Read the short-lived session handoff kept in the deep-link fragment. The
 * fragment is not sent to a web server, but is available to the native app so
 * it can restore the student's existing browser session without another login.
 */
function sessionFromDeepLink(url: string): LaunchSession | null {
  try {
    const link = new URL(url);
    const accessToken = link.hash ? new URLSearchParams(link.hash.slice(1)).get("access_token") : null;
    const refreshToken = link.hash ? new URLSearchParams(link.hash.slice(1)).get("refresh_token") : null;
    return accessToken && refreshToken ? { access_token: accessToken, refresh_token: refreshToken } : null;
  } catch {
    return null;
  }
}

/** True when this launch can restore a browser session in the native webview. */
export function hasSessionHandoff(url: string): boolean {
  return sessionFromDeepLink(url) !== null;
}

/** Restore the browser's student session inside the native webview. */
export async function hydrateSessionFromDeepLink(url: string): Promise<boolean> {
  const session = sessionFromDeepLink(url);
  if (!session || !inKiosk()) return false;
  try {
    const { getSupabase } = await import("./supabase");
    const db = getSupabase();
    if (!db) return false;
    const { error } = await db.auth.setSession(session);
    return !error;
  } catch {
    return false;
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

/** Lockdown shell notices: prohibited-app detection, VM detection. */
export type LockdownNotice = { kind: "prohibited-apps"; apps: string } | { kind: "vm-detected" };

export async function onLockdownNotice(cb: (n: LockdownNotice) => void): Promise<Unlisten> {
  if (!inKiosk()) return () => {};
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const un1 = await listen<string>("lockdown:prohibited-apps", (e) =>
      cb({ kind: "prohibited-apps", apps: String(e.payload ?? "") }),
    );
    const un2 = await listen<null>("lockdown:vm-detected", () => cb({ kind: "vm-detected" }));
    return () => {
      un1();
      un2();
    };
  } catch {
    return () => {};
  }
}
