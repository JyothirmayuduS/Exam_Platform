-- Migration: Secure Mobile Monitoring Scanner & Interruption Ledger
-- Date: 2026-09-15

-- 1. Extend existing mobile_upload_sessions table with monitoring metadata
ALTER TABLE public.mobile_upload_sessions
  ADD COLUMN IF NOT EXISTS nonce text,
  ADD COLUMN IF NOT EXISTS exam_id text REFERENCES public.exams(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS camera_status text DEFAULT 'WAITING',
  ADD COLUMN IF NOT EXISTS livekit_room text,
  ADD COLUMN IF NOT EXISTS livekit_identity text,
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz,
  ADD COLUMN IF NOT EXISTS ended_at timestamptz;

-- 2. Create mobile_session_events ledger table
CREATE TABLE IF NOT EXISTS public.mobile_session_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES public.mobile_upload_sessions(id) ON DELETE CASCADE NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'QR_SCANNED',
    'CAMERA_PERMISSION_GRANTED',
    'CAMERA_PERMISSION_DENIED',
    'CAMERA_STARTED',
    'CAMERA_STOPPED',
    'LIVEKIT_CONNECTED',
    'LIVEKIT_DISCONNECTED',
    'VISIBILITY_HIDDEN',
    'VISIBILITY_VISIBLE',
    'FOCUS_LOST',
    'FOCUS_REGAINED',
    'VIEWPORT_RESIZED',
    'NO_FACE_DETECTED',
    'FACE_REACQUIRED',
    'HEARTBEAT_MISSED'
  )),
  metadata jsonb DEFAULT '{}'::jsonb,
  severity text CHECK (severity IN ('minor', 'moderate', 'major')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Indexes for fast session telemetry lookups
CREATE INDEX IF NOT EXISTS idx_mobile_session_events_session
  ON public.mobile_session_events(session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_mobile_upload_sessions_token_hash
  ON public.mobile_upload_sessions(token_hash);

-- 4. Add to Realtime publication
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'mobile_session_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.mobile_session_events;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'mobile_upload_sessions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.mobile_upload_sessions;
  END IF;
END $$;

-- 5. Row Level Security Policies
ALTER TABLE public.mobile_session_events ENABLE ROW LEVEL SECURITY;

-- Drop prior policies if existing to avoid conflicts on repeat execution
DROP POLICY IF EXISTS "Students read own mobile session events" ON public.mobile_session_events;
DROP POLICY IF EXISTS "Staff read all mobile session events" ON public.mobile_session_events;
DROP POLICY IF EXISTS "Service role full access mobile events" ON public.mobile_session_events;

CREATE POLICY "Students read own mobile session events"
  ON public.mobile_session_events FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.mobile_upload_sessions s
    WHERE s.id = mobile_session_events.session_id
    AND s.student_id = public.current_student_id()
  ));

CREATE POLICY "Staff read all mobile session events"
  ON public.mobile_session_events FOR SELECT
  USING (public.auth_is_staff());

CREATE POLICY "Service role full access mobile events"
  ON public.mobile_session_events FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role')
  WITH CHECK (auth.jwt() ->> 'role' = 'service_role');
