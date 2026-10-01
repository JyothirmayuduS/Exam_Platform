// Bridge between the Vignan lockdown kiosk (Tauri shell) and the web layer.
//
// The shell hands the web app the original `vignan-exam://open?exam=…&roll=…`
// launch URL through `vignan_launch_url` and the deep-link plugin's
// `deep-link://new-url` event. macOS delivers both cold and warm links as OS
// events, not process arguments, so subscribe BEFORE reading the current URL.
// Native subscriptions degrade to a no-op in a normal browser.

type Unlisten = () => void;

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
 * Request the OS handler synchronously in the click gesture (never after an
 * await/timer). Browsers cannot confirm installation; offer a retry when the
 * page stays visible, and stop the fallback if the student switches to the app.
 */
export function launchExamInLockdown(examId: string, roll: string, onUnconfirmed: () => void): Unlisten {
  const url = `vignan-exam://open?exam=${encodeURIComponent(examId)}${roll ? `&roll=${encodeURIComponent(roll)}` : ""}`;
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
