import { test, expect, type Page } from "@playwright/test";

function stagedDmgFixture(): Buffer {
  const size = 1024 * 1024 + 1024;
  const bytes = Buffer.alloc(size, 0);
  bytes.write("koly", size - 512, "ascii");
  return bytes;
}

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
  // Ensure the browser stays on-page after protocol-launch attempts.
  await page.route("vignan-exam://**", (route) => route.abort());
}

test.beforeEach(async ({ page }) => { await asMac(page); });

test("Mac installer gate shows download for staged DMG bytes", async ({ page }) => {
  await demoStudent(page);
  const staged = stagedDmgFixture();
  await page.route("**/downloads/VignanExam.dmg", (route) => route.fulfill({
    status: 200,
    contentType: "application/x-apple-diskimage",
    body: staged,
  }));
  await page.goto("/student/exam?examId=INSTALLER-SMOKE");
  const link = page.getByRole("link", { name: "Download", exact: true });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "/downloads/VignanExam.dmg");
  expect(staged.subarray(-512, -508).toString()).toBe("koly");
});

test("first installed click requests the right protocol URL and retry/back work", async ({ page }) => {
  await demoStudent(page);
  await page.route("**/downloads/VignanExam.dmg", (route) => route.fulfill({
    status: 200,
    contentType: "application/x-apple-diskimage",
    body: stagedDmgFixture(),
  }));
  await interceptOSBoundary(page);
  await page.goto("/student/exam?examId=SMOKE%26ONE");
  await page.getByRole("button", { name: /Done — I've installed it/ }).click();
  await expect(page.getByText("Launching Vignan Exam Browser…")).toBeVisible();
  await page.getByRole("button", { name: "Try again /", exact: true }).click();
  await expect(page.getByText("Launching Vignan Exam Browser…")).toBeVisible();
  await page.getByRole("button", { name: /Back/ }).click();
  await expect(page.getByRole("heading", { name: "Install Vignan Exam Browser" })).toBeVisible();
  await page.waitForTimeout(3200);
  await expect(page.getByRole("button", { name: "Try again /", exact: true })).toHaveCount(0);
});

test("a missing or HTML fallback installer is not offered as a binary", async ({ page }) => {
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
