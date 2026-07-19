-- Phase 4 — per-user recording engine rollout control.
--
-- STATUS: DESIGN-REVIEWED / NOT DEPLOYED / NOT EMPIRICALLY VERIFIED
--
-- The policy set below has been reviewed by construction only. No Supabase
-- CLI, psql, Docker instance, or service-role credential was available, so it
-- has never been executed against a database. Do not treat it as verified
-- until the checks in docs/verification/phase-4b-activation-runbook.md pass.
--
-- Applying this requires explicit approval and a service-role credential that
-- is not available to the app.
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
-- Verification queries — run every one of these after applying.
-- Full procedure: docs/verification/phase-4b-activation-runbook.md
-- ---------------------------------------------------------------------------
--
-- (1) As an UNAUTHENTICATED client (anon key), this must return zero rows or
--     a permission error — never another user's data:
--       select * from public.recording_engine_rollout;
--
-- (2) As ordinary user A, this must return ONLY A's own row (0 or 1 rows):
--       select user_id from public.recording_engine_rollout;
--
-- (3) CROSS-USER READ — as ordinary user B, with A's uuid substituted, this
--     must return ZERO rows:
--       select * from public.recording_engine_rollout
--         where user_id = '<user-A-uuid>';
--
-- (4) SELF-ENROLLMENT — every one of these must FAIL as an ordinary user:
--       insert into public.recording_engine_rollout (user_id, engine, enabled)
--         values (auth.uid(), 'nativeDurable', true);
--       update public.recording_engine_rollout set enabled = true;
--       update public.recording_engine_rollout set kill_switch = false;
--       delete from public.recording_engine_rollout;
--
-- If ANY of (3) or (4) succeeds, STOP and run the rollback: users could read
-- other accounts or enroll themselves.
--
-- ---------------------------------------------------------------------------
-- Operator procedures (service role only; bypasses RLS)
-- ---------------------------------------------------------------------------
--
-- Prefer the CLI, which is dry-run by default and redacts identifiers:
--   node scripts/rollout-admin.mjs enable  --user <uuid> --cohort internal \
--     --expires 2026-08-01 --commit
--   node scripts/rollout-admin.mjs disable --user <uuid> --commit
--   node scripts/rollout-admin.mjs revoke  --user <uuid> --commit
--   node scripts/rollout-admin.mjs inspect --user <uuid>
--
-- Equivalent SQL, if the CLI is unavailable:
--
--   -- ADMIN WRITE (enroll):
--   insert into public.recording_engine_rollout
--     (user_id, engine, enabled, cohort, expires_at)
--     values ('<uuid>', 'nativeDurable', true, 'internal', '2026-08-01T00:00:00Z')
--   on conflict (user_id) do update set
--     engine = excluded.engine, enabled = excluded.enabled,
--     cohort = excluded.cohort, expires_at = excluded.expires_at,
--     kill_switch = false, updated_at = now();
--
--   -- REVOKE one user (keeps the row, so the decision stays auditable):
--   update public.recording_engine_rollout
--     set enabled = false, kill_switch = true, updated_at = now()
--     where user_id = '<uuid>';
--
--   -- KILL SWITCH for everyone (stops all NEW native sessions; active
--   -- recordings finish on their frozen engine and stay recoverable):
--   update public.recording_engine_rollout
--     set kill_switch = true, updated_at = now();
--
--   -- EMERGENCY ROLLBACK — disable everyone without dropping anything:
--   update public.recording_engine_rollout
--     set enabled = false, kill_switch = true, updated_at = now();
--   -- then, only if the mechanism itself must go, apply the .rollback.sql file.
--
-- All of the above take effect within the client cache TTL (15 minutes) or on
-- next launch. None of them deletes durable audio or affects recovery.
