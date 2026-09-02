# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: exam-flow.spec.ts >> Student Exam Flow >> should load landing page without accessibility violations
- Location: tests-e2e/exam-flow.spec.ts:5:3

# Error details

```
Error: expect(page).toHaveTitle(expected) failed

Expected pattern: /Vignan/i
Received string:  "exam-platform"
Timeout: 5000ms

Call log:
  - Expect "toHaveTitle" with timeout 5000ms
    14 × locator resolved to <html lang="en">…</html>
       - unexpected value "exam-platform"

```

```yaml
- banner:
  - text: V
  - paragraph: Vignan Lockdown OS
  - paragraph: Secure Examination Platform
- main:
  - paragraph: Semester Examinations · 2026
  - heading "One examination hall, three vantage points." [level=1]
  - paragraph: The same exam, seen from where you sit. Choose a role below to open its console — each is built for exactly what that seat in the hall needs to see, and nothing else.
  - link "01 Student Verify your identity, complete the system check, and take your exam in a locked, distraction-free window. Kiosk-mode exam screen Auto-save every answer Live countdown & question palette Enter console →":
    - /url: /student
    - text: "01"
    - heading "Student" [level=2]
    - paragraph: Verify your identity, complete the system check, and take your exam in a locked, distraction-free window.
    - list:
      - listitem: Kiosk-mode exam screen
      - listitem: Auto-save every answer
      - listitem: Live countdown & question palette
    - text: Enter console →
  - link "02 Teacher Build the question bank, configure the lockdown tier, and evaluate submissions once the window closes. Question bank & randomized pools Live submission dashboard On-screen subjective evaluation Enter console →":
    - /url: /teacher
    - text: "02"
    - heading "Teacher" [level=2]
    - paragraph: Build the question bank, configure the lockdown tier, and evaluate submissions once the window closes.
    - list:
      - listitem: Question bank & randomized pools
      - listitem: Live submission dashboard
      - listitem: On-screen subjective evaluation
    - text: Enter console →
  - link "03 Proctor Monitor the live candidate grid, review AI-raised flags, and act on incidents as they happen. Live webcam grid Severity-sorted flag feed Warn, pause, or escalate a candidate Enter console →":
    - /url: /proctor
    - text: "03"
    - heading "Proctor" [level=2]
    - paragraph: Monitor the live candidate grid, review AI-raised flags, and act on incidents as they happen.
    - list:
      - listitem: Live webcam grid
      - listitem: Severity-sorted flag feed
      - listitem: Warn, pause, or escalate a candidate
    - text: Enter console →
  - text: "All systems operational · Tier: AI Proctoring"
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | import AxeBuilder from '@axe-core/playwright';
  3  | 
  4  | test.describe('Student Exam Flow', () => {
  5  |   test('should load landing page without accessibility violations', async ({ page }) => {
  6  |     await page.goto('/');
  7  |     
  8  |     // Check basic page content
> 9  |     await expect(page).toHaveTitle(/Vignan/i);
     |                        ^ Error: expect(page).toHaveTitle(expected) failed
  10 |     const heading = page.getByRole('heading', { name: /Vignan/i });
  11 |     await expect(heading.first()).toBeVisible();
  12 | 
  13 |     // Run accessibility scan
  14 |     const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
  15 |     // We log violations but don't fail the build immediately until we fix existing ones
  16 |     if (accessibilityScanResults.violations.length > 0) {
  17 |       console.warn('Accessibility violations found:', accessibilityScanResults.violations.length);
  18 |     }
  19 |   });
  20 | 
  21 |   test('should prevent unauthorized access to student dashboard', async ({ page }) => {
  22 |     // Attempt to go to dashboard without login
  23 |     await page.goto('/student');
  24 |     
  25 |     // Should be redirected to landing
  26 |     await expect(page).toHaveURL(/.*\/$/);
  27 |   });
  28 | });
  29 | 
```