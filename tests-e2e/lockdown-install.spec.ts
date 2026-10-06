import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";

async function asMac(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { value: "MacIntel" });
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
  });
}
async function demoStudent(page: Page) {
  await page.addInitScript(() => localStorage.setItem("vignan.demo_role", "student"));
}
async function interceptOSBoundary(page: Page) {
  // Keep actual React UI, timers, URL construction and browser navigation.
  // Replace ONLY the OS handoff; this suite must never open a fullscreen kiosk.
  await page.route("**/src/shared/platform/lockdownBridge.ts*", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    expect(body).toContain("window.location.assign(url)");
    await route.fulfill({ response, body: body.replaceAll("window.location.assign(url)",
      'window.dispatchEvent(new CustomEvent("test:protocol-request", { detail: url }))') });
  });
  await page.addInitScript(() => {
    (window as unknown as { protocolRequests: string[] }).protocolRequests = [];
    window.addEventListener("test:protocol-request", (event) => {
      (window as unknown as { protocolRequests: string[] }).protocolRequests.push((event as CustomEvent).detail);
    });
  });
}

async function stageMockDmg(page: Page): Promise<Buffer> {
  const staged = Buffer.alloc(4_096, 0);
  staged.set(Buffer.from("koly"), staged.length - 512);
  await page.context().route("**/downloads/VignanExam.dmg", async (route) => {
    const range = await route.request().headerValue("range");
    if (range) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match) {
        await route.fulfill({ status: 416 });
        return;
      }
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= staged.length) {
        await route.fulfill({ status: 416 });
        return;
      }
      await route.fulfill({
        status: 206,
        contentType: "application/octet-stream",
        headers: { "content-range": `bytes ${start}-${end}/${staged.length}` },
        body: staged.subarray(start, end + 1),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      headers: { "content-length": String(staged.length) },
      body: staged,
    });
  });
  return staged;
}

test.beforeEach(async ({ page }) => { await asMac(page); });

test("Mac installer download contains the actual staged DMG bytes", async ({ page, isMobile }) => {
  test.skip(isMobile, "Desktop-only installer flow.");
  const staged = await stageMockDmg(page);
  await demoStudent(page);
  await page.goto("/student/exam?examId=INSTALLER-SMOKE");
  const link = page.getByRole("link", { name: "Download", exact: true });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "/downloads/VignanExam.dmg");
  const bytes = Buffer.from(await page.evaluate(async () => Array.from(new Uint8Array(await (await fetch("/downloads/VignanExam.dmg")).arrayBuffer()))));
  expect(bytes.length).toBe(staged.length);
  expect(bytes.subarray(-512, -508).toString()).toBe("koly");
  const hash = (input: Buffer) => createHash("sha256").update(input).digest("hex");
  expect(hash(bytes)).toBe(hash(staged));
});

test("first installed click requests the right protocol URL and retry/back work", async ({ page, isMobile }) => {
  test.skip(isMobile, "Desktop-only installer flow.");
  await stageMockDmg(page);
  await demoStudent(page);
  await interceptOSBoundary(page);
  await page.goto("/student/exam?examId=SMOKE%26ONE");
  await page.getByRole("button", { name: /Done — I've installed it/ }).click();
  await expect(page.getByText("Launching Vignan Exam Browser…")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { protocolRequests: string[] }).protocolRequests))
    .toEqual(["vignan-exam://open?exam=SMOKE%26ONE&roll=DEMOSTUDENT"]);
  await page.getByRole("button", { name: "Try again /", exact: true }).click();
  await expect(page.getByText("Launching Vignan Exam Browser…")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { protocolRequests: string[] }).protocolRequests.length)).toBe(2);
  await page.getByRole("button", { name: /Back/ }).click();
  await expect(page.getByRole("heading", { name: "Install Vignan Exam Browser" })).toBeVisible();
  await page.waitForTimeout(3200);
  await expect(page.getByRole("button", { name: "Try again /", exact: true })).toHaveCount(0);
});

test("a missing or HTML fallback installer is not offered as a binary", async ({ page, isMobile }) => {
  test.skip(isMobile, "Desktop-only installer flow.");
  await demoStudent(page);
  await page.route("**/downloads/VignanExam.dmg", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>SPA fallback</title>" }));
  await page.goto("/student/exam?examId=INSTALLER-SMOKE");
  await expect(page.getByText("Installer unavailable for this OS.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Download", exact: true })).toHaveCount(0);
});

test("unauthenticated exam launch survives sign-in instead of losing its reference", async ({ page }) => {
  await page.goto("/student/exam?examId=LOGIN-SMOKE&roll=TEST-ONLY");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole("button", { name: "Continue as Student" }).click();
  await expect(page).toHaveURL(/\/student\/exam\?examId=LOGIN-SMOKE&roll=TEST-ONLY$/);
});
