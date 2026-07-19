-- Phase 4 — per-user recording engine rollout control.
--
-- STATUS: NOT DEPLOYED. Prepared and reviewed only. Applying this requires
-- explicit approval and a service-role credential that is not available to the
-- app. See docs/verification/phase-4-rollout-control.md.
--
-- Purpose: let an operator move an individual user onto the durable native
-- recorder, and revoke it, without shipping a new build.
--
-- Privacy: this table stores no email, no lecture or audio metadata, no
-- purchase or entitlement state, no device identifier and no IP address. It
-- holds only the auth user id it applies to plus the rollout decision itself.

create table if not exists public.recording_engine_rollout (
  user_id uuid primary key references auth.users (id) on delete cascade,
  engine text not null default 'legacy'
    check (engine in ('legacy', 'nativeDurable')),
  enabled boolean not null default false,
  cohort text not null default 'disabled'
    check (cohort in ('disabled', 'internal', 'limited_beta')),
  -- Operator kill switch. Forces new recordings back to legacy for this user
  -- without deleting the row, so the previous decision stays auditable.
  kill_switch boolean not null default false,
  rollout_revision integer not null default 1,
  -- Optional automatic expiry. A null expiry never expires; a past expiry is
  -- treated by the client exactly like "not eligible".
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.recording_engine_rollout is
  'Per-user native recorder rollout control. Operator-managed; users have read-only access to their own row.';

-- ---------------------------------------------------------------------------
-- Row Level Security — fails closed.
-- ---------------------------------------------------------------------------

alter table public.recording_engine_rollout enable row level security;
-- Ensures even the table owner is subject to RLS.
alter table public.recording_engine_rollout force row level security;

-- A signed-in user may read their own row and nothing else. There is
-- deliberately NO insert, update or delete policy: with RLS enabled, any
-- statement without a matching policy is denied. Writes are therefore possible
-- only via the service role, which bypasses RLS and is never in the client.
drop policy if exists "read own rollout" on public.recording_engine_rollout;
create policy "read own rollout"
  on public.recording_engine_rollout
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Least privilege: no access for anonymous visitors, read-only for signed-in
-- users. No column-level write grant is issued to any client role.
revoke all on public.recording_engine_rollout from anon, authenticated;
grant select on public.recording_engine_rollout to authenticated;

-- ---------------------------------------------------------------------------
-- Verification queries (run after applying, as an ordinary authenticated user)
-- ---------------------------------------------------------------------------
--
--   -- Must return only the caller's own row (0 or 1 rows):
--   select user_id from public.recording_engine_rollout;
--
--   -- All of these must fail with a permissions/RLS error:
--   insert into public.recording_engine_rollout (user_id, engine, enabled)
--     values (auth.uid(), 'nativeDurable', true);
--   update public.recording_engine_rollout set enabled = true;
--   delete from public.recording_engine_rollout;
--
-- If any write succeeds as an ordinary user, STOP: the policy set is wrong and
-- users could enroll themselves.
