-- Moodle LTI hardening.
--  * Students are matched only on admin-controlled data (Moodle ID number) or
--    an explicit (issuer, sub) link; anyone else waits for a teacher to confirm.
--  * Teachers manage only Moodle courses/activities they launched as an
--    instructor, after proving it with a signed instructor launch.
--  * Failed grade posts are queued and retried with backoff.
-- All LTI tables are reached through the `lti` Edge Function (service role);
-- browsers get no direct access.

-- Every platform must list its deployment ids.
alter table public.lti_platforms alter column deployment_ids drop default;
alter table public.lti_platforms
  add constraint lti_platforms_deployment_required check (cardinality(deployment_ids) >= 1);

-- Teachers no longer read or map links directly: the function checks that the
-- teacher launched the course in Moodle before showing or changing anything.
drop policy if exists "lti platforms teacher read" on public.lti_platforms;
drop policy if exists "lti links teacher read" on public.lti_links;
drop policy if exists "lti links owner map" on public.lti_links;
revoke all on public.lti_platforms, public.lti_links from anon, authenticated;

-- Moodle user who launched but matched no student yet.
create table if not exists public.lti_pending_users (
  id              uuid primary key default gen_random_uuid(),
  platform_id     uuid not null references public.lti_platforms(id) on delete cascade,
  sub             text not null,
  name            text,
  email           text,
  username        text,
  sourced_id      text,
  context_id      text,
  context_title   text,
  link_id         uuid references public.lti_links(id) on delete set null,
  first_seen_at   timestamptz not null default now(),
  last_launch_at  timestamptz not null default now(),
  unique (platform_id, sub)
);

-- Moodle instructor account (issuer, sub) proven to belong to a platform teacher.
create table if not exists public.lti_teachers (
  platform_id      uuid not null references public.lti_platforms(id) on delete cascade,
  sub              text not null,
  teacher_auth_id  uuid not null,
  linked_at        timestamptz not null default now(),
  primary key (platform_id, sub)
);
create index if not exists lti_teachers_auth_idx on public.lti_teachers (teacher_auth_id);

-- Which instructor launched which course (context) and activity (link).
create table if not exists public.lti_instructor_launches (
  platform_id     uuid not null references public.lti_platforms(id) on delete cascade,
  sub             text not null,
  link_id         uuid not null references public.lti_links(id) on delete cascade,
  context_id      text,
  last_launch_at  timestamptz not null default now(),
  primary key (platform_id, sub, link_id)
);
create index if not exists lti_instructor_launches_ctx_idx on public.lti_instructor_launches (platform_id, context_id);

-- One-time proof from an instructor launch, redeemed by a signed-in teacher.
create table if not exists public.lti_claims (
  claim_hash   text primary key,
  platform_id  uuid not null references public.lti_platforms(id) on delete cascade,
  sub          text not null,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);

-- Grade post queue.
alter table public.lti_grade_targets add column if not exists pending_score numeric;
alter table public.lti_grade_targets add column if not exists post_attempts int not null default 0;
alter table public.lti_grade_targets add column if not exists next_attempt_at timestamptz;
create index if not exists lti_grade_targets_due_idx on public.lti_grade_targets (next_attempt_at)
  where pending_score is not null and next_attempt_at is not null;

alter table public.lti_pending_users       enable row level security;
alter table public.lti_teachers            enable row level security;
alter table public.lti_instructor_launches enable row level security;
alter table public.lti_claims              enable row level security;
revoke all on public.lti_pending_users, public.lti_teachers, public.lti_instructor_launches, public.lti_claims
  from anon, authenticated;
