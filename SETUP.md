# Vignan OS — Lockdown Exam Platform · Setup

This guide wires the prototype to a real backend and desktop lockdown app. Three
pieces were added:

1. **Supabase** — publishing an exam writes it to the database; assigned students
   see it appear instantly over realtime.
2. **LiveKit proctoring** — the student's camera/mic publish to a room the
   invigilator watches; tokens are minted server-side.
3. **Tauri lockdown exe** — a downloadable desktop app that boots straight into
   the exam in a locked-down kiosk window with no onboarding screens.

Everything degrades gracefully: with no backend configured the app still runs on
its built-in demo data.

---

## 0. Prerequisites

- Node.js 20+ and npm
- A Supabase project (free tier is fine)
- A LiveKit Cloud project (free tier) or a self-hosted LiveKit server
- For the desktop app: Rust (`https://rustup.rs`) and the Tauri v2 system
  dependencies for your OS (`https://v2.tauri.app/start/prerequisites/`)

## 1. Install dependencies

```bash
npm install
```

This pulls the newly added `@supabase/supabase-js`, `livekit-client`, and the
Tauri CLI. Once installed, the real package types replace the fallback stubs in
`src/types/vendor.d.ts` automatically.

## 2. Configure environment

```bash
cp .env.example .env.local   # if you haven't already
```

Fill `.env.local` (it is gitignored):

- `VITE_SUPABASE_URL` — Supabase → Project Settings → API → Project URL
- `VITE_SUPABASE_ANON_KEY` — the **anon public** key from the same page
- `VITE_LIVEKIT_URL` — your LiveKit `wss://…` URL
- `VITE_EXAM_ENTRY_PATH` — leave as `/student/exam`
- `VITE_LOCKDOWN_DOWNLOAD_URL` — where the download gate sends students who open
  the exam in a normal browser. Optional per-OS overrides:
  `VITE_LOCKDOWN_DOWNLOAD_WIN` / `_MAC` / `_LINUX`.

Only the anon key belongs in the frontend. It is safe there because Row Level
Security guards every table.

<!-- APPEND-MARKER -->

## 3. Set up the database

Open the Supabase SQL editor and run the contents of `supabase/schema.sql`. It
creates the tables (`students`, `exams`, `questions`, `enrollments`, `attempts`,
`proctor_sessions`), turns on realtime for `exams`, and applies Row Level
Security policies.

Seed a student so the RLS batch filter matches (adjust to your data):

```sql
insert into public.students (roll, full_name, email, batch)
values ('21VGN0142', 'Priya Nikitha', '21vgn0142@vignan.ac.in', 'CSE · Sem III');
```

The student dashboard fetches exams for batch `CSE · Sem III` (see
`STUDENT_BATCH` in `src/pages/StudentHome.tsx`). When a teacher publishes an exam
with that same batch, it appears on the student's screen immediately — no
refresh — via the realtime subscription.

> Prototype shortcut: if you have not wired Supabase Auth yet, you can relax the
> `read live exams` policy to `using (status <> 'draft')` so any anon client can
> read published exams. Tighten it before real use.

## 4. Deploy the LiveKit token function

The browser must never hold the LiveKit API secret, so tokens are minted by a
Supabase Edge Function.

```bash
# From the project root, with the Supabase CLI installed and logged in:
supabase functions deploy livekit-token --no-verify-jwt
supabase secrets set \
  LIVEKIT_API_KEY=your_key \
  LIVEKIT_API_SECRET=your_secret \
  LIVEKIT_URL=wss://your-project.livekit.cloud
```

The student exam screen (`src/components/ProctorCamera.tsx`) calls this function,
receives a short-lived token, and publishes camera + mic to the room. If LiveKit
is not configured, it falls back to a local-only camera preview so the UI still
shows the proctor tile.

**Live proctor voice**: the teacher/proctor consoles publish their mic into a
per-candidate channel `voice-<exam>-<roll>` (see `src/lib/proctorVoice.ts`). The
token function grants publish only to staff on `voice-` rooms and subscribe to
students, so a candidate hears warnings aimed at them but can never talk back.
The candidate's exam shows an amber **"Invigilator speaking"** chip while audio
plays (`src/components/InvigilatorVoice.tsx`).

