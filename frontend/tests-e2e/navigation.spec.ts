import { test, expect } from "@playwright/test";

test.describe("Public navigation", () => {
  test("landing page renders Vignan branding and role cards", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Vignan/i);
    await expect(page.getByRole("heading", { name: /Vignan/i }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Student" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Teacher" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Proctor" })).toBeVisible();
    await expect(page.getByRole("link", { name: /sign in/i })).toBeVisible();
  });

  test("login page renders role tabs, demo panel, and forgot-password link", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Authenticate" })).toBeVisible();
    for (const role of ["Student", "Teacher", "Proctor"]) {
      await expect(page.getByRole("button", { name: role, exact: true })).toBeVisible();
    }
    // No backend in CI → demo sign-in panel is shown.
    await expect(page.getByRole("button", { name: /continue as student/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /forgot password/i })).toBeVisible();
  });

  test("forgot-password page renders", async ({ page }) => {
    await page.goto("/forgot");
    await expect(page.getByRole("heading", { name: /reset password/i })).toBeVisible();
  });

  test("unknown routes render the error page", async ({ page }) => {
    await page.goto("/does-not-exist");
    await expect(page.getByRole("heading", { name: /something went wrong|page not found/i })).toBeVisible();
  });
});

test.describe("Auth guards", () => {
  const protectedRoutes: Array<[string, string]> = [
    ["/student", "student dashboard"],
    ["/student/exams", "student exams"],
    ["/student/results", "student results"],
    ["/teacher", "teacher dashboard"],
    ["/teacher/exams", "teacher exams"],
    ["/teacher/evidence", "evidence archive"],
    ["/teacher/proctoring", "live proctoring"],
    ["/proctor", "proctor console"],
  ];

  for (const [route, label] of protectedRoutes) {
    test(`redirects anonymous visitors away from ${label} (${route})`, async ({ page }) => {
      await page.goto(route);
      await expect(page).toHaveURL(/\/login/);
    });
  }
});