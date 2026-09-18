import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import ErrorPage from './pages/ErrorPage.tsx'
import * as Sentry from "@sentry/react";
import LogRocket from 'logrocket';

const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN?.replace(/^["']|["']$/g, '');
const LOGROCKET_ID = import.meta.env.VITE_LOGROCKET_ID?.replace(/^["']|["']$/g, '');

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
      
      // Note: In a real app we'd also sanitize JWTs/tokens from event.breadcrumbs/event.request here
      // if they sneak in despite sendDefaultPii: false.
      
      return event;
    }
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

// Lockdown desktop boot: when running inside the Tauri kiosk exe, skip every
// landing/onboarding screen and drop the student straight into the exam. The
// Tauri webview may serve the bundle at "/" or "/index.html", so match both and
// simply redirect whenever we're not already on the exam entry path.
const inTauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
const entry = import.meta.env.VITE_EXAM_ENTRY_PATH ?? "/student/exam";
const onOnboarding = window.location.pathname === "/" || /\/index\.html?$/i.test(window.location.pathname);

// Deep-link params from the vignan-exam:// launch. The kiosk hands us the
// original URL (via the `vignan_launch_url` command / `vignan-deeplink` event);
// merge its exam & roll into the entry path so the exam page opens preloaded.
function applyDeeplink(url: string) {
  try {
    const u = new URL(url);
    const exam = u.searchParams.get("exam");
    if (!exam) return;
    const roll = u.searchParams.get("roll");
    const target = `/student/exam?examId=${encodeURIComponent(exam)}${roll ? `&roll=${encodeURIComponent(roll)}` : ""}`;
    if (window.location.pathname + window.location.search !== target) {
      window.history.replaceState(null, "", target);
    }
  } catch {
    // Not a parseable launch URL — ignore.
  }
}

if (inTauri && onOnboarding && window.location.pathname !== entry) {
  window.history.replaceState(null, "", entry);
}

// Wire the live deep-link channel AFTER boot so warm starts (exam opened again
// while the kiosk is running) navigate straight to the new exam.
if (inTauri) {
  void import("./lib/lockdownBridge").then(({ onVignanDeepLink }) => {
    onVignanDeepLink((url) => {
      applyDeeplink(url);
      if (window.location.pathname !== entry) {
        window.history.replaceState(null, "", entry);
      }
      // Re-run the router on the (possibly replaced) URL.
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
  });
}

// Cold start inside the kiosk: fetch the launch URL the shell persisted, merge
// its exam/roll into the entry path, THEN mount React so the first render
// already points at the right exam (no flash of wrong content).
if (inTauri) {
  void import("./lib/lockdownBridge")
    .then(({ getLaunchUrl }) => getLaunchUrl())
    .then((url) => {
      if (url) applyDeeplink(url);
    })
    .catch(() => undefined)
    .finally(() => mount());
} else {
  mount();
}

import { AuthProvider } from './lib/auth'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const queryClient = new QueryClient()

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
