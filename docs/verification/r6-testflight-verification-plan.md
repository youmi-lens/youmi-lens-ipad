# R6 follow-on — TestFlight dogfood verification plan

This plan is for a **future dedicated TestFlight dogfood build**. It is not an
authorization to flip production, begin R7, or change
`CONFIGURED_RECORDING_ENGINE` (must remain `'legacy'`).

Current readiness after Simulator R6 + one physical checkpoint PASS:

**DOGFOOD READY** — not production-candidate ready.

## Why TestFlight (not ad-hoc device installs)

- Isolates dogfood from the user’s daily physical iPad study environment.
- Uses a signed internal distribution build without overwriting the personal app
  install when using a distinct bundle / profile if configured that way.
- Lets multiple operators share the same verification matrix.

## Build configuration (future)

Recommended internal dogfood profile (do **not** enable these in `production`):

| Variable | Value | Purpose |
| --- | --- | --- |
| `EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD` | `1` | Route eligible signed-in testers to native durable |
| `EXPO_PUBLIC_R6_SIMULATOR_VERIFY` | **absent / 0** | Never enable the Simulator auto-host on device |
| `CONFIGURED_RECORDING_ENGINE` | `legacy` (committed) | Production default unchanged |

Release/App Store builds must keep dogfood `0`/absent and R6 verify absent.

Native DEBUG Expo test hooks (`performCheckpointForTesting`, interruption /
route simulation AsyncFunctions) are **not** present in Release binaries.
TestFlight uses real Pause/Resume/background/kill — not DEBUG hooks.

## Operator prerequisites

1. Sign in (Guest always forces legacy).
2. Confirm diagnostics show `engine: nativeDurable`, `source: internal_dogfood`
   (or the then-current dogfood source label).
3. Use the **in-progress lecture in the library** for recovery — never a fresh
   Record button session for relaunch recovery.

## Verification matrix (physical / TestFlight)

Retain prior evidence; mark only what is newly executed.

| ID | Scenario | Prior evidence | TestFlight status |
| --- | --- | --- | --- |
| P-CP | Checkpoint continuity @ real 60s (≥2 boundaries) | **PASS** (manual physical) | Retained — optional reconfirm |
| TF1 | Force-kill → relaunch → **direct Finish** (no Resume) | Simulator S5 PASS | **Required** |
| TF2 | Force-kill → relaunch → **Resume** → Finish | Simulator S6 PASS | **Required** |
| TF3 | Background app → UI paused / timer stopped → manual Resume | Simulator S4 PASS (jetsam-aware) | **Required** |
| TF4 | Practical interruption (Siri / call / audio focus) | Simulator injected S13 | **Required** |
| TF5 | Route change (headphones connect/disconnect) if available | Simulator injected | **Desired** / blocked if no hardware |
| TF6 | Uninterrupted ≥10 minutes real wall-clock; Finish; spot-check audio | Simulator accelerated only | **Required** |
| TF7 | Three sequential native sessions Finish + play | Simulator S10 PASS | **Required** |
| TF8 | Finish near a checkpoint boundary (no duplicate export) | Simulator S9 PASS | **Desired** |

### Pass criteria for production-candidate consideration

All **Required** rows PASS on TestFlight hardware, with:

- no false “recording” UI after forced pause;
- committed audio survives kill;
- final assets playable;
- no serious durability defect open;
- production engine still `legacy` until an explicit R7 approval.

## Explicit non-goals for that TestFlight pass

- Do not flip `CONFIGURED_RECORDING_ENGINE`.
- Do not enable `EXPO_PUBLIC_R6_SIMULATOR_VERIFY` on device builds.
- Do not treat Simulator acoustic continuity as hardware proof (physical
  checkpoint PASS already covers listening at boundaries).
- Do not begin Apple Pencil or rollout activation work.

## Recording results

Append outcomes to `docs/verification/r6-device-verification.md` (or a dated
TestFlight evidence file under `docs/verification/`) without deleting the
existing physical checkpoint PASS or Simulator matrix.
