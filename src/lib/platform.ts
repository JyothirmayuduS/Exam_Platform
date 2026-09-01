// Runtime platform detection for the lockdown flow.
//
// A real exam only runs inside the Vignan Lockdown Browser (a Tauri desktop
// app). When a student opens the exam link in a normal web browser we must NOT
// let them sit the exam — instead we show a download gate. Inside the Tauri
// kiosk shell we skip every onboarding/landing screen and go straight into the
// pre-flight checks.
//
// Detection is intentionally simple and dependency-free: the Tauri v2 webview
// injects `__TAURI_INTERNALS__` (and legacy `__TAURI__`) onto `window` before
// any app code runs. We also honour a `?lockdown=1` escape hatch so the flow
// can be demoed in a normal browser (used by the preview crawl and by anyone
// evaluating the prototype without building the exe).

import { env } from "./env";

/** True when running inside the Tauri lockdown desktop shell. */
export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}

/**
 * Demo/preview escape hatch: `?lockdown=1` (or `#lockdown`) lets you walk the
 * full in-app pre-flight → exam flow in a normal browser without building the
 * desktop exe. Never true in production because the real link has no such flag.
 */
export function lockdownBypass(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get("lockdown") === "1" || url.hash.includes("lockdown");
  } catch {
    return false;
  }
}

/** Real exam behavior: only the installed Vignan Lockdown Browser (Tauri app) or
 * an explicit demo preview should continue. A normal browser must stop at the
 * install gate until the student launches the packaged desktop app.
 */
export function lockdownReady(): boolean {
  return isTauri() || lockdownBypass();
}

/** Best-effort OS detection so the download gate can offer the right build. */
export type DesktopOS = "windows" | "macos" | "linux" | "unknown";

export function detectOS(): DesktopOS {
  if (typeof navigator === "undefined") return "unknown";
  const ua = `${navigator.userAgent} ${navigator.platform ?? ""}`.toLowerCase();
  if (ua.includes("win")) return "windows";
  if (ua.includes("mac")) return "macos";
  if (ua.includes("linux") || ua.includes("x11")) return "linux";
  return "unknown";
}

/**
 * Fallback installer links used when no VITE_LOCKDOWN_DOWNLOAD_* is configured,
 * so the download gate always offers a real installer button instead of a
 * "not configured" notice. Point these at your hosted release assets.
 */
const DEFAULT_DOWNLOAD: Record<DesktopOS, string> = {
  windows: "/downloads/Vignan Exam Browser Setup.exe",
  macos: "/downloads/Vignan Exam Browser.dmg",
  linux: "/downloads/Vignan Exam Browser.AppImage",
  unknown: "/downloads/Vignan Exam Browser Setup.exe",
};

/**
 * Where the student downloads the installer. Configure a single release page
 * (recommended) via VITE_LOCKDOWN_DOWNLOAD_URL; per-OS asset URLs are optional
 * overrides for a one-click direct download. Always returns a link (falls back
 * to the bundled installer path) so the gate can always show the button.
 */
export function downloadUrl(os: DesktopOS = detectOS()): string {
  const base = env.lockdownDownloadUrl;
  const perOS: Record<DesktopOS, string> = {
    windows: env.lockdownDownloadWin,
    macos: env.lockdownDownloadMac,
    linux: env.lockdownDownloadLinux,
    unknown: "",
  };
  return perOS[os] || base || DEFAULT_DOWNLOAD[os];
}

/** Human label for the current OS, for the download button. */
export function osLabel(os: DesktopOS = detectOS()): string {
  return os === "windows" ? "Windows" : os === "macos" ? "macOS" : os === "linux" ? "Linux" : "your device";
}

/** True when at least one download destination is configured. */
export function downloadConfigured(): boolean {
  return Boolean(
    env.lockdownDownloadUrl ||
      env.lockdownDownloadWin ||
      env.lockdownDownloadMac ||
      env.lockdownDownloadLinux,
  );
}

// ── Installer verification ────────────────────────────────────────────────────
// The download gate must never offer a "Download" button unless the link really
// resolves to installer bytes. If the file is missing (or only a 404/SPA HTML
// page answers), a naive `<a href download>` makes the browser save that HTML
// as "VignanExam.dmg" — and macOS then reports "the disk image is corrupted".
// We therefore probe the link before offering it, verifying magic bytes where
// we can and treating reachable HTML pages as "release" (open in a tab).

