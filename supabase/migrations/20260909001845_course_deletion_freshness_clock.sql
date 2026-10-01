-- Canonical, account-level course deletion freshness clock — the courses-table
-- twin of recordings.deletion_updated_at (20260908152059). Existing rows remain
-- unaffected because the new nullable column defaults to NULL.
begin;

alter table public.courses
  add column if not exists deletion_updated_at timestamptz;

commit;
