-- Tables live has but no migration created; 20261008203347_close_staff_escalation
-- drops policies on them. Definitions match live.

create table if not exists public.appeal_requests (
  id uuid default gen_random_uuid() not null,
  attempt_id uuid not null,
  student_id uuid not null,
  question_id text,
  reason text,
  requested_score numeric(5,2),
  status text default 'pending'::text,
  teacher_response text,
  reviewed_by uuid,
  reviewed_at timestamp without time zone,
  created_at timestamp without time zone default now(),
  constraint appeal_requests_pkey PRIMARY KEY (id),
  constraint appeal_requests_reviewer_fk FOREIGN KEY (reviewed_by) REFERENCES auth.users(id),
  constraint appeal_requests_student_fk FOREIGN KEY (student_id) REFERENCES auth.users(id)
);
create index if not exists idx_appeal_requests_attempt_id ON public.appeal_requests (attempt_id);
create index if not exists idx_appeal_requests_student_id ON public.appeal_requests (student_id);
alter table public.appeal_requests enable row level security;

create table if not exists public.comments (
  id uuid default gen_random_uuid() not null,
  attempt_id uuid not null,
  question_id text,
  author_id uuid not null,
  comment_text text,
  comment_type text default 'text'::text,
  score_awarded numeric(5,2),
  created_at timestamp without time zone default now(),
  updated_at timestamp without time zone default now(),
  constraint comments_author_fk FOREIGN KEY (author_id) REFERENCES auth.users(id),
  constraint comments_pkey PRIMARY KEY (id)
);
create index if not exists idx_comments_author_id ON public.comments (author_id);
create index if not exists idx_comments_attempt_id ON public.comments (attempt_id);
alter table public.comments enable row level security;

create table if not exists public.exam_access_logs (
  id uuid default gen_random_uuid() not null,
  attempt_id uuid,
  exam_id text,
  student_id uuid,
  action text,
  "timestamp" timestamp without time zone default now(),
  ip_address text,
  user_agent text,
  created_at timestamp without time zone default now(),
  constraint exam_access_logs_pkey PRIMARY KEY (id)
);
create index if not exists idx_exam_access_logs_student_id ON public.exam_access_logs (student_id);
create index if not exists idx_exam_access_logs_timestamp ON public.exam_access_logs ("timestamp");
create index if not exists idx_exam_access_logs_attempt_id ON public.exam_access_logs (attempt_id);
create index if not exists idx_exam_access_logs_exam_id ON public.exam_access_logs (exam_id);
alter table public.exam_access_logs enable row level security;

create table if not exists public.notifications (
  id uuid default gen_random_uuid() not null,
  recipient_id uuid not null,
  exam_id text,
  notification_type text,
  email_address text,
  subject text,
  body text,
  email_sent_at timestamp without time zone,
  delivery_status text default 'pending'::text,
  error_message text,
  created_at timestamp without time zone default now(),
  constraint notifications_pkey PRIMARY KEY (id),
  constraint notifications_recipient_fk FOREIGN KEY (recipient_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
create index if not exists idx_notifications_recipient_id ON public.notifications (recipient_id);
create index if not exists idx_notifications_exam_id ON public.notifications (exam_id);
create index if not exists idx_notifications_delivery_status ON public.notifications (delivery_status);
alter table public.notifications enable row level security;

create table if not exists public.recordings (
  id uuid default gen_random_uuid() not null,
  attempt_id uuid not null,
  exam_id text,
  student_id uuid not null,
  recording_type text,
  storage_path text,
  storage_bucket text,
  file_size_bytes bigint,
  duration_seconds integer,
  mime_type text,
  status text default 'processing'::text,
  started_at timestamp without time zone,
  ended_at timestamp without time zone,
  expires_at timestamp without time zone,
  created_at timestamp without time zone default now(),
  constraint recordings_pkey PRIMARY KEY (id),
  constraint recordings_student_fk FOREIGN KEY (student_id) REFERENCES auth.users(id)
);
create index if not exists idx_recordings_attempt_id ON public.recordings (attempt_id);
create index if not exists idx_recordings_student_id ON public.recordings (student_id);
create index if not exists idx_recordings_exam_id ON public.recordings (exam_id);
alter table public.recordings enable row level security;
