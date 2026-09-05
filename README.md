# Vignan OS · Lockdown Exam Platform

A production-style, proctored online-examination platform built for the **Vignan
Center for Distance Education** — teacher console, live proctoring command
centre with real-time camera/screen feeds and two-way voice, per-student paper
snapshots, QR-based handwritten-answer upload, recording retention on
Cloudflare R2, and a native lockdown desktop app (Tauri) for candidates.

- **Web app:** React 19 + TypeScript + Vite + Tailwind
- **Backend:** Supabase (Postgres + RLS + realtime + edge functions)
- **Media:** LiveKit (camera/mic/screen rooms + proctor voice), Cloudflare R2
  (recording/snapshot artifacts via edge functions)
- **Desktop lockdown app:** Tauri v2 (kiosk window for candidates)
- **Monitoring:** Sentry (errors) · vitest + Playwright (tests)

---

## Console map

| Role | Entry | What it does |
| --- | --- | --- |
| Student | `/login` → `/student` | Enrolled exams, system check, device access, exam (locked down), results, appeals, help |
| Teacher | `/login` → `/teacher` | Overview, My tests + paper builder, question bank, students/enrolment, live submissions, evaluation, proctoring centre, reports |
| Proctor | `/login` → `/proctor` | Assigned exams → live monitoring grid, flags & incidents, recordings, voice intervention |
| Examiner | `/teacher/dashboard` | Cross-exam grading delegation + auto-assign to evaluators |

## Key flows

1. **Create a test** (`/teacher/exams` → + Create new test) → the **paper
   builder** (`/teacher/exams/:id/build`) searches your question bank, builds a
   composition grouped by section, and offers Preview + Advance options.
   **Publish & share** enrols the batch and emails the join link.
2. **Per-student paper snapshot** — delivery settings (`questions per student`,
   random select, difficulty mix, shuffle) produce a deterministic,
   difficulty-balanced paper per candidate; the snapshot is persisted on the
   attempt and grading/review grade *that candidate's own paper*.
3. **Candidate sits the exam** (inside the lockdown app, or a browser in the
   sandbox) — system check → camera/mic/screen consent → monitoring notice
   consent → timed exam with question palette, autosave, keyboard shortcuts,
   and live AI/proctor flags. Handwritten answers upload via a QR code scanned
   from the student's phone.
4. **Teacher live submissions** (`/teacher/submissions`) — one exam at a time
   (exam dropdown at top-right), real attempt states, presence derived from
   autosave freshness, real violations, force-submit/extend/remind actions.
5. **Evaluation** (`/teacher/evaluate`) — objective answers auto-score from the
   answer key; theory/code answers are reviewed manually (camera-monitored).
6. **Proctoring** (`/teacher/proctoring`) — assessment selector with live stats,
   then the command centre: video wall, speak-to-candidate (voice, candidates
   cannot reply), send warning / pause / escalate / force-submit, violation log
   with timestamps, recording review with red violation markers on the seek bar.
7. **Reports** (`/teacher/reports`) — score distribution, item analysis, PDF/CSV
   export, result & answer-key release.

## Repository layout

```
src/
  pages/            One file per screen (StudentExam, TeacherDashboard, …)
  components/       exam/ (candidate flow), teacher/ (console panels), ui.tsx (UI kit)
  hooks/            useTeacherExams (exam scope), useLiveAttempts, useExamState, …
  lib/              examApi (all Supabase calls), examStorage (R2), proctorViewer,
                    proctorVoice, paperBuilder, sessionReport, auth, env
supabase/
  migrations/       Versioned SQL (schema, RLS, edge-function contracts, seeds)
  functions/        Edge functions: livekit-token, store-artifact, send-*-email,
                    mobile-upload, generate-pdf-report, canvas-sync, …
src-tauri/          Native lockdown browser (Rust/Tauri v2)
tests-e2e/          Playwright end-to-end specs
```

## Setup (local)

1. `npm install`
2. `cp .env.example .env.local` and fill the VITE_* keys (Supabase anon key,
   LiveKit URL, download links). Only the anon key lives in the frontend — RLS
   guards every table.
3. Apply migrations: `npx supabase db push --include-all`
4. Deploy edge functions + secrets (see `supabase/functions/README` notes in
   `SETUP.md`): LiveKit token, R2 credentials, Gmail app password, `APP_BASE_URL`.
5. `npm run dev` — teacher + proctor flows; open the student console in another
   tab to watch exams arrive live via realtime.

## Going live (auth-required mode)

The platform ships with role-scoped Row-Level Security. To switch from the
open demo policies to real accounts:

1. `npx supabase db push --include-all` (applies every pending migration).
2. Apply **`20260910000006_auth_provision_and_production_rls.sql`** — this
   creates real Supabase Auth accounts for the seeded staff/students and drops
   the wide-open demo policies:
   - Teacher: `teacher@vignan.ac.in` / `password123`
   - Proctor: `proctor@vignan.ac.in` / `password123`
   - Students: `<roll>@student.vignan.ac.in` / `Vignan@123`
3. Sign in at `/login` and verify: teacher My-tests list, submissions,
   evaluation, proctoring centre; student enrolled exams → exam flow.

Institutions provision real students with the same convention (email =
`roll@student.vignan.ac.in`, linked `students.auth_id`); staff import a class
list from Students → Import CSV and then link auth accounts in the dashboard.

The app never falls back to hardcoded demo ids in production: every page
resolves its exam from the shared teacher exam scope (URL → last selection →
most recent live exam), and candidate identity always comes from the signed-in
profile. An explicit sandbox flag (`VITE_ALLOW_ANON_ROLL=true`) exists for
staging/demo builds only.

## Testing & verification

```bash
npm run lint        # oxlint
npx tsc -b          # typecheck
npx vitest run      # unit tests (exam-scope resolver, paper logic, timers, …)
npm run build       # production build (typecheck + vite)
npx playwright test # e2e (needs a running dev server + backend)
```

## Operational notes

- **Recording retention:** per-second snapshots + recordings upload to R2 under
  `EXAM-2026-XXX/<studentId>/{screenshots,recordings}/` via the
  `store-artifact` function; define a lifecycle policy in the R2 bucket console
  per the institution's data-retention rules.
- **Consent:** the candidate accepts an explicit monitoring notice before the
  exam; the timestamp + wording snapshot are stored on `attempts.consent_at`
  / `consent_text` for audit.
- **Error monitoring:** Sentry DSN via `VITE_SENTRY_DSN`; an `ErrorBoundary`
  + "Report a problem" flow surfaces failures to the operator.
- Rotate the Supabase database password / LiveKit secret before any real exam.
