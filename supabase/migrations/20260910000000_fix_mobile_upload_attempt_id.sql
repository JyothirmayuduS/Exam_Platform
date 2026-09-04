-- Fix: Change attempt_id from uuid FK to TEXT so that "pending_<studentId>" placeholder
-- can be stored initially, and updated when the real attempt is created.
-- Also ensure student_answers table is properly created and indexed.

BEGIN;

-- Drop FK constraint on attempt_id, change to TEXT
ALTER TABLE public.mobile_upload_sessions
  DROP CONSTRAINT IF EXISTS "mobile_upload_sessions_attempt_id_fkey",
  ALTER COLUMN attempt_id TYPE text;

-- Make sure student_answers table exists (created in previous migration but might not have run)
CREATE TABLE IF NOT EXISTS public.student_answers (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid references public.attempts(id) on delete cascade not null,
  question_id text not null,
  student_id uuid references public.students(id) on delete cascade not null,
  answer_text text,
  uploaded_image_url text,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(attempt_id, question_id)
);

-- Drop and recreate RLS policies for student_answers
ALTER TABLE public.student_answers enable row level security;

DROP POLICY IF EXISTS "Students can upsert their own answers" ON public.student_answers;
DROP POLICY IF EXISTS "Students can update their own answers" ON public.student_answers;
DROP POLICY IF EXISTS "Students can view their own answers" ON public.student_answers;
DROP POLICY IF EXISTS "Teachers can view all student answers" ON public.student_answers;

CREATE POLICY "Students can upsert their own answers"
  ON public.student_answers FOR INSERT
  WITH CHECK ( student_id in (select id from public.students where auth_id = auth.uid()) );

CREATE POLICY "Students can update their own answers"
  ON public.student_answers FOR UPDATE
  USING ( student_id in (select id from public.students where auth_id = auth.uid()) );

CREATE POLICY "Students can view their own answers"
  ON public.student_answers FOR SELECT
  USING ( student_id in (select id from public.students where auth_id = auth.uid())
          OR auth.uid() in (select auth_id from public.teachers) );

CREATE POLICY "Teachers can view all student answers"
  ON public.student_answers FOR SELECT
  USING ( auth.uid() in (select auth_id from public.teachers) );

-- Indexes
CREATE INDEX IF NOT EXISTS idx_student_answers_attempt ON public.student_answers(attempt_id);
CREATE INDEX IF NOT EXISTS idx_mobile_upload_expires ON public.mobile_upload_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_mobile_upload_token ON public.mobile_upload_sessions(token_hash);

-- Update existing sessions with pending_<studentId> to use the correct attempt_id
-- This runs AFTER the attempts table has the right records
-- Only updates rows that still have 'pending_' prefix
UPDATE public.mobile_upload_sessions
SET attempt_id = a.id
FROM public.attempts a
WHERE mobile_upload_sessions.attempt_id LIKE 'pending_%'
  AND a.exam_id IN (
    SELECT exam_id FROM public.attempts
    WHERE student_id = (
      SELECT student_id FROM public.mobile_upload_sessions mus
      WHERE mus.id = mobile_upload_sessions.id
    )
    LIMIT 1
  )
  AND a.student_id = (
    SELECT student_id FROM public.mobile_upload_sessions mus
    WHERE mus.id = mobile_upload_sessions.id
  )
  AND a.state = 'active'
RETURNING mobile_upload_sessions.id, mobile_upload_sessions.attempt_id;

COMMIT;
