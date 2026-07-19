# Phase 4C — activation evidence

**Date:** 2026-07-19
**App commit at audit:** `47d8a80`
**Outcome: BLOCKED at Task 3 (apply migration). Nothing was deployed.**

Phase 4C is **not complete**. The read-only audit, migration safety review,
client secret-boundary review and full automated verification all passed, but
backend activation could not begin: no administrative access to the Supabase
project exists in this environment, and no deployment authorization was given.

No backend object was created, altered or dropped. No user was enrolled. No
credential was requested, stored or transmitted.

## Pre-migration snapshot

| Item | Observed |
| --- | --- |
| Target project ref (redacted) | `lbws…dult` (20 chars) |
| Anon key | present, client-safe |
| Service-role credential | **absent** everywhere |
| Supabase CLI / psql / docker / pg_dump | **all absent** |
| Linked Supabase project (`supabase/config.toml`) | absent |
| `recording_engine_rollout` table | **does not exist** (PGRST205, HTTP 404) |
| Existing rollout rows | none — table absent |
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

## RLS empirical verification — NOT PERFORMED

**Status: NOT EMPIRICALLY VERIFIED.** The table does not exist, so there is
nothing to test against. The design review from Phase 4 stands unchanged, and
must not be treated as verification.

| Context | Required outcome | Actual |
| --- | --- | --- |
| Unauthenticated read / insert / update / delete | denied | **not executed** |
| User A read own row | allowed | **not executed** |
| User A read user B's row | denied | **not executed** |
| User A insert / update / delete / self-enroll | denied | **not executed** |
| User B read user A's row | denied | **not executed** |
| Service role insert / update / kill switch / expiry / delete | allowed | **not executed** |

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

## Blocker and required approval

Backend activation requires, from an authorized operator:

1. **Administrative access** to project `lbws…dult` — either a service-role key
   provided to a secure operator shell (never `.env`, never `EXPO_PUBLIC_*`), or
   direct Supabase Dashboard SQL Editor access.
2. **Explicit authorization** to apply this migration to that project, and
   confirmation of whether it is production or a non-production environment.
   General development permission is not deployment approval.
3. **Tooling**, if applying from a shell: the Supabase CLI or `psql`. Neither is
   installed here. The Dashboard SQL Editor needs no local tooling and is the
   lowest-friction path.

Once available, follow `phase-4b-activation-runbook.md` from Step 1. Nothing in
this repository needs to change first.

## What must not be done

- Do not put a service-role key in `.env`, `app.json`, `eas.json`, or any
  `EXPO_PUBLIC_*` variable.
- Do not commit `EXPO_PUBLIC_RECORDING_ROLLOUT_REMOTE=1`; internal builds only.
- Do not enroll a real end user — internal test subject only, always with a
  finite expiry.
- Do not skip the RLS checks; the cross-user read and the self-enrollment writes
  must be observed failing before anyone is enrolled.
