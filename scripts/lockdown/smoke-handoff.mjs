// Smoke test for the exam handoff: does clicking "Enter exam" really put the
// candidate on the exam's first system check — with no login page and no
// role-picker landing page?
//
// The kiosk window is excluded from screen capture on purpose, so this script
// does not look at pixels. Instead it uses the one signal the OS still gives
// us: the route and visible text of the app's own webview, read back through
// the Tauri IPC by evaluating JS in the running instance.
//
// Requires the packaged app installed at /Applications (or pass a path) and
// the app's window to be reachable via the `lockdown_probe_route` command
// exposed in dev builds.
//
// Usage:
//   npm run tauri:dev                              # in one terminal
//   node scripts/lockdown/smoke-handoff.mjs        # in another
// The probe command only exists in dev builds, so this must run against
// `tauri:dev` — it verifies the web-layer flow (deep link → session → route),
// which is what regresses. Binary-level behaviour is covered by CI builds.

import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

const args = process.argv.slice(2);
const appPath = valueOf("--app") ?? "/Applications/Vignan Exam Browser.app";
const link = valueOf("--link") ?? "vignan-exam://open?exam=smoke-probe&roll=21VGN0314";

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1] ?? null;
}

const BINARY = `${appPath}/Contents/MacOS/vignan-lockdown`;

/** Candidate routes that must never appear on a candidate's screen. */
const FORBIDDEN = [
  { pattern: /vantage points/i, label: "landing / role-picker page" },
  { pattern: /select your role/i, label: "role switcher" },
  { pattern: /registration number|password/i, label: "credential form" },
  { pattern: /install vignan exam browser/i, label: "install gate" },
];

const PROBE_FILE = "/tmp/vignan_probe.json";

async function main() {
  await run("/usr/bin/pkill", ["-f", "vignan-lockdown"]).catch(() => {});
  await rm(PROBE_FILE);
  await new Promise((r) => setTimeout(r, 800));

  // Cold launch exactly the way the OS does it for a deep link: the URL is
  // delivered to the app, so any deviation from the exam check is the app's.
  await run("/usr/bin/open", [link]).catch(() => {});
  await new Promise((r) => setTimeout(r, 9000));

  const probe = await readProbe();
  if (!probe) {
    console.error("PROBE UNAVAILABLE — the dev-build probe never reported.");
    console.error(`  expected: ${PROBE_FILE}`);
    console.error(`  binary:   ${BINARY}`);
    console.error("  The probe command exists only in dev builds. Run the app with:");
    console.error("    npm run tauri:dev");
    process.exit(2);
  }

  console.log(`route: ${probe.route}`);
  console.log(`title: ${probe.title}`);
  const text = probe.text ?? "";

  const failures = FORBIDDEN.filter((f) => f.pattern.test(text));
  for (const f of failures) console.error(`FORBIDDEN SURFACE: ${f.label}`);

  const onExam = /\/student\/exam/.test(probe.route) && /system readiness check/i.test(text);
  if (!onExam) console.error("NOT ON THE EXAM CHECK — expected /student/exam + 'System readiness check'");

  if (failures.length || !onExam) {
    console.error("--- visible text ---");
    console.error(text.slice(0, 800));
    process.exit(1);
  }

  console.log("PASS: deep link landed directly on the exam system check (no login, no landing page).");
}

async function readProbe() {
  try {
    return JSON.parse(await readFile(PROBE_FILE, "utf8"));
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
