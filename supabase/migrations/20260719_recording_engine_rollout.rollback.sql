-- Rollback for 20260719_recording_engine_rollout.sql
--
-- STATUS: NOT DEPLOYED (the forward migration has not been applied either).
--
-- Safety: this table holds only rollout decisions. Dropping it does NOT touch
-- recordings, lectures, profiles, audio, or any durable native session on a
-- device. Unfinished native recordings stay recoverable, because recovery
-- follows durable session provenance rather than rollout state.
--
-- After dropping, every client falls back to the committed default (legacy) as
-- soon as its cached decision expires — at most ROLLOUT_CACHE_TTL_MS
-- (15 minutes). No app rebuild is required.

-- Preferred rollback: stop the rollout but keep the audit trail.
--   update public.recording_engine_rollout
--     set enabled = false, kill_switch = true, updated_at = now();

-- Full rollback: remove the mechanism entirely.
drop policy if exists "read own rollout" on public.recording_engine_rollout;
drop table if exists public.recording_engine_rollout;
