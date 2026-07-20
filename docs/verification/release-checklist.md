# Release checklist — native recording

## During ordinary development

```
npm run test:recording
```

~7 seconds, no device, no simulator. Run this for **any** change touching
recording. Nothing below is required day to day.

## Before a release

```
npm run release:recording          # includes the iOS simulator build
npm run release:recording:fast     # same, without the simulator build
```

This runs the feature-gate check, TypeScript, lint, every test suite, the
simulator build, and a working-tree check, then prints release readiness.

---

## RELEASE ONLY — the one manual gate

**Not required during ordinary development.** Required only before enabling
native recording as the production default (flipping `CONFIGURED_RECORDING_ENGINE`
to `nativeDurable`).

Everything else is automated. This gate exists because no simulator can prove
that a real iOS process kill, with a real microphone and real audio hardware,
preserves committed audio.

### Setup

Either flip the compile-time gate, or use the Phase 3 dogfood flag:

1. In `lib/recording/featureGate.ts` set `CONFIGURED_RECORDING_ENGINE` to
   `'nativeDurable'` — **or** build with `EXPO_PUBLIC_NATIVE_RECORDER_DOGFOOD=1`
   (see [phase-3-dogfood.md](phase-3-dogfood.md), which leaves the committed
   default untouched and is the preferred route).
2. Install a signed build on a physical iPad and sign in (guests always use the
   legacy recorder).

### The run (~2 minutes)

| # | Action | Expected |
| --- | --- | --- |
| 1 | Start a recording, say "recovery one", **pause** | Timer shows ~5–10s |
| 2 | Force-quit the app (swipe up, or `devicectl ... process signal --signal SIGKILL`) | — |
| 3 | Relaunch, open the **in-progress lecture in the library** — *not* the record button | Recovery card appears |
| 4 | Tap **Resume**, say "recovery two", then finish and save | Lecture saves and processes normally |
| 5 | Play the saved lecture | Both phrases present, in order |
| 6 | Relaunch once more, open that lecture | No recovery card, no duplicate lecture |

Step 3 is the one people get wrong: `app/recording.tsx` mints a fresh
`lectureId` per recording, so starting a new recording will **never** show the
recovery card.

### Discard path (same setup, ~1 minute)

Record briefly, pause, force-quit, relaunch, reopen the in-progress lecture,
tap **Discard**. Expect: no lecture audio created, and the recovery card is gone
after a further relaunch.

### Afterwards

**Restore `CONFIGURED_RECORDING_ENGINE` to `'legacy'`** unless the release is
deliberately shipping native as default. `npm run release:recording` fails if
you forget.

### Inspecting device state without the UI

```bash
DEV=<device-udid>; BID=com.aydenz.youmilensipad
xcrun devicectl device info files --device $DEV \
  --domain-type appDataContainer --domain-identifier $BID \
  | grep DurableRecorder
```

`xcrun devicectl device copy from ...` pulls a `session.json` for inspection.

## Rollout control

Remote per-user rollout is wired but **inactive**. The rollout table is now
deployed to production, but RLS is only partially verified and nobody is
enrolled (see
[phase-4c-activation-evidence.md](phase-4c-activation-evidence.md)): the activation gate
`EXPO_PUBLIC_RECORDING_ROLLOUT_REMOTE` is `0`, the migration is undeployed, and
no user is enrolled. A release build must never set that flag. Activation steps:
[phase-4b-activation-runbook.md](phase-4b-activation-runbook.md).

## Current status

| Gate | Status |
| --- | --- |
| Automated recording suite | Passing (17/17 as of R5/R6 baseline) |
| Simulator build + launch with dogfood env | Passed (R6) |
| Physical iPad Debug install + launch with dogfood env | Passed (R6) |
| Interactive Simulator native scenarios (S1–S7) | **Blocked — Guest session forces legacy** |
| Physical checkpoint-boundary audio (P2) | **Not performed — no UI automation / operator pass** |
| Physical force-kill / forced-pause / long-duration (P4–P8) | **Not performed** |
| Physical resume-from-recovery | **Deferred — not yet run** |
| Physical discard | **Deferred — not yet run** |
| R6 readiness | **NOT READY** — see [r6-device-verification.md](r6-device-verification.md) |

Deferred / blocked means not executed or not executable in the agent session,
not that the feature failed. Automated coverage remains in
`durable-recorder-*.test.mjs` / Swift harnesses; hardware listening is still
required before any production engine flip.
