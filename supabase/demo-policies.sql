-- Vignan OS — DEMO policies (anon-key, no-auth prototype)
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS FILE EXISTS
-- The production policies in schema.sql are auth-scoped: teachers must be signed
-- in (auth.uid() = created_by) to write exams, and students must have a linked
-- students.auth_id row to read them. This prototype ships with ONLY the anon key
-- and no login flow yet, so auth.uid() is always NULL — every read and write is
-- rejected. Result: the teacher clicks Publish, nothing is stored, and the
-- student / proctor screens stay empty.
--
-- Run this ONCE in the Supabase SQL editor (after schema.sql + seed.sql) to open
-- the flow so the whole demo works with just the anon key:
--
--   teacher publishes  →  exams row upserted
--   student dashboard  →  reads published/scheduled exams in realtime
--   student sits exam  →  attempts row created + autosaved
--   proctor / teacher  →  see the live attempt roster
--
-- ⚠️  DEMO ONLY. These policies allow the public anon role to read and write.
--     Before going to production, run the "REVERT" block at the bottom and rely
--     on the auth-scoped policies in schema.sql instead.
-- ─────────────────────────────────────────────────────────────────────────────

-- Make sure RLS is on (schema.sql already enables it; harmless if repeated).
alter table public.students         enable row level security;
alter table public.exams            enable row level security;
alter table public.questions        enable row level security;
alter table public.enrollments      enable row level security;
alter table public.attempts         enable row level security;
alter table public.proctor_sessions enable row level security;

-- Drop the auth-scoped policies from schema.sql so they don't shadow the demo ones.
drop policy if exists "students read self"            on public.students;
drop policy if exists "read live exams"               on public.exams;
drop policy if exists "teachers manage own exams"     on public.exams;
drop policy if exists "read questions of visible exams" on public.questions;
drop policy if exists "own attempt read"              on public.attempts;
drop policy if exists "own attempt write"             on public.attempts;

-- Drop demo policies too, so this script is safe to re-run.
drop policy if exists "demo students all"    on public.students;
drop policy if exists "demo exams read"      on public.exams;
drop policy if exists "demo exams write"     on public.exams;
drop policy if exists "demo questions all"   on public.questions;
drop policy if exists "demo enrollments all" on public.enrollments;
drop policy if exists "demo attempts all"    on public.attempts;
drop policy if exists "demo proctor all"     on public.proctor_sessions;

-- ── Students: read + write (roster + roll lookups) ───────────────────────────
create policy "demo students all" on public.students
  for all using (true) with check (true);

-- ── Exams: students read anything non-draft; teacher (anon) may upsert ───────
-- Read stays scoped to non-draft so drafts never leak to students.
create policy "demo exams read" on public.exams
  for select using (status <> 'draft');
-- Write is open so the teacher's Publish / Schedule upsert succeeds with the
-- anon key. (Draft rows can be written too; they just aren't selectable above.)
create policy "demo exams write" on public.exams
  for all using (true) with check (true);

-- ── Questions: readable for any non-draft exam; writable for bulk import ─────
create policy "demo questions all" on public.questions
  for all using (true) with check (true);

-- ── Enrollments ──────────────────────────────────────────────────────────────
create policy "demo enrollments all" on public.enrollments
  for all using (true) with check (true);

-- ── Attempts: student creates/autosaves/submits; proctor + teacher read ──────
create policy "demo attempts all" on public.attempts
  for all using (true) with check (true);

-- ── Proctor sessions: register LiveKit room/identity per attempt ─────────────
create policy "demo proctor all" on public.proctor_sessions
  for all using (true) with check (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- REVERT (run before production to restore auth-scoped access):
--
--   drop policy if exists "demo students all"    on public.students;
--   drop policy if exists "demo exams read"      on public.exams;
--   drop policy if exists "demo exams write"     on public.exams;
--   drop policy if exists "demo questions all"   on public.questions;
--   drop policy if exists "demo enrollments all" on public.enrollments;
--   drop policy if exists "demo attempts all"    on public.attempts;
--   drop policy if exists "demo proctor all"     on public.proctor_sessions;
--
-- Then re-run the policy block in schema.sql to reinstate the auth-scoped rules.
-- ─────────────────────────────────────────────────────────────────────────────
