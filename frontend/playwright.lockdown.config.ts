import { defineConfig, devices } from "@playwright/test";

// Isolated, no-backend browser smoke suite. Explicit env values override local
// .env files so tests never authenticate, record students or send analytics.
export default defineConfig({
  testDir: "./tests-e2e",
  testMatch: "lockdown-install.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report/lockdown", open: "never" }]],
  outputDir: "test-results/lockdown",
  use: { baseURL: "http://127.0.0.1:5178", screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5178 --strictPort",
    url: "http://127.0.0.1:5178",
    reuseExistingServer: false,
    env: {
      VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "", VITE_LIVEKIT_URL: "",
      VITE_SENTRY_DSN: "", VITE_LOGROCKET_ID: "",
      VITE_LOCKDOWN_DOWNLOAD_URL: "", VITE_LOCKDOWN_DOWNLOAD_MAC: "",
      VITE_LOCKDOWN_DOWNLOAD_WIN: "", VITE_LOCKDOWN_DOWNLOAD_LINUX: "",
    },
  },
});
