# Vignan Exam Platform — Codebase Map

This repository is a Vite + React + TypeScript SPA backed by Supabase, LiveKit,
R2-compatible artifact storage, and a Tauri lockdown desktop app. The source is
organized by **product feature first**, then by the type of code owned by that
feature.

## Start here

```text
src/
├── App.tsx                 # Route composition only
├── main.tsx                # Browser/Tauri bootstrap only
├── index.css               # Global theme styles
├── features/               # Product areas; feature code stays together
│   ├── auth/               # Login, auth provider, route/profile guards
│   ├── student/            # Student console and live exam experience
│   ├── teacher/            # Teacher, examiner, evaluation and evidence tools
│   ├── proctoring/         # Live monitoring UI and detection engine
│   └── mobile/             # Phone upload and secondary-monitor flows
├── shared/                 # Reusable code with no single product owner
│   ├── components/         # UI kit, layout, error and system components
│   ├── data/               # Supabase client and API/query modules
│   ├── pages/              # Landing and not-found pages
│   ├── platform/           # Tauri/deep-link/platform adapters
│   ├── services/           # Storage, paper, report and export services
│   └── types/              # Ambient/vendor types
├── assets/                 # Build-time images and icons
└── test/                   # Vitest setup
```

A new engineer should normally find a file by asking:

1. **Which user or workflow owns it?** Open `src/features/<area>`.
2. **Is it used by multiple features?** Look in `src/shared`.
3. **Is it database access?** Look in `src/shared/data/api`.
4. **Is it pure proctoring math?** Look in `src/features/proctoring/domain`.
5. **Is it a route?** Find the feature page, then register it in `src/App.tsx`.

## Feature boundaries

### `src/features/auth`

Authentication and identity resolution:

- `auth.tsx` — Supabase/demo auth provider and sign-out behavior.
- `pages/` — Login and password recovery screens.
- `components/ProtectedRoute.tsx` — role and session route guard.
- `hooks/useCurrentProfile.ts` — current student/teacher profile lookup.

### `src/features/student`

Everything a candidate sees or uses:

- `pages/` — dashboard, enrolled exams, exam details, practice, results, help,
  and the live `StudentExam` session.
- `components/exam/` — exam flow screens, question panels, answer entry,
  device access, identity verification, QR answer upload and submission UI.
- `components/` — student-only exam countdown and tools.
- `hooks/` — answer state, timer, autosave, keyboard shortcuts and offline sync.

### `src/features/teacher`

Faculty and examiner workflows:

- `pages/` — dashboard, test builder, question bank, roster, submissions,
  evaluation, examiner delegation and evidence browser.
- `components/teacher/` — teacher-specific modals and selectors.
- `hooks/` — teacher exam-scope and live-attempt query hooks.
- `services/` — evaluator/proctor email helpers and manual-evaluation helpers.

### `src/features/proctoring`

Live invigilation and integrity analysis:

- `pages/` — teacher live proctoring and the dedicated proctor grid.
- `components/` — camera publishing, AI controller, recording review, voice,
  chat and integrity panels.
- `hooks/` — student-side violation/proctoring lifecycle hook.
- `services/` — LiveKit publishing/viewing/voice, recording, and server-side
  watchdog adapters.
- `domain/` — DOM-free, unit-tested detection types, labels, geometry, risk,
  tracking, fusion and violation rules. This is the safest place for pure
  proctoring logic.
- `domain/model/` — local model/training metadata used by the detector.

### `src/features/mobile`

Phone-only workflows and their API adapters:

- `pages/` — QR answer upload and secondary monitor screens.
- `services/` — mobile upload retry handling, monitor sessions and related tests.

## Shared layers

### `src/shared/data`

The application data boundary. Pages and feature components should use these
modules instead of creating ad-hoc Supabase clients or queries.

- `supabase.ts`, `env.ts`, `org.ts` — shared runtime configuration.
- `examApi.ts` — compatibility barrel for the domain API modules.
- `api/` — one module per data domain: exams, questions, students, attempts,
  live roster, proctoring, chat, assignments, grading, teacher settings and
  audit. `types.ts` contains shared row types; `helpers.ts` contains internal
  normalizers.

Add a new database operation to the matching `shared/data/api/<domain>.ts`
module. Keep `examApi.ts` as a barrel.

### `src/shared/services`

Cross-feature application services:

- `examStorage.ts`, `r2Function.ts`, `snapshotOutbox.ts` — artifact storage and
  reliable evidence upload.
- `paperBuilder.ts` — deterministic per-student paper snapshots.
- `sessionReport.ts`, `rosterModel.ts`, `zipExport.ts` — reports, view models
  and exports used by teacher/proctor screens.
- `subjectiveUpload.ts`, `watermark.ts` — answer-image processing and exam
  watermark rendering.

### `src/shared/platform`

Browser/native boundary code:

- `platform.ts` — OS and Tauri detection plus installer probing.
- `lockdownBridge.ts` — deep-link launch, session handoff and browser-side
  student-console reopening.
- The colocated tests cover cold start, warm start and protocol fallback paths.

### `src/shared/components`

Reusable UI that does not belong to one role: layout, buttons, error handling,
offline state, system checks, image cropping, lockdown notices and the coding
editor.

## Runtime flow

```text
Browser / Tauri entry (src/main.tsx)
        │
        ▼
Route composition (src/App.tsx)
        │
        ├── Feature pages and feature-owned components/hooks
        ├── Shared components and services
        └── Shared data/API modules
                │
                ├── Supabase Auth/Postgres/Realtime
                ├── LiveKit camera, screen and voice rooms
                ├── R2/Supabase Storage for recordings and reports
                └── Tauri native lockdown/deep-link commands
```

## Import and ownership rules

- Use the `@/` alias for imports from `src/`; do not build long chains of
  `../../..` paths.
- Route registration belongs in `src/App.tsx`; route UI belongs in the owning
  feature's `pages/` directory.
- Feature code may depend on `shared`; shared code must not import a feature.
- API/database calls belong in `shared/data/api`; do not put Supabase queries in
  page components.
- Pure proctoring calculations belong in `features/proctoring/domain` and must
  remain DOM-free and unit-testable.
- Keep tests beside the module they protect.
- Keep `main.tsx` and `App.tsx` intentionally small: bootstrap and composition,
  not business logic.

## Checks after structural changes

```bash
npx tsc -b
npx vitest run
npm run build
cargo check --manifest-path src-tauri/Cargo.toml --locked --bins
```
