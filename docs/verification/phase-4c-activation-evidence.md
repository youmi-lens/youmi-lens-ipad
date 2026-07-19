# Phase 4C — activation evidence

**Date:** 2026-07-19
**App commit at audit:** `db00304`
**Environment:** PRODUCTION
**Outcome: migration DEPLOYED by the user. Verification PARTIAL — stopped
before enrollment because the decisive RLS checks could not be executed.**

Phase 4C is **not complete**.

Production deployment has now been **explicitly authorized** by the user for
project `lbws…dult`, and the target was positively confirmed: the project ref in
`.env` matches the authorized ref exactly. The migration safety review, client
secret-boundary review and full automated verification all pass.

**Update — migration applied.** The user applied the authorized migration once,
via the Supabase Dashboard SQL Editor, to production project `lbws…dult`. It was
not reapplied by this session, and no other backend change was made.

Post-deployment verification is **partial**. The anonymous principal passes, but
the two checks that actually gate enrollment — ordinary-user self-enrollment and
cross-user read — could not be executed, because no test-account credentials and
no service-role key are available here. **No user has been enrolled.**

## Pre-migration snapshot

| Item | Observed |
| --- | --- |
| Target project ref (redacted) | `lbws…dult` — **matches authorized ref exactly** |
| Environment | PRODUCTION (user-confirmed) |
| Deployment authorization | **granted** for this one migration |
| Anon key | present, client-safe |
| Service-role credential | **absent** everywhere |
| Supabase CLI / psql / docker / pg_dump | **all absent** |
| `SUPABASE_ACCESS_TOKEN` / `SUPABASE_DB_PASSWORD` / `DATABASE_URL` | **all absent** |
| `~/.supabase` access token | **absent** (only telemetry and traces present) |
| DDL path via anon key (`exec_sql` RPC) | **absent** — `PGRST202`, correctly not exposed |
| Linked Supabase project (`supabase/config.toml`) | absent |
| `recording_engine_rollout` table | **EXISTS** (deployed by user; anon read denied `42501`) |
| Existing rollout rows | none created by this session |
| Migration version history | not accessible without admin access |
| Global recorder default | `legacy` |
| Dogfood build flag | `0` |
| Remote provider activation | `0` |

The table probe was a single read-only `select … limit 1` using the public anon
key, unauthenticated. It returned `PGRST205` (table not found), which
distinguishes "not deployed" from "deployed but RLS-blocked".

## Migration safety review — PASS

Checksums:

```
migration ec2e59f7dfbc16d95c816e0b3a26ed8bf8c17d6124488ab5eafba114ad558fd9
rollback  f03413ee1b4b41b61b62843d2b652142b392a30b893855c8c7c732ec5d26487c
```

Every statement, reviewed line by line:

| Statement | Object | Verdict |
| --- | --- | --- |
| `create table if not exists` | `public.recording_engine_rollout` | in scope |
| `comment on table` | same | in scope |
| `enable row level security` | same | in scope |
| `force row level security` | same | in scope |
| `drop policy if exists` / `create policy "read own rollout"` | same | in scope |
| `revoke all … from anon, authenticated` | same | in scope |
| `grant select … to authenticated` | same | in scope |

The only other schema object named anywhere is `auth.users(id)`, used solely as
a foreign-key target with `on delete cascade`. That **references** `auth.users`;
it does not alter it.

No statement touches profiles, subscriptions, purchases, quotas, entitlements,
Student Basic, lectures, recordings, transcripts, captions, notebooks, uploads,
or any function or trigger.

Rollback reverses only this migration: it drops the one policy and the one
table, and nothing else.

## Post-deployment schema verification — PASS

Verified from the anonymous context by differential probing. PostgREST resolves
an unknown column before evaluating privileges, so the two error codes separate
cleanly:

