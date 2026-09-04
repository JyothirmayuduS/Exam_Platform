-- Seed demo teacher + proctor so the LiveKit Edge Function can look up roles by email.
-- auth_id is a placeholder UUID — the Edge Function uses email-based lookup as primary.
-- The auth_id column is made nullable to allow rows without a linked auth user.
ALTER TABLE public.teachers ALTER COLUMN auth_id DROP NOT NULL;

INSERT INTO public.teachers (name, email, role, auth_id) VALUES
  ('Demo Teacher', 'teacher@vignan.ac.in', 'teacher', '00000000-0000-0000-0000-000000000001'::uuid),
  ('Demo Proctor', 'proctor@vignan.ac.in', 'proctor', '00000000-0000-0000-0000-000000000002'::uuid)
ON CONFLICT (email) DO NOTHING;
