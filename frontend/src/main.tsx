import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './shared/components/ErrorBoundary.tsx'
import ErrorPage from './shared/pages/ErrorPage.tsx'
import * as Sentry from "@sentry/react";
import LogRocket from 'logrocket';
import { AuthProvider } from './features/auth/auth'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { examPathFromDeepLink, getLaunchUrl, hasSessionHandoff, hydrateSessionFromDeepLink, LAUNCHED_FROM_LINK_KEY, onVignanDeepLink, RESUME_PATH_KEY } from './shared/platform/lockdownBridge'

const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN?.replace(/^[\"']|[\"']$/g, '');
const LOGROCKET_ID = import.meta.env.VITE_LOGROCKET_ID?.replace(/^[\"']|[\"']$/g, '');

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: import.meta.env.MODE || "development",
    release: "exam-platform@1.0.0",
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration(),
    ],
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    sendDefaultPii: false,
    beforeSend(event, hint) {
      const error = hint.originalException;

      // Drop expected 4xx errors
      if (error && typeof error === 'object' && 'status' in error) {
        const status = (error as any).status;
        if (status >= 400 && status < 500) {
          return null; // Drop this event
        }
      }

      return event;
    },
  });
}

if (LOGROCKET_ID) {
  LogRocket.init(LOGROCKET_ID);
  if (SENTRY_DSN) {
    LogRocket.getSessionURL(sessionURL => {
      Sentry.setExtra("sessionURL", sessionURL);
    });
  }
}

// ── Boot sequence ─────────────────────────────────────────────────────────────
// IMPORTANT: every statement below is a DECLARATION. All side effects happen in
// boot(), called as the module's LAST statement. This ordering is not cosmetic —
// an earlier version called mount() from a mid-module `if` block, BEFORE
// `queryClient` was initialized: in the plain-browser path that mount ran while
// `queryClient` was still in its temporal dead zone, so production rendered
// <QueryClientProvider client={undefined}> and the app white-screened. The
// Tauri path masked it because its async import deferred mount until after
// module evaluation. Keep declarations first, boot last.

// Lockdown desktop boot: when running inside the Tauri kiosk exe, skip every
// landing/onboarding screen and drop the student straight into the exam. The
// Tauri webview may serve the bundle at "/" or "/index.html", so match both and
// simply redirect whenever we're not already on the exam entry path.
const inTauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
// Resolve the kiosk entry path defensively. `??` only falls back for
// null/undefined, so an env file that sets VITE_EXAM_ENTRY_PATH="" (which
// Vercel's CLI writes) made `entry` the EMPTY STRING. That single mistake
// routed a cold start to the bare origin (the marketing landing page) and made
// a deep link resolve to "?examId=…" against whatever path was current — i.e.
// /login?examId=… instead of the exam. Only a real absolute path is honoured.
const entry = (() => {
  const configured = (import.meta.env.VITE_EXAM_ENTRY_PATH ?? "").trim();
  return configured.startsWith("/") ? configured : "/student/exam";
})();
const onOnboarding = window.location.pathname === "/" || /\/index\.html?$/i.test(window.location.pathname);

