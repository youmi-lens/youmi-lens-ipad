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

## Current status

| Gate | Status |
| --- | --- |
| Automated recording suite | Passing |
| Physical native normal flow | Passed |
| Physical pre-termination durability (SIGKILL, byte-identical) | Passed |
| Physical resume-from-recovery | **Deferred — not yet run** |
| Physical discard | **Deferred — not yet run** |

Deferred means not executed, not failed. Both are covered automatically by
`durable-recorder-recovery.test.mjs`; the physical run is the final
hardware-level confirmation before rollout.
