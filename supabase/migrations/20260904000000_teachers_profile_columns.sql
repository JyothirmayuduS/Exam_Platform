-- Add missing profile columns to teachers table to match frontend expectations
alter table public.teachers add column if not exists full_name text;
alter table public.teachers add column if not exists department text default 'Computer Science';
alter table public.teachers add column if not exists designation text default 'Faculty';

-- Backfill full_name from name if empty
update public.teachers set full_name = name where full_name is null;

-- The name column is kept for backwards compat; frontend now uses full_name