// Deep-link params from the vignan-exam:// launch. The kiosk hands us the
// original URL (via `vignan_launch_url` / `deep-link://new-url`);
// merge its exam & roll into the entry path so the exam page opens preloaded.
function applyDeeplink(url: string, restoreSession = true) {
  const target = examPathFromDeepLink(url, entry);
  if (!target) return;
  try { sessionStorage.setItem(LAUNCHED_FROM_LINK_KEY, "1"); } catch { /* storage unavailable */ }

  const route = () => {
    if (window.location.pathname + window.location.search === target) return;
    window.history.replaceState(null, "", target);
    // Also notify an already-mounted router (late macOS cold start / warm start).
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  // Warm launches can carry the browser's existing student session. If there
  // is a token handoff, wait for it before routing so StudentExam never has to
  // redirect to /login while the native webview is still hydrating. Legacy
  // links without a handoff keep their synchronous route-update behavior.
  if (restoreSession && hasSessionHandoff(url)) {
    void withTimeout(hydrateSessionFromDeepLink(url), 6000, { ok: false }).finally(route);
  } else {
    if (restoreSession) void hydrateSessionFromDeepLink(url);
    route();
  }
}

const queryClient = new QueryClient();

function mount() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

// Handoff probe: scripts/lockdown/smoke-handoff.mjs cannot see the exam window
// (it is deliberately excluded from screen capture), so when built with
// VITE_VIGNAN_PROBE=1 we report the visible route + text back to Rust, which
// records it to a temp file. Never set in CI, so production installers are
// unaffected.
const probeEnabled = import.meta.env.DEV || import.meta.env.VITE_VIGNAN_PROBE === "1";
if (probeEnabled && inTauri) {
  const report = () => {
    void import("@tauri-apps/api/core")
      .then(({ invoke }) =>
        invoke("lockdown_log_probe", {
          payload: JSON.stringify({
            route: window.location.pathname + window.location.search,
            title: document.title,
            text: (document.body?.innerText ?? "").slice(0, 4000),
            at: new Date().toISOString(),
          }),
        }),
      )
      .catch(() => {});
  };
  window.addEventListener("popstate", () => window.setTimeout(report, 400));
  window.addEventListener("load", () => window.setTimeout(report, 1500));
  window.setTimeout(report, 2000);
}

/** One-shot path saved by relaunchExamBrowser; ignored once older than 10 minutes. */
function takeResumePath(): string | null {
  try {
    const raw = localStorage.getItem(RESUME_PATH_KEY);
    if (!raw) return null;
    localStorage.removeItem(RESUME_PATH_KEY);
    const { path, at } = JSON.parse(raw) as { path?: unknown; at?: unknown };
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return null;
    if (typeof at !== "number" || Date.now() - at > 10 * 60_000) return null;
    return path;
  } catch {
    return null;
  }
}

/** Resolve to `fallback` if `p` has not settled within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => window.setTimeout(() => resolve(fallback), ms))]);
}

async function boot() {
  if (inTauri) {
    // Each step below waits on the native bridge or the network (a session
    // refresh). A stalled one used to leave the kiosk on a blank white page
    // forever, so every step is time-boxed and the app always mounts.
    // Kiosk: land on the exam entry path, subscribe to OS URL events, then
    // read the plugin's current launch URL (if the OS already delivered it).
    if (onOnboarding && window.location.pathname !== entry) {
      window.history.replaceState(null, "", entry);
    }
    try {
      // Await registration BEFORE querying the current URL. Otherwise an OS
      // event between the query and listener registration is lost.
      await withTimeout(onVignanDeepLink(applyDeeplink), 3000, () => {});
      // Cold start: fetch the launch URL the plugin holds in memory, merge its
      // exam/roll into the entry path BEFORE mounting so the first render
      // already points at the right exam (no flash of wrong content).
      const url = await withTimeout(getLaunchUrl().catch(() => null), 3000, null);
      const resume = takeResumePath();
      if (url) {
        await withTimeout(hydrateSessionFromDeepLink(url), 6000, { ok: false });
        applyDeeplink(url, false);
      } else if (resume) {
        // Relaunched by the exam itself (Screen Recording grant): back to it.
        window.history.replaceState(null, "", resume);
      } else {
        // Cold kiosk start with NO vignan-exam:// link: the exam page needs
        // BOTH an exam reference and a signed-in student, and neither exists
        // here. Route to the in-app login (it keeps a return path and no demo
        // shortcuts in production) instead of a dead "cannot load exam" page.
        window.history.replaceState(null, "", "/login?kiosk=1");
      }
    } catch {
      // Bridge unavailable — fall through and mount normally.
    }
  }
  mount();
}

void boot();