| Column probed | Code | Meaning |
| --- | --- | --- |
| `user_id`, `engine`, `enabled`, `cohort`, `kill_switch`, `rollout_revision`, `expires_at`, `updated_at` | `42501` | column **exists**, permission denied |
| `definitely_not_a_column` (control) | `42703` | column does not exist |

All eight reviewed columns are present, and the control confirms the probe
distinguishes existence from permission. Constraint definitions, `FORCE ROW
LEVEL SECURITY`, and the policy body are **not** verifiable from this context
and remain unconfirmed.

## RLS empirical verification — PARTIAL (4 passed, 3 groups skipped)

Command: `node scripts/rollout-rls-verify.mjs` → **exit 3** (passed but
incomplete). No unsafe access was observed in any executed check.

| Principal | Operation | Expected | Actual | Result |
| --- | --- | --- | --- | --- |
| anon | select | no rows | denied `401 42501` | **PASS** |
| anon | insert | denied | denied `401 42501` | **PASS** |
| anon | update | denied | denied `401 42501` | **PASS** |
| anon | delete | denied | denied `401 42501` | **PASS** |
| user A | read own row | allowed | — | **SKIPPED** — no test credentials |
| user A | read user B's row | no rows | — | **SKIPPED** — no test credentials |
| user A | self-enroll (insert) | denied | — | **SKIPPED** — no test credentials |
| user A | update enabled / engine / kill_switch / expires_at | denied | — | **SKIPPED** — no test credentials |
| user A | delete | denied | — | **SKIPPED** — no test credentials |
| user B | read user A's row | no rows | — | **SKIPPED** — no test credentials |
| user B | writes (as user A) | denied | — | **SKIPPED** — no test credentials |
| admin | insert / update / kill_switch / expiry / delete | allowed | — | **SKIPPED** — no service-role key |

### What the passing checks do and do not prove

The four anon passes come from the **grant layer**
(`revoke all … from anon`), not from the RLS policy. They prove an anonymous
caller has no privileges on the table at all.

They do **not** exercise `using (auth.uid() = user_id)`. The policy that stops
one signed-in user reading or modifying another user's row is therefore still
**unverified**. That is precisely the property that must hold before anyone is
enrolled, so enrollment has not proceeded.

## Enrollment — NOT PERFORMED

Blocked deliberately. Enrolling on the strength of anon-only results would mean
trusting the authenticated-user policy without ever having tested it.

Self-signing-up two disposable accounts to unblock this was rejected: it would
write to `auth.users`, which is a protected area.

## Client secret boundary — PASS

No `SERVICE_ROLE` or `service_role` reference exists in `lib/`, `app/`,
`app.json`, `eas.json`, `.env`, `.env.local`, `.env.development.local`, or
`.env.example`. The only references are in the operator CLI
(`scripts/rollout-admin.mjs`, which reads it from the environment) and in tests
asserting its absence from the client. No `EXPO_PUBLIC_*` admin or secret
variable exists. The client carries only the public anon key.

## Tasks not performed (blocked)

Enrollment, internal client activation, provider fetch, cache isolation against
a live row, kill-switch exercise, and revocation exercise were all **not
performed**. Each depends on the migration being applied. None of them is
claimed as passing.

The corresponding client-side behaviours remain covered by the automated
failure-matrix tests (missing row, expired row, malformed row, disabled row,
network failure, expired cache, wrong-user cache, unauthorized, table
unavailable, kill switch, recovery precedence, active-session freeze) — but
those exercise the policy and provider layers, not a live database.

## New in this attempt: empirical RLS verifier

`scripts/rollout-rls-verify.mjs` was written so the RLS matrix can be produced
the moment the migration lands. It attempts every operation that must fail
across four principals and prints a pass/fail table, printing no tokens, no full
identifiers and no raw response bodies (only stable PostgREST codes).

It was **tested, not merely written**: run now it correctly reports the
precondition failure (table absent, exit 2), and its request/denial-detection
mechanics were smoke-tested against an existing table on the live project —
an anonymous read returned 0 rows (RLS filtering) and an anonymous insert was
denied with `42501`. No data was modified by that check.

