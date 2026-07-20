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

Simulator automation additionally uses (local-only, not left enabled after the run):

```
EXPO_PUBLIC_R6_SIMULATOR_VERIFY=1
```

Committed `.env.example` remains dogfood `0`. Committed
`CONFIGURED_RECORDING_ENGINE` remains `'legacy'`.

## Automated baseline

```
npm run test:recording   # 17/17 PASS
node scripts/r6-simulator-verify.mjs
```

## Build and launch

| Target | Result |
| --- | --- |
| iPad Pro 13-inch (M5) Simulator | Build + install + launch **PASS** |
| iPad Air 11-inch (M4) Simulator (isolated R6 run) | Build + install + launch **PASS** |
| Physical iPad Pro 11-inch (4th gen), iPadOS 26.5.2 | Device Debug build/install/launch **PASS** (earlier); **not used** for the later automated matrix |

## Physical checkpoint-continuity test (retained)

Operator-driven physical iPad recording (dogfood override):

- Native recording started successfully.
- Capture continued across **at least two** real **60-second** checkpoint boundaries.
- UI remained recording; timer continuous; no pause/resume flicker.
- Finish succeeded; final audio played.
- Listening at ~60 s and ~120 s: no obvious missing/duplicated speech, silence,
  truncation, or unacceptable artifact.

### Checkpoint continuity result (physical)

**PASS** — retained. Not overwritten by Simulator work.

## Simulator automation (completed)

### Approach

- **Auth/test-state:** call native durable APIs directly from a `__DEV__`-only
  host (`R6SimulatorVerifyHost`). Does **not** use Guest `forceLegacy`, does
  **not** change production authentication.
- **Engine diagnostic:** report recorded `engine: nativeDurable`,
  `source: internal_dogfood`, `dogfoodEnv: 1`.
- **Checkpoints:** DEBUG `performCheckpointForTesting` (forced rollover) for
  accelerated scenarios — not a claim of sample-perfect acoustic continuity.
- **Lifecycle:** `scripts/r6-simulator-verify.mjs` + `simctl`
  (Safari background, terminate, relaunch) on isolated **iPad Air 11-inch (M4)**.
- **S7:** existing recovery Swift harness (R4 orphan adoption).

Artifact: `docs/verification/r6-simulator-artifacts/latest-results.json`

### Simulator scenario matrix

| ID | Scenario | Result |
| --- | --- | --- |
| S1 | Native engine confirmation | **PASS** |
| S2 | Basic Start / Finish / export / ack | **PASS** |
| S3 | Multiple checkpoints (forced ×3); no paused events | **PASS** |
| S4 | Background forced-pause path (Simulator may jetsam) | **PASS** — recover → resume → finish |
| S5 | Force-kill → direct Finish | **PASS** — R2 quarantine + committed audio |
| S6 | Force-kill → Resume → Finish | **PASS** |
| S7 | Promotion-before-metadata (R4) | **PASS** (native harness) |
| S8 | Background/checkpoint race | **PASS** |
| S9 | Finish/checkpoint race ×3 | **PASS** |
| S10 | Three sequential sessions | **PASS** |
| S11 | 10-minute **accelerated** logical stability (10 forced checkpoints) | **PASS** (not wall-clock 10 min) |
| S12 | Memory/process samples | **PASS** — RSS grew modestly; no process-count explosion |
| S13 | Injected interruption + route-loss | **PASS** (injection, not physical hardware) |

### Simulator UI/timer notes

Forced checkpoints did not emit paused status events (S3). Physical timer
continuity remains the physical PASS above. Simulator Guest UI path remains
blocked for lecture-screen S-matrix; automation bypasses that gate via direct
native APIs.

### Memory samples (host `ps`, approximate)

| Point | YoumiLens RSS (KB) |
| --- | --- |
| pre_launch | ~422k |
| after_in_process | ~478k |
| after_s5 | ~520k |
| after_s6 | ~525k |

Matching process count stayed flat (~300 including Simulator/Metro noise).

## Still not production-candidate blockers

These remain **not** proven as physical-device operator passes in this phase
(and were not re-run on the physical iPad by request):

- physical force-kill Finish / Resume;
- physical background forced pause;
- physical interruption / route-change;
- real wall-clock ≥10-minute physical recording;
- three sequential **physical** sessions.

Simulator equivalents for several of these are PASS above.

## Audio continuity decision

- **Physical checkpoint boundaries:** **PASS** (retained).
- **Simulator:** structural / state / recovery PASS only — **not** an acoustic
  continuity claim.

## Readiness

**DOGFOOD READY**

Not production-candidate ready. Do not flip `CONFIGURED_RECORDING_ENGINE`.

## Production confirmation

- `CONFIGURED_RECORDING_ENGINE` remains `'legacy'`.
- Production default unchanged.
- Native recorder only via local/dogfood override.
- No R7 activation.
- No push.
- Physical iPad app was **not** modified in the Simulator automation pass.