**Proctor assignment emails**: deploy the companion function with the same Gmail
secrets as `send-exam-email`:

```bash
supabase functions deploy send-proctor-email --no-verify-jwt
supabase functions deploy send-evaluator-email --no-verify-jwt
```

`send-evaluator-email` powers the Examiner dashboard's **Auto-assign Test
Reports** flow (notifies each evaluator with their report count + due date +
grading link).

Run these migrations too (in order, alongside the earlier ones):
`20260906000000_violation_events.sql`, `20260906000001_messaging_assignments_extend.sql`,
`20260906000002_teacher_settings.sql`, `20260906000003_grading_delegations.sql`,
`20260906000004_proctor_assignments_contacts.sql` (assignee id/email on
`proctor_assignments` + RLS so an assigned proctor can read the exam, attempts,
violations and messages). Teachers pick proctors from the real faculty roster in
**Assign Proctors** (Live proctoring page); proctors land on `/proctor` and see
only their assigned exams.

`20260906000005_paper_snapshots_allocation.sql` adds the per-student **paper
snapshot** (`attempts.paper`) and the exam-level allocation columns on
`grading_delegations`. After this migration the delivery settings in the exam
builder are real: each student receives a deterministic, difficulty-balanced
subset (`questions per student` / `random select` / `shuffle order` / `shuffle
options`), the snapshot is persisted with the attempt, and answers are keyed by
DB question id so Evaluate/student results grade **that student's own paper**
(legacy attempts without a snapshot fall back to the full pool).

`20260906000006_exam_pool_join.sql` adds the many-to-many **exam_questions**
join so one bank question can belong to several tests (the Mettl-style reusable
pool). Run it after `…0005`; existing questions are backfilled automatically.
The paper builder at `/teacher/exams/<id>/build` uses it for add/remove pool
membership, and question-owner rows created before it still count via
`questions.exam_id` (so pools work with or without the join applied).

## Mettl-style test creation flow

The teacher console now follows the Mettl pattern end to end:

1. **My tests** (`/teacher/exams`) → **+ Create new test** opens a modal
   (test name, language, purpose, Timed vs Deadline based, assigned batch).
2. **Proceed** drops you into the **paper builder** (`/teacher/exams/<id>/build`)
   — search & add questions from your bank (type/difficulty filters), a live
   composition table grouped by section, metric cards (Sections / Topics /
   Questions / Marks), duration, **Preview**, and **Advance options** (Test
   Options, Section Options, Candidate Registration Fields dialogs).
3. **Publish & share** enrolls the batch (or hand-picked candidates) and emails
   the join link, or schedules the test.

## 5. Run the web app

```bash
npm run dev
```

Create a test from **My tests** (`/teacher/exams` → Create new test) and build
it in the paper builder (`/teacher/exams/<id>/build` → Publish & share →
Publish now / Schedule). Open the student dashboard in another tab to watch it
arrive live.

## 6. Build the lockdown desktop exe

The desktop app lives in `src-tauri/`. It opens a fullscreen, always-on-top,
undecorated window that boots directly to the exam (`VITE_EXAM_ENTRY_PATH`) and
injects a lockdown layer (blocks right-click, devtools shortcuts, copy/paste,
printing, text selection, and re-asserts fullscreen if focus is lost).

```bash
# Generate app icons once from any square PNG (creates src-tauri/icons/*):
npm run tauri icon path/to/logo.png

# Develop against the live dev server:
npm run tauri:dev

# Produce the installer / exe:
npm run tauri:build
```

Output installers land in `src-tauri/target/release/bundle/` — e.g. an NSIS
`.exe` and `.msi` on Windows, a `.dmg` on macOS, an `.AppImage` on Linux. Copy
them into `public/downloads/` (see the README there) **before** `npm run build`
so the student download gate can serve them, or host them elsewhere and set the
`VITE_LOCKDOWN_DOWNLOAD_*` links. Students run the installer and land straight
in the exam with no onboarding.

