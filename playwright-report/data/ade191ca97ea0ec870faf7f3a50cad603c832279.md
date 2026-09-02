# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: exam-flow.spec.ts >> Student Exam Flow >> should prevent unauthorized access to student dashboard
- Location: tests-e2e/exam-flow.spec.ts:21:3

# Error details

```
Error: expect(page).toHaveURL(expected) failed

Expected pattern: /.*\/$/
Received string:  "http://localhost:5173/student"
Timeout: 5000ms

Call log:
  - Expect "toHaveURL" with timeout 5000ms
    14 × locator resolved to <html lang="en">…</html>
       - unexpected value "http://localhost:5173/student"

```

```yaml
- complementary:
  - link "V Vignan OS Exam platform":
    - /url: /
    - text: V
    - paragraph: Vignan OS
    - paragraph: Exam platform
  - paragraph: Student workspace
  - paragraph: Priya Nikitha
  - paragraph: 21VGN0142 · CSE — Sem III
  - navigation:
    - link "Overview":
      - /url: /student
    - link "My exams":
      - /url: /student/exams
    - link "Results":
      - /url: /student/results
    - link "Help & support":
      - /url: /student/help
  - text: Systems operational
  - button "Switch role / Sign out →"
- banner:
  - paragraph: Student console
  - paragraph: Priya Nikitha
  - text: Systems operational PN
- main:
  - paragraph: Student dashboard
  - heading "My enrolled exams" [level=1]
  - link "View full exams page →":
    - /url: /student/exams
  - textbox "Search exams"
  - button "all"
  - button "upcoming"
  - button "live"
  - button "completed"
  - paragraph: Operating Systems
  - paragraph: CSE — Sem IV · 60 minutes · 60 marks
  - paragraph: "Exam ID: EXAM-2026-017"
  - text: Exam Closed
  - link "Details":
    - /url: /student/exams/EXAM-2026-017
  - link "Practice mode":
    - /url: /student/exams/EXAM-2026-017/practice
  - text: completed
  - paragraph: Data Structures & Algorithms
  - paragraph: CSE — Sem III · Sec A/B · 45 minutes · 23 marks
  - paragraph: "Exam ID: EXAM-2026-014"
  - text: Exam Closed
  - link "Details":
    - /url: /student/exams/EXAM-2026-014
  - link "Practice mode":
    - /url: /student/exams/EXAM-2026-014/practice
  - text: completed
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
  9  |     await expect(page).toHaveTitle(/Vignan/i);
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
> 26 |     await expect(page).toHaveURL(/.*\/$/);
     |                        ^ Error: expect(page).toHaveURL(expected) failed
  27 |   });
  28 | });
  29 | 
```