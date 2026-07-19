# Phase 2C — feature-gated durable native recorder adapter

Commit: `e3af1e7` — *feat: add feature-gated durable native recorder adapter*

## Scope

- Recorder abstraction with the legacy Expo recorder preserved as default
- Durable native recorder behind an explicit feature gate
- Recovery-state detection, recovery UX, resume, finish-and-save, discard
- Final asset export and durable handoff acknowledgment

Explicitly **not** in scope: background recording, backend migration, UI
redesign, production rollout.

## Automated coverage

Run everything with `npm run test:recording`.

| Area | Covered by |
| --- | --- |
| Durable session persistence | `durable-recorder-session.test.mjs` |
| AAC capture engine | `durable-recorder-audio.test.mjs` |
| JS ↔ Swift contract | `durable-recorder-contract.test.mjs` |
| Final asset assembly | `durable-recorder-finalization.test.mjs` |
| Recovery, resume, discard, relaunch | `durable-recorder-recovery.test.mjs` |
| Adapter + feature gate | `recording-adapter.test.mjs` |

The Swift harnesses compile the **real production sources** with `swiftc` and
generate real AAC audio through the real capture path. There are no mocks of the
durable layer. A production regression breaks these tests.

Relaunch is modelled by discarding the store and rebuilding it over the same
root directory. That is faithful because `DurableRecorderStore` holds no
in-memory session cache — every read already comes from disk.

### Recovery harness scenarios

`scripts/durable-recorder-recovery-core.test.swift`:

1. **Resume after forced relaunch** — record segment 1, pause, drop the store,
   rediscover, verify session/segment identity and byte-identical audio, resume,
   append segment 2, finalize, export, acknowledge, relaunch, confirm no
   duplicate handoff.
2. **Discard after forced relaunch** — create unfinished session, relaunch,
   discard, verify the directory is gone, no asset was produced, and a further
   relaunch does not resurrect it.
3. **Interrupted capture keeps evidence** — kill mid-capture, confirm the session
   is still offered and reports `incomplete_temporary_file` rather than being
   silently dropped.

The harness was **mutation-tested**: removing `session.handoffCompletedAt = timestamp`
from `DurableRecorderStore` makes scenario 1 fail on *"Handoff acknowledgment
must be durable"*. Production code was restored and byte-verified afterwards.

## Physical device verification

Performed on a signed physical iPad (iPad Pro 11-inch, 4th gen).

**Passed:**

- Native normal flow: record → pause → resume → finish → save
- Two-segment session finalized: 4480ms + 9031ms, merged asset probed at 13.56s
  against 13511ms declared; `sourceSegmentIds` length 2; handoff acknowledged
- Pre-termination durability: a paused segment (8.985s, 163,989 bytes,
  `integrity: validated`) survived an external `SIGKILL` **byte-for-byte**,
  SHA256 unchanged
- The unfinished session remained recoverable across later launches

**Deferred:** physical resume-from-recovery. It was never executed — *not*
failed. See `release-checklist.md`.

No private audio is stored in this repository. The evidence above is recorded as
metadata and hashes only.

## Known accepted behaviours

- A session created but never recorded into (zero segments) is still offered for
  recovery. This is intentional — see `recovery-architecture.md`.
- Handoff is at-least-once. A crash between lecture creation and acknowledgment
  can re-offer a completed session.
