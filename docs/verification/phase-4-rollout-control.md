# Phase 4 — reversible rollout control

Lets an operator move an individual user onto the durable native recorder, and
revoke it, **without shipping a new build**. The global default stays legacy.

> **Backend status: NOT DEPLOYED.** The migration is prepared and reviewed but
> not applied. See [Deployment](#deployment-status) — it needs explicit approval
> and a credential the app does not have.

## Architecture

```
Supabase row ──► rolloutProvider.ts ──► normalized eligibility ──► policy.mjs ──► engine
     │                   │                                             ▲
     │                   └── user-scoped AsyncStorage cache (15m TTL) ──┘
     │                                                                 │
     └── operator writes via service role                durable session provenance
         (scripts/rollout-admin.mjs)                     overrides rollout for recovery
```

The recording policy never talks to Supabase. It consumes a normalized result,
so the whole failure matrix is testable without a network or a device.

Phase 3's build-time cohort flag still works; Phase 4 layers per-user control on
top. Priority: `frozen_session` → `test_override` → `developer_override` →
`remote_rollout` → `internal_dogfood` → `default`.

An authoritative remote "no" beats the build-time flag, so a revoke works
without a rebuild.

## Table

`public.recording_engine_rollout` — one row per user:

| Column | Purpose |
| --- | --- |
| `user_id` | auth user, primary key, `on delete cascade` |
| `engine` | `legacy` \| `nativeDurable` (check constraint) |
| `enabled` | explicit opt-in |
| `cohort` | `disabled` \| `internal` \| `limited_beta` (check constraint) |
| `kill_switch` | operator stop for new recordings |
| `rollout_revision` | integer, for diagnostics |
| `expires_at` | optional automatic expiry |
| `updated_at` | audit |

No email, lecture content, transcript, audio metadata, purchase or entitlement
state, device identifier, or IP address.

## Authorization

- RLS is **enabled and forced** (applies even to the table owner).
- One policy only: `select` for `authenticated` where `auth.uid() = user_id`.
- **No insert/update/delete policy exists.** With RLS on, a statement without a
  matching policy is denied — so ordinary users cannot enroll themselves or read
  anyone else's row.
- `revoke all … from anon, authenticated`, then `grant select … to authenticated`.
- Writes require the service role, which bypasses RLS and lives only on an
  operator machine. It is never in the app, `.env`, or any `EXPO_PUBLIC_*` var.

The client's only query is `.select(...).eq('user_id', userId).maybeSingle()`.
Tests assert the client has no insert/update/upsert/delete path.

**Not empirically verified.** No Supabase CLI, psql, Docker, or service-role
credential is available here, so RLS was reviewed by construction, not executed.
The migration carries verification queries to run after applying — including
writes that **must fail** as an ordinary user.

## Rollout states

| State | Meaning | Engine |
| --- | --- | --- |
| `eligible` | enabled, native, unexpired | native |
| `not_eligible` | disabled, legacy, or cohort `disabled` | legacy |
| `expired` | `expires_at` in the past | legacy |
| `unavailable` | no row, or fetch failed | legacy (cache may apply) |
| `invalid` | malformed row | legacy |

Parsing is strict: a non-boolean `enabled`, unknown engine or cohort,
non-integer revision, or unparseable timestamp all yield `invalid`. Nothing is
best-effort, because a half-written row must never enable native.

## Cache and TTL

`ROLLOUT_CACHE_TTL_MS = 15 minutes`, key `youmi.recordingRollout.v1.<userId>`.

Chosen short deliberately: the TTL is the upper bound on how long a remote
disable or kill switch takes to reach a running app. A long production TTL would
make revoke feel unresponsive; a shorter one adds request load for no benefit at
dogfood scale.

- Cache is keyed **and** stamped with its subject, so a mismatched entry is
  rejected (`rollout_cache_foreign`) rather than trusted — defence in depth.
- A successful fetch always wins over cache, so a remote revoke takes effect
  immediately rather than waiting for expiry.
- On network failure, an **unexpired** cached decision may be reused.
- An expired, foreign, or malformed cache can **never** enable native.
- A clock moving backwards is treated as expired, not as extra cache life.
- `clearRolloutCache(userId)` on sign-out.

## Kill switch

`kill_switch = true` forces **new** recordings to legacy, wins over the per-user
record and the build-time flag, and produces `rollout_kill_switch`.

It deliberately does **not**:

- interrupt an active native recording (the engine is frozen for the session)
- delete or discard any session
- hide unfinished native audio from recovery
- depend on billing or entitlement state

Effective within the 15-minute TTL, or immediately on next launch. No rebuild.

## Active-session engine freeze

The engine is resolved once per recording session and frozen in a ref. A rollout
change, cache refresh, token refresh, or network reconnect cannot switch engines
mid-recording. A new recording resolves the latest decision again.

## Recovery precedence

**Rollout state never decides how existing audio is recovered.**
`resolveRecoveryEngine` follows the durable session's own provenance: if durable
evidence exists, recovery is native, and it reports `overrodeRollout`.

`retainNativeRecovery` stays true under a revoke, under the kill switch, under
an unresolved provider, and under forced legacy. Redirecting native audio into
the legacy recorder — which cannot read it — would lose the recording.

## Cohorts

`disabled`, `internal`, `limited_beta`. **Percentage rollout is deferred**: it
needs deterministic bucketing over a stable anonymous subject, and there is no
existing safe bucketing primitive. No device fingerprinting, no per-launch
randomness.

## Operator workflow

```bash
export SUPABASE_URL=...                # operator machine only
export SUPABASE_SERVICE_ROLE_KEY=...   # never committed, never EXPO_PUBLIC_*

node scripts/rollout-admin.mjs inspect --user <uuid>
node scripts/rollout-admin.mjs enable  --user <uuid> --cohort internal --expires 2026-08-01
node scripts/rollout-admin.mjs disable --user <uuid>
node scripts/rollout-admin.mjs revoke  --user <uuid>   # kill switch, keeps the row
# add --commit to actually write
```

Dry-run by default; prints the exact change, redacts the user id to 8
characters, and always prints rollback instructions. There is no admin panel and
no in-app toggle.

## Privacy

Diagnostics stay console-only with the Phase 3 allowlist, extended by
`configRevision`, `cacheAgeBucket`, `expiryStatus`, `recoveryOverride`, `frozen`.
Raw backend error bodies are never logged — only a mapped reason code.

Forbidden and unemittable: emails, raw user/session/lecture IDs, tokens, auth
headers, raw responses, file paths, transcript/caption/translation text, lecture
titles, course names, audio details, purchase and entitlement state.

## Failure matrix

All twenty cases are covered by `scripts/recording-rollout.test.mjs`: remote
native/legacy/missing/malformed, timeout, backend unavailable, unauthorized,
expired cache, valid native and legacy cache, account switch, remote revoke,
kill switch, config change during recording, unfinished native session while
rollout says legacy, incomplete partial file, multiple recoverable sessions,
native module unavailable, native init failure, and recovery succeeding while
new native recording is disabled.

Five critical invariants were **mutation-tested** — removing recovery
precedence, allowing expired cache, allowing cross-account cache leakage,
ignoring the kill switch, and permitting a forbidden telemetry field. Each was
caught; production files were restored and verified byte-for-byte.

## Verification

```
npm run test:recording      # 14 checks, ~9s
npm run release:recording   # full gate incl. simulator build
```

The release guard is unchanged: the committed default must still be `legacy`.

## Wiring status — read this before assuming rollout is live

> **Updated in Phase 4B: the provider IS now wired into the recording screen,**
> but it is inert by default because the activation gate
> `EXPO_PUBLIC_RECORDING_ROLLOUT_REMOTE` is `0`. The section below described the
> pre-4B state and is kept for context. See
> [phase-4b-activation-readiness.md](phase-4b-activation-readiness.md).

<details>
<summary>Pre-Phase-4B wiring note (historical)</summary>

The provider is **implemented and tested but intentionally not called by the
recording screen yet.** `useLectureRecorder` accepts a `rollout` option; nothing
currently passes it, so every user resolves through the Phase 3 path (legacy).

This is deliberate. The table does not exist, so wiring it now would make every
recording-screen mount issue a Supabase query that fails, adding a round-trip
and error noise for all users to serve a feature nobody is enrolled in. It would
fail closed to legacy, but for no benefit.

Activation is a two-line change once the migration is applied:

1. Call `fetchRolloutEligibility({ userId })` where the recording screen knows
   the signed-in user (and `clearRolloutCache(userId)` on sign-out).
2. Pass the result into `useLectureRecorder({ ..., rollout })`.

Until then, treat Phase 4 as prepared infrastructure, not an active rollout.

</details>

## Deployment status

**The migration is now deployed to production; no user is enrolled and the
remote provider remains off.** RLS is only partially verified — the anonymous
principal passes, but the authenticated-user policy is untested. See
[phase-4c-activation-evidence.md](phase-4c-activation-evidence.md). The client falls back to legacy
because the table does not exist and the fetch fails closed.

Requires explicit approval:

1. Apply `supabase/migrations/20260719_recording_engine_rollout.sql`.
2. Run the verification queries at the bottom of that file — the write attempts
   **must fail** as an ordinary user. If any succeeds, stop and revert.
3. Enroll one internal user with `--expires` set, and confirm the app picks it
   up within 15 minutes.

Rollback: `…rollback.sql`, or preferably
`update … set enabled = false, kill_switch = true`, which keeps the audit trail.
Dropping the table affects no recordings, lectures, or durable sessions.

## Before native becomes the default

- Deferred physical resume-from-recovery and discard gates pass
- Migration applied and RLS empirically verified
- Internal cohort runs clean: no unexplained `native_reconciliation_issue`, rare
  and understood `recorder_fallback_to_legacy`
- Kill switch exercised end to end at least once
- Percentage rollout, if wanted, designed with deterministic bucketing