## Automated verification — PASS

| Suite | Result |
| --- | --- |
| `npm run test:recording` | **15/15 passed** |
| `npm run release:recording` | **34/34 passed** (incl. TypeScript, lint, Swift harnesses, iOS Simulator build, working-tree check) |
| Release guard: default legacy, dogfood off, remote provider off, no committed identifier, no service-role in client | **passed, unweakened** |

## Final state

| Item | State |
| --- | --- |
| Migration | **not deployed** |
| Backend objects changed | **none** |
| Users enrolled | **none** |
| Global recorder default | `legacy` |
| Remote provider activation | `0` (off) |
| Dogfood flag | `0` (off) |
| Rollback needed | none — nothing was applied |
| Physical resume-from-recovery gate | **deferred, not failed** |
| Phase 5 | not started |

## Remaining blocker

**Migration: deployed. Authenticated-principal verification: not executable.**

The verifier needs credentials that do not exist in this environment:

- `ROLLOUT_TEST_A_EMAIL` / `_PASSWORD` and `ROLLOUT_TEST_B_EMAIL` / `_PASSWORD`
  — two **disposable** accounts, never real users
- optionally `SUPABASE_SERVICE_ROLE_KEY` for the admin rows

With those exported in an operator shell, `node scripts/rollout-rls-verify.mjs`
completes the matrix and exits 0. Only then may enrollment proceed, at Step 6 of
`phase-4b-activation-runbook.md`.

### Historical: pre-deployment blocker

**Authorization: granted. Credential: absent.** Every administrative path was
checked and none is executable from here:

| Path | State |
| --- | --- |
| Supabase CLI with project access | CLI not installed; no access token on disk |
| Service-role key in operator shell | not set |
| Database password / `DATABASE_URL` / `psql` | not set / not installed |
| DDL through the anon key | not possible, and correctly not exposed |
| Dashboard SQL Editor | requires a human browser session |

No credential was requested, fabricated, or worked around.

## Exact remaining action — Supabase Dashboard (~3 minutes)

This is the lowest-friction path and needs no local tooling.

1. Open the SQL Editor for project `lbws…dult` (confirm the ref before running).
2. Paste the **entire** contents of
   `supabase/migrations/20260719_recording_engine_rollout.sql` and run it once.
   Expected: `Success. No rows returned`. It creates one table and one policy.
3. Immediately verify RLS empirically, **before enrolling anyone**:

   ```bash
   node scripts/rollout-rls-verify.mjs
   ```

   For the full four-principal matrix, first export two **disposable** test
   accounts (never real users, never committed):

   ```bash
   export ROLLOUT_TEST_A_EMAIL=... ROLLOUT_TEST_A_PASSWORD=...
   export ROLLOUT_TEST_B_EMAIL=... ROLLOUT_TEST_B_PASSWORD=...
   export SUPABASE_SERVICE_ROLE_KEY=...   # operator shell only
   node scripts/rollout-rls-verify.mjs
   ```

   Exit 0 = all executed checks passed. Exit 1 = **security failure, stop and
   roll back**. Exit 3 = passed but incomplete (some principals skipped).
4. Only if step 3 exits 0 with no skips, continue at Step 6 of
   `phase-4b-activation-runbook.md` (enroll one internal subject, with expiry).

If anything looks wrong, the rollback is
`supabase/migrations/20260719_recording_engine_rollout.rollback.sql`. It drops
only the rollout policy and table and touches no recording data.

## What must not be done

- Do not put a service-role key in `.env`, `app.json`, `eas.json`, or any
  `EXPO_PUBLIC_*` variable.
- Do not commit `EXPO_PUBLIC_RECORDING_ROLLOUT_REMOTE=1`; internal builds only.
- Do not enroll a real end user — internal test subject only, always with a
  finite expiry.
- Do not skip the RLS checks; the cross-user read and the self-enrollment writes
  must be observed failing before anyone is enrolled.
