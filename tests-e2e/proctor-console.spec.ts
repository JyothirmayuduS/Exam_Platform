import { test, expect } from "@playwright/test";
import { demoLogin } from "./helpers";

test.describe("Proctor console (demo)", () => {
  test("signs in and lands on the proctor workspace", async ({ page }) => {
    await demoLogin(page, "proctor");
    await expect(page).toHaveURL(/\/proctor/);
    // Demo mode has no assigned exams — the empty state is the stable signal.
    await expect(page.getByText("No exams assigned yet")).toBeVisible({ timeout: 10000 });
  });
});