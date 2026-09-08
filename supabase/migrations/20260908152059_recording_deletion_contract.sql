-- Canonical, account-level recording soft-delete state.
-- Existing rows remain active because both new nullable columns default to NULL.
begin;

alter table public.recordings
  add column if not exists deleted_at timestamptz,
  add column if not exists deletion_updated_at timestamptz;

commit;
