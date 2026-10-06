import { test, expect } from "@playwright/test";
import { demoLogin } from "./helpers";

test.describe("Student console (demo)", () => {
  test("signs in and lands on the dashboard", async ({ page }) => {
    await demoLogin(page, "student");
    await expect(page).toHaveURL(/\/student/);
    await expect(page.getByRole("heading", { name: /my enrolled exams/i })).toBeVisible();
  });

  test("my exams page renders", async ({ page }) => {
    await demoLogin(page, "student");
    await page.goto("/student/exams");
    await expect(page.getByRole("heading", { name: /my exams/i })).toBeVisible();
  });

  test("results page renders", async ({ page }) => {
    await demoLogin(page, "student");
    await page.goto("/student/results");
    await expect(page.getByRole("heading", { name: /results/i })).toBeVisible();
  });

  test("help page renders", async ({ page }) => {
    await demoLogin(page, "student");
    await page.goto("/student/help");
    await expect(page.getByRole("heading", { name: /help & support/i })).toBeVisible();
  });

  test("exam entry starts at the lockdown-browser install gate", async ({ page }) => {
    await demoLogin(page, "student");
    await page.goto("/student/exam?examId=missing-exam");
    await expect(page.getByRole("heading", { name: /install vignan exam browser/i })).toBeVisible();
  });
});