import { expect, type Page } from "@playwright/test";

export type DemoRole = "student" | "teacher" | "proctor";

/**
 * Sign in with the no-backend demo identity. CI has no Supabase credentials,
 * so the Login page offers a "Demo mode" panel; clicking the matching role
 * button stores a demo session and navigates to that role's console.
 */
export async function demoLogin(page: Page, role: DemoRole): Promise<void> {
  await page.goto("/login");
  const button = page.getByRole("button", { name: new RegExp(`continue as ${role}`, "i") });
  await expect(button).toBeVisible();
  await button.click();
}