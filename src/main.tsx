import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'

// Lockdown desktop boot: when running inside the Tauri kiosk exe, skip every
// landing/onboarding screen and drop the student straight into the exam. The
// Tauri webview may serve the bundle at "/" or "/index.html", so match both and
// simply redirect whenever we're not already on the exam entry path.
const inTauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
const entry = import.meta.env.VITE_EXAM_ENTRY_PATH ?? "/student/exam";
const onOnboarding = window.location.pathname === "/" || /\/index\.html?$/i.test(window.location.pathname);
if (inTauri && onOnboarding && window.location.pathname !== entry) {
  window.history.replaceState(null, "", entry);
}

import { AuthProvider } from './lib/auth'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
