-- Vignan OS — Enterprise attempt telemetry & consent columns
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds the audit/telemetry columns the exam & proctor consoles now write:
--   attempts.consent_at   — when the candidate accepted the monitoring notice
--   attempts.consent_text — snapshot of the consent text (audit trail)
--   attempts.user_agent   — candidate browser UA (device column in proctoring)
-- Safe, additive only. Idempotent for re-runs.

alter table public.attempts
  add column if not exists consent_at   timestamptz,
  add column if not exists consent_text text,
  add column if not exists user_agent   text;

-- Exam-scoped lookups of consent/telemetry stay indexed.
create index if not exists attempts_consent_idx
  on public.attempts (exam_id, consent_at);

comment on column public.attempts.consent_at   is 'When the candidate accepted the recording/monitoring notice.';
comment on column public.attempts.consent_text is 'Snapshot of the consent wording shown at that time (audit).';
comment on column public.attempts.user_agent   is 'Candidate browser User-Agent captured at attempt start.';
