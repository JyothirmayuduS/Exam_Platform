// Bridge between the Vignan lockdown kiosk (Tauri shell) and the web layer.
//
// The shell hands the web app the original `vignan-exam://open?exam=…&roll=…`
// launch URL two ways:
//   1. Cold start — `vignan_launch_url` command returns the URL the OS used to
//      start the app (persisted by the shell before the webview loaded).
//   2. Warm start — a `vignan-deeplink` event fires on the webview when the OS
//      re-opens the scheme while the kiosk is already running.
//
// Everything degrades to a no-op outside the kiosk (normal browser), so this
// module is safe to import unconditionally.

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

/** Subscribe to warm-start deep links fired by the kiosk shell. */
export async function onVignanDeepLink(cb: (url: string) => void): Promise<Unlisten> {
  if (!inKiosk()) return () => {};
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<string>("vignan-deeplink", (e) => cb(e.payload));
  } catch {
    return () => {};
  }
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
