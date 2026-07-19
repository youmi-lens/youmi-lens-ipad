# Phase 4B — rollout activation runbook

Exact sequence for turning on remote rollout **in the future**. Nothing here has
been executed.

> **Current state: NOT DEPLOYED, NOT ENROLLED, NOT ACTIVATED.**
> The migration is design-reviewed but never applied. `EXPO_PUBLIC_RECORDING_ROLLOUT_REMOTE`
> is `0`, so the app performs zero rollout requests today.

Do not start this before the deferred physical recovery gate is scheduled — step
9 depends on it.

## Step 1 — Obtain authorized administrative access

Get approval and a Supabase **service-role** credential for the target project.
Keep it on an operator machine only. It must never enter `.env`, the app bundle,
CI, or any `EXPO_PUBLIC_*` variable.

## Step 2 — Inspect and back up the current schema

Record the existing schema before changing it:

```sql
select table_name from information_schema.tables where table_schema = 'public';
select * from pg_policies where schemaname = 'public';
```

Confirm no `recording_engine_rollout` table already exists.

## Step 3 — Apply the migration in the safest available environment

Apply `supabase/migrations/20260719_recording_engine_rollout.sql` to a staging
project first if one exists; otherwise apply to production only with explicit
sign-off. The migration creates one new table and touches nothing else.

## Step 4 — Run RLS verification as four principals

Run the verification block at the bottom of the migration as each of:

1. **Unauthenticated** client (anon key)
2. **Ordinary user A**
3. **Ordinary user B**
4. **Admin / service role**

## Step 5 — Confirm every expected result

| Check | Principal | Required result |
| --- | --- | --- |
| Read own row | user A | returns A's row only |
| Read A's row by uuid | user B | **zero rows** |
| Read all rows | unauthenticated | zero rows or permission error |
| `insert` own enrollment | user A | **fails** |
| `update … set enabled = true` | user A | **fails** |
| `update … set kill_switch = false` | user A | **fails** |
| `delete` | user A | **fails** |
| Write any row | service role | succeeds |
| Service-role key present in app bundle | — | **absent** |

If any user-A/B write succeeds, or user B can read A's row, **stop and apply the
rollback**. The policy set is wrong and users could enroll themselves or read
other accounts.

Confirm no credential leaked into the client:

```bash
grep -rE "SERVICE_ROLE|service_role" lib app   # must return nothing
npm run test:recording                          # asserts this too
```

## Step 6 — Create one internal test enrollment, with expiry

```bash
node scripts/rollout-admin.mjs enable --user <uuid> --cohort internal \
  --expires <near-future ISO date>          # dry run first
node scripts/rollout-admin.mjs enable --user <uuid> --cohort internal \
  --expires <near-future ISO date> --commit
node scripts/rollout-admin.mjs inspect --user <uuid>
```

Always set `--expires`. An enrollment that expires on its own cannot be
forgotten.

## Step 7 — Build an internal client with the activation gate on

```
EXPO_PUBLIC_RECORDING_ROLLOUT_REMOTE=1
```

Internal build only. **Never in a public release build.** Leave
`CONFIGURED_RECORDING_ENGINE` on `legacy` and leave
`EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD` at `0` — per-user rollout is the mechanism
under test here.

## Step 8 — Run automated verification

```bash
npm run test:recording
npm run release:recording
```

Both must pass against the committed defaults. The release gate fails if the
committed default is not legacy or the activation flag is committed as enabled.

## Step 9 — Run the physical release-only recovery gate

Follow `release-checklist.md`: record → pause → force-quit → relaunch → resume
via the **in-progress lecture in the library** → finish → verify both phrases in
order → relaunch again and confirm no duplicate.

This gate is still **deferred, not failed**, and remains release-only.

## Step 10 — Exercise the kill switch

```bash
node scripts/rollout-admin.mjs revoke --user <uuid> --commit
```

Confirm, within 15 minutes or after a relaunch:

- a **new** recording uses legacy
- an **active** native recording was not switched mid-session
- any unfinished native session is **still offered for recovery** and still
  resumes natively

The last point is the one that matters most: a revoke must never hide audio.

## Step 11 — Remove the internal test enrollment

```bash
node scripts/rollout-admin.mjs disable --user <uuid> --commit
node scripts/rollout-admin.mjs inspect --user <uuid>
```

Rebuild the internal client without `EXPO_PUBLIC_RECORDING_ROLLOUT_REMOTE`.

## Step 12 — Record evidence and the approval result

Capture, with no personal identifiers (redact user ids as the CLI does):

- migration applied: when, which environment, by whom
- the step 5 table with actual observed results
- automated verification output
- physical gate result
- kill-switch observations from step 10
- confirmation the test enrollment was removed
- approval decision and who gave it

Add the outcome to `phase-4-rollout-control.md` and flip its deployment status.
Until then that document must continue to read **not deployed**.

## Emergency rollback

At any point, in increasing severity:

1. `node scripts/rollout-admin.mjs disable --user <uuid> --commit`
2. Kill switch for everyone:
   `update public.recording_engine_rollout set enabled = false, kill_switch = true, updated_at = now();`
3. Ship/rebuild internal clients without the activation flag.
4. Apply `…rollback.sql` to remove the mechanism entirely.

None of these deletes durable audio. Unfinished native sessions stay recoverable
because recovery follows durable session provenance, not rollout state.
