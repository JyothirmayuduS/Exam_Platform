# Architecture

Vignan Exam Platform — a Vite + React + TypeScript SPA over Supabase (Postgres,
Auth, Realtime, Edge Functions), Cloudflare R2 artifact storage, and LiveKit for
live proctoring. This document maps where each concern lives so new work lands
in the right place.

## High-level flow

```
Student / Teacher / Proctor
        │  React pages (src/pages) + feature components (src/components)
        ▼
Data layer (src/lib)          Realtime (src/hooks)
  api/<domain>.ts  ──────►    useLiveAttempts, useTeacherExams…
  supabase.ts / env.ts        (react-query + Supabase channels)
        │
        ├── Supabase (Postgres + Auth + RLS + Edge Functions)
        ├── Cloudflare R2 / Supabase Storage  (recordings, snapshots, PDFs)
        └── LiveKit  (camera/screen streams, proctor voice)
```

## Data-access layer (`src/lib/`)

`src/lib/examApi.ts` is a **barrel only** — it re-exports every domain module in
`src/lib/api/` so existing imports (`from "../lib/examApi"`) keep working. Add new
queries to the matching domain module, not to the barrel.

| Module | Owns |
| --- | --- |
| `api/exams.ts` | exam CRUD/publish/email, student + teacher exam listing, realtime exam subscription, settings merge (`updateExam`) |
| `api/questions.ts` | question bank CRUD, exam pool joins, per-student paper delivery (`loadPaperForStudent`, `loadExamBundle`) |
| `api/students.ts` | global student directory, roster/enrolment, bulk import, login provisioning, roll→id lookups |
| `api/attempts.ts` | attempt lifecycle (start → consent → autosave → submit), proctor-session upsert, score writes |
| `api/live.ts` | live roster (`listLiveAttempts` incl. enrolled-but-idle placeholders), violation attachment, realtime subscription, selector stats |
| `api/proctoring.ts` | violation_events writes + proctor actions (pause, extend, force-submit) |
| `api/chat.ts` | proctor messages / broadcasts + realtime subscription |
| `api/assignments.ts` | proctor assignments, faculty directory, "exams assigned to me" |
| `api/grading.ts` | grading comments, delegate/delegation rows, examiner dashboard + evaluator allocation |
| `api/teacher.ts` | signed-in teacher settings blob + profile fields (`auth_id`-scoped) |
| `api/types.ts` | shared row types (no logic) |
| `api/helpers.ts` | internal normalizers/severity mapping (never imported by pages) |

Other `src/lib` files by concern:

- `supabase.ts` / `env.ts` — one shared client; feature-flag off when unconfigured.
- `paperBuilder.ts` — deterministic per-student paper snapshots (imports `DBQuestion` type from `examApi`).
- `examStorage.ts` / `recorder.ts` — Cloudflare R2 artifact storage (primary) + Supabase Storage backup; MediaRecorder egress. Supabase holds only metadata.
- `subjectiveUpload.ts` / `platform.ts` / `serverProctor.ts` — mobile QR upload, platform detection (Tauri/web), server-side AI watchdog frames.
- `rosterModel.ts` — the shared **UI** roster shape used by Submissions and Evaluate (mapped from `LiveAttempt` rows by `hooks/useLiveAttempts.ts`). View model, not demo data.
- `proctor*.ts` (`proctor.ts`, `proctorViewer.ts`, `proctorVoice.ts`) — LiveKit publish/view/voice.

## State ownership

- **Live roster** — `hooks/useLiveAttempts.ts` (react-query key `["liveAttempts", examId]`,
  realtime invalidation) is the single source for Submissions / Evaluate rosters.
- **Teacher exam scope** — `hooks/useTeacherExams.ts` resolves the active exam
  (URL → last selection → newest exam with activity → newest non-draft); teacher
  pages must not hardcode an exam id.
- **Auth/profile** — `lib/auth.tsx` provider + `hooks/useCurrentProfile.ts`;
  role comes from `teachers.role` / `students` rows joined by `auth_id`.

## Database & backend

- Migrations: `supabase/migrations/*.sql` (imperative; one per feature). Latest go-live
  migrations provision real Auth users and enforce role-scoped RLS.
- Edge Functions: `supabase/functions/<name>/index.ts` — email flows
  (`send-*-email`), `store-artifact` (R2), `provision-student-accounts`,
  `proctor-ai-server` (server-side frame analysis → `violation_events`),
  `livekit-token`, `mobile-upload`, `report-error`, exports.

## Data flow for proctoring

1. Student begins → `startAttempt` (real row), consent persisted on the attempt.
2. Student publishes camera/screen to LiveKit (room = exam id) and runs local
   heuristics + server watchdog (`serverProctor` → `proctor-ai-server`).
3. Violations land in `violation_events` with `offset_seconds` + `source`.
4. Proctor console lists attempts + violations via `api/live.ts`, streams feeds
   via `proctorViewer`, acts via `api/proctoring.ts` / `api/chat.ts`.
5. Recording + violation snapshots + PDF egress to R2 (`examStorage`); reviewer
   (`RecordingReview`) replays with red markers on the seek bar.

## Conventions for new code

- **Data access** → the matching `src/lib/api/<domain>.ts` module. Barrel stays thin.
- **Live data** → a hook in `src/hooks` built on react-query + realtime subscription.
- **No mock data**: every hardcoded id/roll/credential was removed or made a
  real query; new demo-ish branches need an explicit `VITE_*` flag.
- **Storage**: write R2 first, fall back to Supabase Storage; never store blobs
  as Postgres rows.
- **UI**: shared kit in `src/components/ui.tsx` (react-icons Feather); buttons
  read as buttons; no emoji glyphs; keep the editorial cream/ink/forest theme.

## Known structure debts (do not reintroduce)

- Pages like `StudentExam.tsx` / `TeacherProctoring.tsx` are large feature
  surfaces — split components out as they grow, not monoliths of inline JSX.
- `ProctorGrid` (proctor console) and `TeacherProctoring` (teacher live view)
  overlap by design (different roles/entry points), but shared tile/log logic
  should be extracted rather than copied.
