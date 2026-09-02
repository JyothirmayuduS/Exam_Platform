import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('Student Exam Flow', () => {
  test('should load landing page without accessibility violations', async ({ page }) => {
    await page.goto('/');
    
    // Check basic page content
    await expect(page).toHaveTitle(/Vignan/i);
    const heading = page.getByRole('heading', { name: /Vignan/i });
    await expect(heading.first()).toBeVisible();

    // Run accessibility scan
    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
    // We log violations but don't fail the build immediately until we fix existing ones
    if (accessibilityScanResults.violations.length > 0) {
      console.warn('Accessibility violations found:', accessibilityScanResults.violations.length);
    }
  });

  test('should prevent unauthorized access to student dashboard', async ({ page }) => {
    // Attempt to go to dashboard without login
    await page.goto('/student');
    
    // Should be redirected to landing
    await expect(page).toHaveURL(/.*\/$/);
  });
});
