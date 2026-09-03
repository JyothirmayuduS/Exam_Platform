-- Mobile Upload Sessions
create table if not exists public.mobile_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid references public.attempts(id) on delete cascade not null,
  question_id text not null,
  student_id uuid references public.students(id) on delete cascade not null,
  token_hash text not null unique,
  status text not null default 'WAITING',
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);

alter table public.mobile_upload_sessions enable row level security;

create policy "Students can view their own mobile upload sessions"
  on public.mobile_upload_sessions for select
  using ( student_id in (select id from public.students where auth_id = auth.uid()) );

-- Allow insertion of sessions by authenticated students for their own attempt
create policy "Students can create mobile upload sessions"
  on public.mobile_upload_sessions for insert
  with check ( student_id in (select id from public.students where auth_id = auth.uid()) );

-- Edge functions (service_role) bypass RLS, so no update policy needed here for the backend.

-- Question Submissions (Tracking the actual PDFs/Images per question)
create table if not exists public.question_submissions (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid references public.attempts(id) on delete cascade not null,
  question_id text not null,
  student_id uuid references public.students(id) on delete cascade not null,
  original_storage_path text,
  watermarked_storage_path text,
  pdf_storage_path text,
  mime_type text,
  file_size bigint,
  status text not null default 'COMPLETED',
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.question_submissions enable row level security;

create policy "Students can view their own submissions"
  on public.question_submissions for select
  using ( student_id in (select id from public.students where auth_id = auth.uid()) );

-- Create realtime publication for mobile_upload_sessions so Desktop can listen
begin;
  -- Add table to the 'supabase_realtime' publication if it exists
  drop publication if exists supabase_realtime cascade;
  create publication supabase_realtime;
  alter publication supabase_realtime add table public.mobile_upload_sessions;
commit;