By default the desktop build bundles the local `dist/`. To point the exe at a
hosted deployment instead, set the window `url` in `src-tauri/tauri.conf.json`
to your `https://…/student/exam` URL.

## 6a. Student entry flow — download gate to exam

When a student opens the join link, `src/pages/StudentExam.tsx` branches on
whether it is running inside the Tauri lockdown app (`src/lib/platform.ts`
detects `__TAURI_INTERNALS__`):

1. **Normal browser** → **download gate**. The student sees a screen with a
   download button for their OS (resolved from `VITE_LOCKDOWN_DOWNLOAD_*`). They
   cannot start the exam here. The gate only offers a download after verifying
   the link resolves to real installer bytes (`.exe` `MZ` header, `.dmg` `koly`
   trailer, `.AppImage` ELF magic). A missing/unreachable file, or a 404/SPA
   HTML page, shows **“Installer not published yet”** with no download — so the
   browser can never save HTML as `VignanExam.dmg` and macOS never reports
   *“the disk image is corrupted.”* A reachable HTML release page is offered as
   **“Open download page”** (new tab) instead of a forced download. For
   previewing the flow without the exe, append `?lockdown=1` (or `#lockdown`)
   to the URL to bypass the gate.
2. **Inside the lockdown app** → straight into the exam pipeline, no onboarding:
   - **System compatibility check** — HTTPS/secure context, `getUserMedia`,
     `getDisplayMedia`, fullscreen API, and lockdown-ready. Continue is disabled
     until every check passes.
   - **Device access** — requests camera + microphone (`getUserMedia`) and
     screen share (`getDisplayMedia`), with a live camera preview. All three must
     be granted to proceed.
   - **Timer & instructions** — duration, question count, and proctoring notice,
     plus the rules and an "I agree" checkbox gating the **Start exam** button.
   - **Exam** — enters fullscreen, opens the attempt row in the DB, and publishes
     the student's camera to the LiveKit room the proctor and teacher watch.

The teacher's **Live proctoring** console (`src/pages/TeacherProctoring.tsx`) and
the dedicated **Proctor grid** (`src/pages/ProctorGrid.tsx`) both read the live
attempt roster from the DB (realtime) and subscribe to the same LiveKit room, so
each candidate's tile shows their live camera the moment they begin.

## 7. IMPORTANT — rotate your shared secrets

The database password and keys shared during development should be rotated,
since anything pasted into a chat should be treated as exposed:

- Supabase → Project Settings → Database → **Reset database password**
- If you ever exposed a `service_role` key, Supabase → API → **roll** it
- The anon key can stay (it is public by design) but rotate it too if unsure
- LiveKit → rotate the API key/secret if they were shared anywhere

Keep every secret in `.env.local` (frontend, anon key only) or Supabase secrets
(server side) — never in committed files.

## 8. Production readiness — honest gaps

This is a working prototype wired to real services, not yet a hardened product.
Before selling or running a real exam, close these:

- **Auth**: wire Supabase Auth (email/roll + password or SSO) and set
  `app_metadata.role` (`student` / `proctor` / `teacher` / `admin`). The LiveKit
  token function already derives capabilities from that role; the RLS policies
  assume it too. The demo relaxes some policies — re-tighten them.
- **Identity binding**: `STUDENT_ROLL` and the exam id are still constants in
  `StudentExam.tsx` for the demo; the proctor pages now take the exam from the
  proctor's real assignments (`?exam=` overrides). Drive student identity from
  the authenticated user and the join-link route param (`/join/:examId`).
- **Grading**: `submitAttempt` stores answers; automatic scoring for MCQ and a
  teacher evaluation flow for written answers still need wiring end to end.
- **Proctoring signal**: violation flags are currently client-side heuristics
  (visibility/blur/fullscreen). Persist them to the DB and surface real
  server-side events; consider face/second-person detection as a service.
- **Recording retention**: screenshots upload to R2 via `store-artifact`. Define
  retention, access control, and a review UI for saved camera/screen artifacts.
- **Scale/observability**: add error reporting, LiveKit egress/recording if you
  need durable video, and load-test realtime with a full cohort.
- **Legal**: consent screens, data-retention policy, and accessibility review.

