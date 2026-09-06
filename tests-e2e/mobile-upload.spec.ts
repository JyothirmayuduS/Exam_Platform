import { test, expect } from "@playwright/test";

test.describe("Mobile answer upload", () => {
  test("opens directly on the capture step from a scanned link", async ({ page }) => {
    await page.goto("/mobile-upload/demo-token?examId=EXAM&qId=1");
    await expect(page.getByRole("heading", { name: /subjective answer upload/i })).toBeVisible();
    await expect(page.getByText(/take photo \/ choose from gallery/i)).toBeVisible();
  });
});