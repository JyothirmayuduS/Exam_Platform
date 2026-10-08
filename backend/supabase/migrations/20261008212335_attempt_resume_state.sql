-- Where the candidate was (question index, section, section seconds left,
-- client savedAt ms). Written with each autosave so a reload, a kiosk
-- relaunch or another device resumes in place.
alter table public.attempts add column if not exists resume_state jsonb;
comment on column public.attempts.resume_state is 'Where the candidate was (question index, section, section seconds left, client savedAt ms); written with each autosave so a reload or another device resumes in place.';
