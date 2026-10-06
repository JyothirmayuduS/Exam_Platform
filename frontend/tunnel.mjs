#!/usr/bin/env node
// tunnel.mjs — starts a localtunnel to expose localhost:5173 publicly
// then auto-writes VITE_APP_BASE_URL into .env.local so the QR code works
// from any phone on any network (different WiFi, mobile data, hotspot, etc.)
//
// Usage:
//   npm run tunnel
// Then press Ctrl+C to stop. The URL will be removed from .env.local on exit.

import localtunnel from "localtunnel";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(__dir, ".env.local");
const PORT = 5173;
const SUBDOMAIN = "vignan-exam"; // Requests vignan-exam.loca.lt (not guaranteed, falls back to random)

// ── helpers ───────────────────────────────────────────────────────────────────

function readEnv() {
  try { return readFileSync(ENV_FILE, "utf8"); } catch { return ""; }
}

function setEnvVar(content, key, value) {
  const lineRegex = new RegExp(`^${key}=.*$`, "m");
  if (lineRegex.test(content)) {
    return content.replace(lineRegex, `${key}=${value}`);
  }
  return content + `\n${key}=${value}\n`;
}

function clearEnvVar(content, key) {
  const lineRegex = new RegExp(`^${key}=.*$`, "m");
  return content.replace(lineRegex, `${key}=`);
}

// ── main ──────────────────────────────────────────────────────────────────────

console.log("🚇 Starting tunnel on port", PORT, "…");

let tunnel;
try {
  tunnel = await localtunnel({ port: PORT, subdomain: SUBDOMAIN });
} catch {
  // Subdomain taken — get a random one
  tunnel = await localtunnel({ port: PORT });
}

const url = tunnel.url;

console.log("\n✅ Tunnel ready!");
console.log("━".repeat(60));
console.log(`   Public URL : ${url}`);
console.log(`   Upload URL : ${url}/mobile-upload`);
console.log("━".repeat(60));
console.log("\n📋 Auto-writing VITE_APP_BASE_URL to .env.local…");

const original = readEnv();
const updated = setEnvVar(original, "VITE_APP_BASE_URL", url);
writeFileSync(ENV_FILE, updated);

console.log("   Done. Restart your dev server (npm run dev) to pick up the new URL.");
console.log("\n📱 Now QR codes work on any network:");
console.log("   • Same WiFi ✓");
console.log("   • Different WiFi ✓");
console.log("   • Mobile hotspot ✓");
console.log("   • Mobile data ✓");
console.log("\nPress Ctrl+C to stop the tunnel.\n");

// ── note about localtunnel password prompt ────────────────────────────────────
// localtunnel.me shows a password page on first visit.
// The password is always your current public IP. Students should paste:
//   https://www.whatismyip.com/ → copy IP → paste into loca.lt password page.
// For a cleaner experience in production, deploy to Vercel instead.
console.log("⚠  Note: When phones open the URL for the FIRST time, they may see");
console.log("   a 'Tunnel Password' page. The password is this computer's public IP.");
console.log("   Visit https://ipv4.icanhazip.com to find it.\n");

// ── cleanup on exit ───────────────────────────────────────────────────────────
const cleanup = () => {
  console.log("\n🔌 Closing tunnel…");
  try {
    const current = readEnv();
    writeFileSync(ENV_FILE, clearEnvVar(current, "VITE_APP_BASE_URL"));
    console.log("   Cleared VITE_APP_BASE_URL from .env.local");
  } catch { /* ignore */ }
  tunnel.close();
  process.exit(0);
};

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

tunnel.on("error", (err) => {
  console.error("Tunnel error:", err);
  cleanup();
});

tunnel.on("close", () => {
  console.log("Tunnel closed by server.");
  cleanup();
});
