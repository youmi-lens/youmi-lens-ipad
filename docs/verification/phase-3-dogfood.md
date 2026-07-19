# Phase 3 — controlled native recorder dogfooding

Lets approved internal builds run the durable native recorder while every
public build stays on legacy. **This is not a rollout.**

## Engine selection

`resolveRecordingEngineDecision` in `lib/recording/policy.mjs` is a pure
function — deterministic, no I/O, exhaustively tested. It returns:

```
{ engine, source, fallbackReason, retainNativeRecovery }
```

Priority, highest first:

| Priority | Source | Active when |
| --- | --- | --- |
| 1 | `test_override` | Only when an explicit test context flag is set. Never at runtime. |
| 2 | `developer_override` | `__DEV__` builds only |
| 3 | `internal_dogfood` | `EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD=1` at build time |
| 4 | `default` | Always — resolves to **legacy** |

Rules the tests enforce:

- The default is legacy. Native must be explicitly selected.
- Eligibility that cannot be resolved fails closed to legacy
  (`eligibility_unavailable`).
- Guests and protected flows (`forceLegacy`) are never routed to native.
- Overrides are inert without their context flag, so a stale local value cannot
  push a release build onto native.
- Invalid override values are ignored rather than trusted.

## Internal eligibility

Eligibility is a **build-time cohort flag**, not a user list:

```
EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD=1
```

This reuses the existing `EXPO_PUBLIC_*` configuration path — no new flag
system, no backend, no schema change, no secrets.

It is deliberately **not** per-user. A committed allowlist would mean committing
personal identifiers, and a backend-driven flag would require schema and
deployment decisions outside this phase's scope. Per-user remote eligibility is
therefore **deferred** — see the roadmap.

Eligibility is independent of subscriptions, purchases, entitlements, quotas and
Student Basic, and reads none of that state.

### Enable

Set the flag in the internal build's env and rebuild. Because it is compiled in,
it cannot be toggled at runtime by a user, and there is no Settings switch.

### Disable immediately

Remove the flag (or set `0`) and rebuild — the default resolves to legacy.
For an already-installed dev build, clear the developer override. No durable
audio is affected either way: existing native sessions stay recoverable.

## Fallback

Native degrades to legacy **before capture starts**, with a stable reason code:

| Reason | Meaning |
| --- | --- |
| `unsupported_runtime` | Runtime/build cannot host the native recorder |
| `native_module_unavailable` | Native module missing |
| `native_contract_incompatible` | JS ↔ Swift contract mismatch |
| `native_storage_unavailable` | Durable storage could not initialise |
| `native_initialization_failed` | Native recorder failed to start |
| `native_permission_unavailable` | Microphone unavailable before session start |
| `eligibility_unavailable` | Eligibility could not be resolved |

Reasons are checked in a fixed order, so identical inputs always produce the
same reason.

## Recovery precedence

**Fallback never hides audio.** `retainNativeRecovery` is true whenever durable
native audio exists, regardless of the engine chosen — including a forced-legacy
flow and a fallback caused by a missing native module.

Therefore:

- An unfinished native session stays reachable when the default is legacy.
- Turning dogfooding off does not orphan native audio.
- A session with committed segments is never silently replaced by a legacy one.

Recovery is reached through the **in-progress lecture in the library**, never the
record button. Lectures are stored per user (`youmi.lectures.v1.<userId>`), so a
session is only reachable via a lecture the signed-in user can see — that is the
user boundary. Signing out does not delete durable audio.

## Provenance

`Lecture.recordingEngine` records which recorder produced the audio. It is
**local only** — remote writes use an explicit column allowlist, so it never
reaches the backend and no schema change was required.

- Set at every lecture write site: autosave, the native progress shell, and the
  final save
- Never downgraded by a later autosave — the engine that started capture wins
- Missing on older lectures; `lectureRecordingEngine()` reads that as `legacy`,
  which safely keeps old lectures out of native recovery
- Historical lectures are never rewritten

## Privacy boundary

Diagnostics are **console only** — no analytics SDK, no network call.
`lib/recording/diagnostics.ts` holds an allowlist; `sanitizeRecordingDiagnostics`
drops everything else, so a careless call site cannot leak.

**Allowed:** `engine`, `source`, `reason`, `issueCode`, `appBuild`,
`sessionState`, `segmentCount`, `durationBucket`, `recovered`,
`handoffCompleted`, `hasRecoverableSession`, `recoverableSessionCount`,
`hasReconciliationIssues`, `cohort`.

**Forbidden and unemittable:** audio, waveforms, transcript / caption /
translation text, lecture titles, course names, emails, raw user / session /
lecture / segment IDs, file paths, tokens, purchase or entitlement state,
precise timestamps.

Values must be small scalars; strings over 64 characters and any object are
dropped. Durations are coarse buckets (`<10s`, `10-60s`, `1-5m`, `5-30m`,
`30-90m`, `>90m`) — never raw milliseconds.

`scripts/recording-diagnostics.test.mjs` asserts this by feeding a hostile
payload containing transcript text, an email, a file path and raw IDs, then
proving none of it survives.

## Events

`recorder_engine_selected`, `native_initialization_succeeded` /
`_failed`, `recorder_fallback_to_legacy`, `native_recording_started` /
`_paused` / `_resumed` / `_finalized`, `native_recovery_offered` / `_resumed` /
`_discarded`, `native_handoff_completed` / `_retried`,
`native_reconciliation_issue`.

## Inspecting outcomes

Filter device logs for `[recorder]`. In development a summary line is printed:

```
[recorder] diagnostics engine=legacy source=default fallback=none \
  nativeAvailable=true recoverable=0 issues=false lastOutcome=none defaultsToLegacy=true
```

There is no diagnostics UI, and none is exposed to normal users.

## Verification

```
npm run test:recording      # ~7s, includes policy, privacy, provenance, routing
npm run release:recording   # full gate, still requires the committed default to be legacy
```

The release guard was not weakened for Phase 3: `CONFIGURED_RECORDING_ENGINE`
must still read `legacy`.

## Rollback

1. Remove `EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD` (or set `0`) and rebuild.
2. Confirm `CONFIGURED_RECORDING_ENGINE` is `legacy`.
3. Run `npm run release:recording`.

Existing native recordings remain recoverable throughout. Rollback never deletes
durable state.

## Promotion criteria for native default

Not met yet. Before native can become the default:

- The deferred physical resume-from-recovery and discard gates pass
- Internal dogfooding shows no unexplained `native_reconciliation_issue` events
- `recorder_fallback_to_legacy` is rare and every reason code is understood
- Recovery succeeds when offered
- Per-user rollout control exists, so the default can be reverted without a
  rebuild
- A tested rollback path is confirmed

## Deferred physical gate

Physical resume-from-recovery remains **RELEASE ONLY** and **deferred — not
failed**. Physical native normal flow and pre-termination durability passed.
See [release-checklist.md](release-checklist.md).
