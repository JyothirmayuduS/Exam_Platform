import { test, expect } from '@playwright/test';

test.describe('Student Exam Flow', () => {
  test('student can login and access exam', async ({ page }) => {
    // Navigate to the app
    await page.goto('/');

    // Check if we land on the auth page (or we are already logged in)
    // The auth page has a mock sign-in logic
    const title = await page.title();
    // Assuming title is something like 'Exam Platform'
    
    // We expect an input for email if on auth page
    const emailInput = page.getByPlaceholder(/email/i);
    
    // Wait for auth page to load
    if (await emailInput.isVisible()) {
      await emailInput.fill('student@vignan.edu');
      await page.getByRole('button', { name: /sign in/i }).click();
    }

    // Now we should be redirected to the student dashboard
    await expect(page).toHaveURL(/.*\/student.*/);
    
    // Ensure dashboard loads with exams
    await expect(page.getByRole('heading', { name: /Your exams/i })).toBeVisible({ timeout: 10000 });
  });
});