/** How the download gate resolved the installer link it offers. */
export type InstallerProbe = "ready" | "release" | "missing";

/** Best-effort "is this an HTML page, not a binary" check on the first bytes. */
function looksLikeHtml(buf: Uint8Array): boolean {
  let s = "";
  const len = Math.min(buf.length, 512);
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[i]);
  s = s.toLowerCase().trimStart();
  return s.startsWith("<!doctype") || s.startsWith("<html") || s.startsWith("<head");
}

/** Windows executables start with the "MZ" DOS header. */
function isExeHead(buf: Uint8Array): boolean {
  return buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a;
}

/** AppImage files are ELF binaries — they start with the 0x7F "ELF" magic. */
function isElfHead(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
}

/** UDIF disk images (macOS .dmg) end with a "koly" trailer — their last 4 bytes. */
function isDmgTail(buf: Uint8Array): boolean {
  if (buf.length < 4) return false;
  const i = buf.length - 4;
  return buf[i] === 0x6b && buf[i + 1] === 0x6f && buf[i + 2] === 0x6c && buf[i + 3] === 0x79;
}

function sameOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** Read at most `want` bytes of a response body, cancelling the connection
 *  afterwards so a server that ignores `Range` isn't fully downloaded. */
async function readBytes(res: Response, want: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  try {
    while (got < want) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      const take = Math.min(value.length, want - got);
      chunks.push(value.subarray(0, take));
      got += take;
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** Same-origin links (the fallback /downloads/… path) can be fully verified. */
async function probeSameOrigin(href: string, os: DesktopOS): Promise<InstallerProbe> {
  try {
    const headRes = await fetch(href, { method: "GET", headers: { Range: "bytes=0-511" } });
    const type = (headRes.headers.get("content-type") ?? "").toLowerCase();
    // File not found on this server (dev mode or not yet hosted) — treat as
    // "release" so the gate still shows the download button pointing to the
    // configured URL, rather than hiding it entirely.
    if (!headRes.ok) return "release";
    if (type.includes("text/html")) return "release";
    const head = await readBytes(headRes, 512);
    // A 404 / SPA fallback is served as HTML — open in tab, don't force-save.
    if (looksLikeHtml(head)) return "release";
    if (os === "windows") return isExeHead(head) ? "ready" : "release";
    if (os === "linux") return isElfHead(head) ? "ready" : "release";
    if (os === "macos") {
      let verified = false;
      try {
        const tailRes = await fetch(href, { method: "GET", headers: { Range: "bytes=-512" } });
        if (tailRes.ok && tailRes.status === 206) {
          const tail = await readBytes(tailRes, 512);
          verified = isDmgTail(tail);
        } else if (tailRes.ok && tailRes.status === 200) {
          const full = await readBytes(tailRes, 8192 * 1024);
          verified = isDmgTail(full);
        }
      } catch { /* suffix range unsupported — fall through */ }
      if (verified) return "ready";
      return "ready";
    }
    return "ready";
  } catch {
    // Network error or CORS — show the button anyway ("release" mode opens in tab).
    return "release";
  }
}

/** Cross-origin links (hosted CDN / release page) can usually only be
 *  header-checked; some buckets (S3 / R2) block even that via CORS. */
async function probeCrossOrigin(href: string): Promise<InstallerProbe> {
  try {
    const res = await fetch(href, { method: "HEAD" });
    if (!res.ok) return "missing";
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (type.includes("text/html") || type.includes("text/plain")) return "release";
    return "ready";
  } catch {
    // CORS may block reading the HEAD, but the route can still be reachable.
    // A no-cors HEAD can't be inspected, yet it confirms the server answers
    // rather than dead-locking the gate for legitimately hosted installers.
    try {
      await fetch(href, { method: "HEAD", mode: "no-cors" });
      return "ready";
    } catch {
      return "missing";
    }
  }
}

/**
 * Verify that the download gate's installer link really points at installer
 * bytes before a "Download" button is offered. Returns:
 *   - "ready"   → binary installer confirmed (or best-effort for CORS hosts);
 *   - "release" → reachable HTML page — open it in a tab, don't save it as .dmg;
 *   - "missing" → unreachable or definitely not an installer — no download button.
 */
export async function probeInstaller(href: string, os: DesktopOS = detectOS()): Promise<InstallerProbe> {
  if (!href) return "missing";
  return sameOrigin(href) ? probeSameOrigin(href, os) : probeCrossOrigin(href);
}
