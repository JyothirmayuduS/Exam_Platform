import { test, expect } from '@playwright/test';

test.describe('Student Exam Flow', () => {
  test('student can login and access exam', async ({ page }) => {
    // Navigate to the sign-in page
    await page.goto('/login');

    // No backend in CI: the app runs in demo mode and offers a demo sign-in.
    // In a real deployment the regular credentials form is used instead.
    const demoButton = page.getByRole('button', { name: /continue as student/i });
    if (await demoButton.isVisible()) {
      await demoButton.click();
    }

    // Now we should be redirected to the student dashboard
    await expect(page).toHaveURL(/.*\/student/);

    // Ensure dashboard loads with exams
    await expect(page.getByRole('heading', { name: /enrolled exams/i })).toBeVisible({ timeout: 10000 });
  });
});