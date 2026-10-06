import { test, expect } from "@playwright/test";
import { demoLogin } from "./helpers";

test.describe("Teacher console (demo)", () => {
  test("signs in and lands on the overview", async ({ page }) => {
    await demoLogin(page, "teacher");
    await expect(page).toHaveURL(/\/teacher/);
    await expect(page.getByRole("heading", { name: /good morning/i })).toBeVisible();
  });

  test("exams page renders", async ({ page }) => {
    await demoLogin(page, "teacher");
    await page.goto("/teacher/exams");
    await expect(page.getByText("Faculty console / Exams")).toBeVisible();
  });

  const pages: Array<[string, string]> = [
    ["/teacher/bank", "My question bank"],
    ["/teacher/students", "Manage your class roster"],
    ["/teacher/submissions", "Track attempts as they come in"],
    ["/teacher/evaluate", "Evaluate submitted papers"],
    ["/teacher/evidence", "All exam evidence"],
    ["/teacher/reports", "Performance reports"],
    ["/teacher/settings", "Teacher workspace settings"],
    ["/teacher/dashboard", "Examiner dashboard"],
  ];

  for (const [route, heading] of pages) {
    test(`renders ${route}`, async ({ page }) => {
      await demoLogin(page, "teacher");
      await page.goto(route);
      await expect(page.getByRole("heading", { name: new RegExp(heading, "i") })).toBeVisible();
    });
  }

  test("live proctoring page renders its selection screen", async ({ page }) => {
    await demoLogin(page, "teacher");
    await page.goto("/teacher/proctoring");
    await expect(page.getByRole("heading", { name: /proctoring centre/i })).toBeVisible();
  });
});