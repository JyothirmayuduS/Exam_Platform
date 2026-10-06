// Opt-in REAL browser -> installed native-app launch check. Opens a fullscreen
// kiosk briefly; never run during an exam. No student sign-in/camera access.
// Uses an isolated browser profile with remembered approval for this localhost
// scheme only; it does not bypass Gatekeeper or change a personal browser.
import { chromium } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

if (process.platform !== "darwin" || !process.argv.includes("--allow-kiosk")) {
  throw new Error("macOS only. Explicitly pass --allow-kiosk on a designated test device.");
}
const app = process.env.LOCKDOWN_TEST_APP ?? join(homedir(), "Applications/Vignan Exam Browser.app");
const executable = join(app, "Contents/MacOS/vignan-lockdown");
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = `^${escape(executable)}( |$)`;
const watchdogPattern = `^${escape(join(app, "Contents/MacOS/vignan-watchdog"))}( |$)`;
function pids() {
  try { return execFileSync("/usr/bin/pgrep", ["-f", pattern], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean); }
  catch { return []; }
}
function stopApp() {
  // Stop only this installed test app's watchdog FIRST, otherwise it restarts
  // a deliberately terminated kiosk. Never kill by a generic application name.
  for (const re of [watchdogPattern, pattern]) {
    try { execFileSync("/usr/bin/pkill", ["-TERM", "-f", re]); } catch { /* already exited */ }
  }
}
await access(executable);
assert.equal(pids().length, 0, "Refusing to interrupt an already-running installed exam");
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
execFileSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", app]);
const profile = await mkdtemp(join(tmpdir(), "vignan-chrome-smoke-"));
await mkdir(join(profile, "Default"));
const origin = "http://127.0.0.1:5179";
await writeFile(join(profile, "Default/Preferences"), JSON.stringify({
  protocol_handler: { allowed_origin_protocol_pairs: { [origin]: { "vignan-exam": true } } },
}));
const server = spawn(process.execPath, [resolve("node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", "5179", "--strictPort"], {
  env: { ...process.env, VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "", VITE_LIVEKIT_URL: "",
    VITE_SENTRY_DSN: "", VITE_LOGROCKET_ID: "", VITE_LOCKDOWN_DOWNLOAD_URL: "",
    VITE_LOCKDOWN_DOWNLOAD_MAC: "", VITE_LOCKDOWN_DOWNLOAD_WIN: "", VITE_LOCKDOWN_DOWNLOAD_LINUX: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let browser;
// Independent, bounded safety guard survives a stuck browser automation call.
const guard = spawn(process.execPath, ["--input-type=module", "-e", `
  import {execFileSync} from 'node:child_process';
  setTimeout(() => { for (const p of ${JSON.stringify([watchdogPattern, pattern])}) {
    try { execFileSync('/usr/bin/pkill', ['-TERM','-f',p]); } catch {}
  } }, 60000);
`], { stdio: "ignore" });
try {
  for (let i = 0; i < 60; i++) {
    if (server.exitCode != null) throw new Error("Isolated Vite server failed to start");
    if (await fetch(origin).then((r) => r.ok).catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  browser = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: false, viewport: { width: 1000, height: 800 } });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  await page.addInitScript(() => localStorage.setItem("vignan.demo_role", "student"));
  const handoffs = [];
  page.on("console", (msg) => { if (msg.text().includes("Launched external handler")) handoffs.push(msg.text()); });
  await page.goto(`${origin}/student/exam?examId=NATIVE-COLD-SMOKE`);
  await page.getByRole("button", { name: /Done — I've installed it/ }).click();
  for (let i = 0; i < 40 && !pids().length; i++) await new Promise((r) => setTimeout(r, 250));
  const cold = pids();
  assert.equal(cold.length, 1, "Browser click did not launch exactly one installed app process");
  await new Promise((r) => setTimeout(r, 4000));
  assert.deepEqual(pids(), cold, "Native app crashed during startup");
  assert.ok(handoffs.some((s) => s.includes("NATIVE-COLD-SMOKE")), "No actual Chromium OS handoff was observed");
  console.log("PASS: real Chrome installed-click -> registered macOS app; process remains alive");
  await page.goto(`${origin}/student/exam?examId=NATIVE-WARM-SMOKE`);
  await page.getByRole("button", { name: /Done — I've installed it/ }).click();
  await new Promise((r) => setTimeout(r, 3000));
  assert.ok(handoffs.some((s) => s.includes("NATIVE-WARM-SMOKE")), "Warm browser OS handoff not observed");
  assert.deepEqual(pids(), cold, "Warm handoff created another app process or killed the existing one");
  console.log("PASS: warm browser handoff retains the same single native process");
  console.log("LIMIT: no native UI inspection or authenticated exam checked; fresh external-app prompt approval and Apple notarization remain manual.");
} finally {
  stopApp();
  guard.kill();
  await browser?.close();
  server.kill("SIGTERM");
  await rm(profile, { recursive: true, force: true });
}
