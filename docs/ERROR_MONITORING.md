# Error Monitoring (Bugsink/Sentry)

This document explains how Bugsink (Sentry-compatible) is integrated into the Exam Platform.

## 1. Environment Variables

To enable error tracking, you must provide your Bugsink DSN. The app uses separate variables to ensure the backend DSN is never exposed to the frontend.

**Frontend (`.env.local` & Vercel):**
```env
VITE_SENTRY_DSN=https://your-public-key@bugsink.example.com/1
```

**Backend (Supabase Edge Functions):**
```bash
supabase secrets set SENTRY_DSN=https://your-private-key@bugsink.example.com/2
```

> **Note for Vercel:** You must add `VITE_SENTRY_DSN` to your Vercel Environment Variables for both the **Preview** and **Production** environments. Do **NOT** add `SENTRY_DSN` to Vercel, as that is for the backend only.

## 2. Privacy & Data Sanitization

To comply with student privacy laws:
- `sendDefaultPii: false` is strictly enforced on both the frontend and backend.
- We have added a `beforeSend` hook in the frontend (`src/main.tsx`) that automatically drops expected `40x` errors (like 401 Unauthorized or 404 Not Found) so we don't spam the dashboard.
- The backend Deno SDK automatically strips `Authorization` headers.

## 3. Context Tracking

When a student starts an exam, the frontend automatically tags the session with:
- `exam_id`
- `attempt_id`
- `student_id`
- `route`

This ensures that when a crash happens, you can filter Bugsink by the exact exam or student that experienced the issue.

## 4. Local Testing

To verify that errors are reaching Bugsink, you can temporarily trigger a crash.

**Frontend Test:**
Open your browser console while running the app locally and type:
```js
throw new Error("Bugsink frontend test");
```

**Backend Test:**
Temporarily add this line inside `supabase/functions/report-error/index.ts`:
```ts
throw new Error("Bugsink backend test");
```
Then trigger a crash report from the UI to execute the function. Check your Bugsink dashboard to verify both errors appear!

## 5. Source Maps

The frontend is configured to output source maps during production builds (`build.sourcemap: true` in `vite.config.ts`). When deploying to Vercel, Sentry/Bugsink will automatically use these to un-minify your stack traces.
