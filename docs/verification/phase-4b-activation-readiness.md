# Phase 4B — activation readiness

Phase 4 built the rollout mechanism but left the provider unwired. Phase 4B
completes the client wiring **while keeping remote rollout off by default**.

## Status

| Item | State |
| --- | --- |
| Provider wired into the recording screen | **Yes** |
| Remote rollout active by default | **No** — activation gate is `0` |
| Rollout requests in the default build | **Zero** |
| Global default engine | **legacy** |
| Build-time dogfood flag | `0` |
| Supabase migration | **Not deployed**, design-reviewed only |
| Users enrolled | **None** |
| Phase 5 | **Not started** |

## The activation gate

```ts
export const REMOTE_ROLLOUT_ENABLED =
  process.env.EXPO_PUBLIC_RECORDING_ROLLOUT_REMOTE === '1';
```

Strict equality against the exact string `'1'`. Absent, `0`, `true`, `yes` and
anything else are all disabled. It is an `export const`, assigned once, never
reassigned, and no screen can change it — so there is no public toggle and
ordinary users cannot enable it.

This is **infrastructure activation**, not eligibility. It only controls whether
the app may query the rollout table at all. Per-user eligibility still comes
from the table, and the two are independent.

## Why a second flag is not a second framework

There are three flags with distinct jobs, all feeding the one policy in
`policy.mjs`:

| Flag | Question it answers |
| --- | --- |
| `CONFIGURED_RECORDING_ENGINE` | What is the compile-time default? (`legacy`) |
| `EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD` | Is this whole build an internal cohort? |
| `EXPO_PUBLIC_RECORDING_ROLLOUT_REMOTE` | May the app query the rollout table? |

No new decision engine was introduced.

## Default no-query guarantee

`useRolloutEligibility` returns before reaching any request when the gate is
off, and its return value is `REMOTE_ROLLOUT_ENABLED ? eligibility : null`, so a
disabled gate yields `null` regardless of internal state. `null` means "no
rollout input", which the policy resolves to legacy.

Tests assert the gate check textually precedes the fetch call site, that the
disabled branch returns first, that the screen never imports Supabase, and that
the facade contains no query.

## Wiring

```
useAuth() ─► useRolloutEligibility ─► RolloutEligibility | null
                    │                          │
              (gate off ⇒ no request)          ▼
                                     useLectureRecorder ─► policy.mjs ─► engine
```

The screen holds no Supabase call; the recorder holds no rollout logic.

## Auth, staleness, and deduplication

- Resolution waits for `authLoading` to settle, so a half-known identity never
  reads a cached decision.
- Every auth change bumps a generation token. A response tagged with a
  superseded generation is discarded (`rollout_resolution_ignored_as_stale`), so
  a slow reply cannot be applied to a different account.
- Signing out sets the result to `null` and issues no request.
- `createRequestDeduper` keeps at most one in-flight request per user, so
  re-renders and a development double-mount share one request. Settled keys are
  released, so a later session refetches per TTL. A different user always gets
  its own request. This is unit-tested behaviourally, not by inspection.

## Startup decisions

| Situation | New recording | Existing native session |
| --- | --- | --- |
| Gate off (default) | legacy, no query | native recovery |
| Gate on, signed out | legacy, no query | account-scoped, isolated |
| Gate on, resolution pending | **legacy immediately** | native recovery |
| Gate on, remote unavailable | unexpired cache, else legacy | native recovery |
| Gate on, eligible | native | native recovery |
| Gate on, kill switch | legacy | native recovery |

A pending decision never enables native — it resolves to legacy and stays frozen
for that session, so recording never waits on the network.

## Table-missing behaviour

Before deployment the table does not exist. If the gate were enabled early, the
provider classifies that at its boundary into
`rollout_infrastructure_unavailable`, falls closed to legacy, and never shows a
database error or logs the raw response. Requests are bounded by a 4-second
timeout (`rollout_timed_out`) and deduplicated, so a broken backend cannot be
hammered by re-renders.

Error classification happens once, in `classifyRolloutError` — no raw database
strings are matched anywhere in UI code.

## Active-session freeze — wired, not just implemented

The facade holds `frozenEngineRef`, seeds it from the first decision, passes it
into the policy, and never reassigns it. The policy returns the frozen engine
with source `frozen_session` before considering any other input. Verified: a
remote revoke, a kill switch, and an eligible refresh all fail to change an
active session's engine, in either direction.

## Recovery precedence

`retainNativeRecovery` stays true, and `resolveRecoveryEngine` returns
`nativeDurable`, under **every** rollout state: default/disabled, remote
revoked, kill switch, timed out, and table missing. Rollout can decide what a
*new* recording uses; it can never decide how existing audio is recovered.

## Verification

```
npm run test:recording      # 15 checks
npm run release:recording   # full gate incl. simulator build
```

Eight mutations were run against the wiring — provider called while gated off,
stale result applied, active-session switching, recovery precedence removed, raw
backend error in diagnostics, and three deduplication defects. All eight were
caught; every production file was restored and verified byte-for-byte.

## Approvals required before activation

1. Authorized Supabase administrative access and a service-role credential.
2. Apply the migration and pass **all** RLS checks in
   [phase-4b-activation-runbook.md](phase-4b-activation-runbook.md) — including
   the cross-user read and the self-enrollment writes, which must fail.
3. Sign-off to build an internal client with
   `EXPO_PUBLIC_RECORDING_ROLLOUT_REMOTE=1`.
4. The deferred physical resume-from-recovery gate.

Until all four, Phase 4B is complete client infrastructure that does nothing at
runtime — which is the intended state.
