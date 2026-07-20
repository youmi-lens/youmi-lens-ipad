# R6 — Interactive / physical native recording verification

Date: 2026-07-20  
Base commit: `e99c08ca3cc165c49c63f4562d7b82f9d6693567` (R5 checkpoint)  
Production engine (committed): `legacy` (`CONFIGURED_RECORDING_ENGINE`)

## Purpose

Prove whether the R1–R5 native durable recorder is safe enough for later
dogfood or production consideration. R6 does **not** flip the production engine.

## Engine override used

Local-only, gitignored:

```
# .env.local
EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD=1
```

Confirmed loaded by Expo (`env: export … EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD`).
Committed `.env.example` remains `0`. Committed `CONFIGURED_RECORDING_ENGINE`
remains `'legacy'`.

Guests always resolve to legacy via `forceLegacy: isGuest`. Native verification
requires a signed-in session.

## Automated baseline

```
npm run test:recording   # 17/17 PASS
```

## Build and launch

| Target | Result |
| --- | --- |
| iPad Pro 13-inch (M5) Simulator | Build + install + launch **PASS** (`npx expo run:ios`) |
| Physical iPad Pro 11-inch (4th gen), iPadOS 26.5.2 | Device Debug build **PASS** (`xcodebuild`); install + launch **PASS** (`devicectl`) |

Notes:

- First Simulator launch crashed with connection refused until Metro was started
  (`npx expo start --dev-client --port 8081`).
- `npx expo run:ios --device <coredevice-uuid>` failed (devicectl JSON version /
  UDID matching). Device install used `xcodebuild` + `devicectl device install app`.
- Metro showed a signed-in store fetch on the physical device after launch.
- Simulator session observed as **Guest** (native engine unavailable).

## Scenario matrix

### Simulator (Guest session)

| ID | Scenario | Result |
| --- | --- | --- |
| S1 | Basic native recording | **blocked** — Guest forces legacy |
| S2 | Checkpoint continuity | **blocked** |
| S3 | Pause / Resume | **blocked** |
| S4 | Finish and playback | **blocked** |
| S5 | Background forced pause | **blocked** |
| S6 | Cold recovery + direct Finish | **blocked** |
| S7 | Recovery + Resume | **blocked** |

### Physical iPad (signed-in session present; no UI automation)

| ID | Scenario | Result |
| --- | --- | --- |
| P1 | Real microphone basic recording | **blocked** — no remote UI automation (no Maestro/idb/WDA) |
| P2 | Audible checkpoint-boundary | **blocked** |
| P3 | Pause/Resume after checkpoints | **blocked** |
| P4 | App background forced pause | **blocked** |
| P5 | Force-kill bounded-loss | **blocked** |
| P6 | Interruption | **blocked** |
| P7 | Route change | **blocked** |
| P8 | Long-duration stability | **blocked** / **not performed** |
| P9 | Repeated sessions | **blocked** |

Deep link `youmilens://recording` was attempted; Metro did not show a native
recording start diagnostic, so interactive capture was not confirmed.

## Filesystem evidence (pre-existing device sessions)

Device already contains `Library/Application Support/YoumiLens/DurableRecorder/sessions/`
from earlier dogfood (2026-07-19). Example finalized session
`fb7bddf4-…`:

- segments: sequence `1` (4480 ms), `2` (9031 ms)
- `finalAsset.durationMs`: 13511
- `handoffCompletedAt`: set
- no `interruptionReason: "checkpoint"` (pre-R5 capture)

These prove prior native durable storage on device, **not** R5 checkpoint
continuity on 2026-07-20.

## Audio continuity decision

**INCONCLUSIVE** — physical checkpoint-boundary listening was not performed.

## Readiness

**NOT READY** for dogfood/production activation pending:

1. Signed-in Simulator or operator-driven physical run of S1–S7 / P1–P9.
2. Explicit PASS or CONDITIONAL PASS on audible checkpoint boundaries at the
   committed 60s interval.
3. Force-kill bounded-loss + forced-pause UI sync on device.
4. At least one meaningful long-duration recording (≥10 minutes preferred).

## Production confirmation

`CONFIGURED_RECORDING_ENGINE = 'legacy'` unchanged. No rollout flags enabled in
committed sources. No push. No R7.

## How to finish R6 manually (operator)

With Metro running and `.env.local` dogfood `=1`, on the physical iPad (signed in):

1. Confirm console shows `[recorder] diagnostics` with `engine: nativeDurable`,
   `source: internal_dogfood`.
2. Record through ≥3 real 60s checkpoints with continuous speech/counting.
3. Finish; listen at ~60s / ~120s / ~180s boundaries.
4. Background forced-pause; Resume; Finish.
5. Force-quit mid-segment after ≥1 checkpoint; relaunch via **in-progress lecture**;
   direct Finish; then a second pass with Resume.
6. Record ≥10 minutes uninterrupted; Finish; spot-check begin/middle/end.
7. Update this file’s scenario matrix and readiness classification.
