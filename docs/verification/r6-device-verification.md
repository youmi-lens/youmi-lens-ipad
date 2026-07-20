# R6 — Interactive / physical native recording verification

Date: 2026-07-20  
Base commit: `e99c08ca3cc165c49c63f4562d7b82f9d6693567` (R5 checkpoint)  
Docs update (checkpoint PASS): after manual physical iPad test the same day  
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
- Simulator session observed as **Guest** (native engine unavailable for S1–S7).

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

### Physical iPad

| ID | Scenario | Result |
| --- | --- | --- |
| P1 | Real microphone basic recording | **passed** — native durable capture started via dogfood override |
| P2 | Audible checkpoint-boundary | **passed** — see below |
| P3 | Pause/Resume after checkpoints | **not performed** |
| P4 | App background forced pause | **not performed** |
| P5 | Force-kill bounded-loss (direct Finish / Resume) | **not performed** |
| P6 | Interruption | **not performed** |
| P7 | Route change | **not performed** |
| P8 | Long-duration stability (≥10 min) | **not performed** |
| P9 | Repeated sessions (≥3 sequential) | **not performed** |

The full R6 matrix is **not** complete. Remaining rows above are still required
before any **production-candidate** classification.

## Physical checkpoint-continuity test (completed)

Operator-driven recording on the physical iPad with the native durable recorder
(dogfood override only):

- Native recording started successfully.
- Capture continued across **at least two** real **60-second** checkpoint
  boundaries.
- UI remained in the recording state throughout.
- Timer remained continuous (no reset / pause flicker at checkpoints).
- No visible pause/resume animation at checkpoint boundaries.
- Finish completed successfully.
- Final exported audio played successfully.

Listening around the approximate **60 s** and **120 s** boundaries:

- no obvious missing speech;
- no obvious duplicated speech;
- no obvious silent gap;
- no obvious truncation;
- no unacceptable audible artifact.

### Checkpoint continuity result

**PASS** — no perceptible user-facing continuity issue was observed in this
manual physical iPad test.

This is not a sample-perfect continuity claim; it is a listening PASS for the
boundaries exercised in that session.

## Filesystem evidence (earlier device sessions)

Device also contains older
`Library/Application Support/YoumiLens/DurableRecorder/sessions/` entries from
2026-07-19 dogfood (pre-R5 checkpoint tagging). Those remain historical context
only; the continuity PASS above is from the 2026-07-20 operator listening test.

## Audio continuity decision

**PASS** (physical checkpoint boundaries at ~60 s and ~120 s in the completed
manual test).

## Readiness

**DOGFOOD READY**

Reason:

- automated R1–R5 suites pass;
- Simulator and physical-device build/install/launch pass;
- real physical iPad recording passed multiple checkpoint boundaries;
- final audio was playable;
- no perceptible checkpoint discontinuity was observed;
- remaining scenarios (force-kill Finish/Resume, background forced pause,
  interruption/route-change, ≥10-minute recording, three sequential sessions)
  are still required before **production-candidate** readiness.

**Not** production-candidate ready. Do not flip `CONFIGURED_RECORDING_ENGINE`.

## Production confirmation

- `CONFIGURED_RECORDING_ENGINE` remains `'legacy'`.
- Production default is unchanged.
- Native recorder is enabled only through local/dogfood override
  (`EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD=1` in gitignored `.env.local`).
- No R7 activation occurred.
- No push occurred.

## Remaining operator checklist (before production-candidate)

1. Force-quit mid-segment after ≥1 checkpoint; relaunch via **in-progress lecture**;
   **direct Finish** without Resume.
2. Same kill path with **Resume**, then Finish.
3. Background the app during recording; confirm forced pause + UI/timer stop;
   manual Resume; Finish.
4. Practical interruption and/or route-change pass.
5. Uninterrupted recording ≥10 minutes; Finish; spot-check begin/middle/end.
6. Three sequential native durable sessions; each Finishes and plays cleanly.
