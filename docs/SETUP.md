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

## 4a. Recording storage — Cloudflare R2 (exam recordings & screenshots)

Every recording, per-second screenshot, violation frame and PDF report is
stored in **Cloudflare R2** under a folder named after the **exam name**, not the
id — open your bucket and you see `Test-3/<roll>/recordings/…` instead of
`EXAM-2026-84DE3570/…` (legacy id folders stay readable). Uploads are signed
server-side: the browser never holds R2 credentials.

**If recordings/screenshots are not appearing in R2, this section is the #1
cause.** The upload pipeline is: student browser → `store-artifact` Edge
Function (mints a presigned PUT) → R2 bucket. All three must be deployed.

```bash
# 1. Deploy the function WITH JWT verification (signed-in users only):
supabase functions deploy store-artifact

# 2. Set the R2 secrets on the function:
supabase secrets set \
  R2_ACCESS_KEY_ID=<your-r2-access-key> \
  R2_SECRET_ACCESS_KEY=<your-r2-secret-key> \
  R2_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
  R2_BUCKET=exam-records

# 3. (Recommended) lock the CORS origin:
supabase secrets set ALLOWED_ORIGIN=https://your-app-origin
```

**4. Configure CORS on the bucket.** The browser executes the presigned PUT
itself, so R2 must allow cross-origin `PUT` with a `Content-Type` header —
without this every upload fails silently and falls back to Supabase Storage
(and disappears entirely if that bucket doesn't exist either). In the R2
bucket → Settings → CORS, add:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD", "PUT"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```

For production replace `"*"` with your app's origin. If R2 is unreachable the
same object is written to the Supabase Storage bucket named by
`VITE_SUPABASE_BUCKET_NAME` (default `exam-records`) — create that bucket too so
an outage never loses a recording.

> Cleanup: the legacy `VITE_S3_ENDPOINT` / `VITE_S3_ACCESS_KEY` /
> `VITE_S3_SECRET_KEY` values in `.env.local` belong to the OLD direct
> browser→S3 upload path and are **not read by the current code**. Remove them
> so nobody is tempted to ship R2 credentials in the frontend bundle.

Quick check: take a short exam in the preview (`?lockdown=1`), submit, then
open the R2 bucket — you should see `<ExamName>/<roll>/recordings/…` and
`<ExamName>/<roll>/screenshots/…` appear within seconds of submit.

> **Evidence Archive** (`/teacher/evidence`, teacher nav → “Evidence”): browses
> the R2 bucket directly — every exam folder (named after the exam), every
> student folder inside it, and each candidate's recording, per-second
> snapshots, flagged frames, PDF report and AI integrity report — even when no
> attempt row exists in the database. It needs the **`folders` op** in
> `store-artifact`, so redeploy the function after pulling this change:
> `supabase functions deploy store-artifact`.

> **"My bucket still shows `EXAM-2026-…` folders — not the exam name."** An R2
> folder is created once, at the moment of the first upload. Everything written
> before this layout shipped keeps its old `EXAM-2026-…` top folder forever
> (the review pages intentionally read BOTH layouts and merge, so nothing is
> lost). New exams — e.g. "Test 3" — create a readable `Test-3/<roll>/…`
> folder on their **first successful upload after this change**. To confirm,
> submit a short exam and look for the new folder; the old ones are safe to
> leave exactly where they are.

## 4b. AI integrity report (per-attempt verdict on the violation timeline)

The **AI Integrity Report** on the teacher's evaluation screen is generated by
the `proctor-ai-report` Edge Function: it reads the candidate's real
`violation_events` rows and asks an OpenAI-compatible LLM to summarise them
into a risk score + verdict. If it shows *"Report unavailable: Edge Function
returned a non-2xx status code"* the cause is one of: function not deployed
(404), LLM secret missing (503), or a runtime failure — the card now prints the
exact reason it got from the server.

```bash
# 1. Deploy the function:
supabase functions deploy proctor-ai-report

# 2. Set the LLM secret (OpenAI-compatible). OpenAI example:
supabase secrets set \
  LLM_API_KEY=sk-... \
  LLM_BASE_URL=https://api.openai.com/v1 \
  LLM_MODEL=gpt-4o-mini
```

The `HF_API_KEY` / `GROQ_API_KEY` values in `.env.local` are **not read** by
this function (or by any code) — the key must be set as the `LLM_API_KEY`
**Edge Function secret** above. If you have a GROQ key (`gsk_…`), use:

```bash
supabase secrets set \
  LLM_API_KEY=gsk-... \
  LLM_BASE_URL=https://api.groq.com/openai/v1 \
  LLM_MODEL=openai/gpt-oss-20b
```

⚠️ **Model names change on Groq** — `llama-3.1-8b-instant` was retired and
now returns `model_not_found` (the function fails with HTTP 502 "AI report
generation failed"). Verify the key + a valid model before testing:

```bash
curl -s https://api.groq.com/openai/v1/models -H "Authorization: Bearer gsk-..."
```

Pick any chat model listed (e.g. `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`) and
set it as `LLM_MODEL`.

Once set, open a submitted attempt's evaluation view and click **Generate**.
The report is cached in the `ai_reports` table per attempt (migration
`20260911000001_ai_reports.sql`).

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
  server-side events.

### Proctor AI engine (real-time browser detection)

Detection logic lives in `src/proctoring/` as pure, unit-tested modules that
`src/components/ProctorAI.tsx` (a thin controller) drives:

- `config.ts` — every threshold, cadence, cooldown and risk weight in one
  place (gaze deviation, sustain samples, phone confirmation window, …).
- `labels.ts` — model-label normalization. "headphones" never matches
  "phone" (word-boundary matching); unknown labels surface in diagnostics
  instead of being silently dropped.
- `ObjectTracker.ts` — identity + temporal confirmation: a phone must be seen
  3× inside 9 s to be confirmed; a missed sample does not kill the track.
- `fusion.ts` — the rule that matters: head-down is `gaze_away` ONLY;
  `possible_phone_use` requires a *confirmed* phone *while* head is down.
- `risk.ts` / `violations.ts` — decaying 0–100 risk score; per-category
  cooldown/dedupe so one glance is logged once, not 40 times.
- `ProctorDebugOverlay.tsx` — dev-only HUD (face/gaze/tracks/conf/risk).
  Enable with `VITE_PROCTOR_DEBUG=1` or `?proctorDebug=1` on the URL.

Tuning without code edits: edit `src/proctoring/config.ts` (e.g. raise
`PHONE_MIN_CONF`, lengthen `TRACKING.CONFIRM_WINDOW_MS` for fewer false
positives, or adjust `RISK.WEIGHTS`).

- **Recording retention**: screenshots upload to R2 via `store-artifact`. Define
  retention, access control, and a review UI for saved camera/screen artifacts.
- **Scale/observability**: add error reporting, LiveKit egress/recording if you
  need durable video, and load-test realtime with a full cohort.
- **Legal**: consent screens, data-retention policy, and accessibility review.

