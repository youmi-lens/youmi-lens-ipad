# Durable native recording — architecture

The product invariant behind every design decision here:

> **A recording must never be lost.**

Where a trade-off exists between losing audio and showing the user an extra
prompt, this system always chooses the extra prompt.

## Why a native durable recorder exists

The legacy recorder keeps recording state in JavaScript. If the app is killed
mid-lecture — memory pressure, a crash, or the user swiping it away — the audio
is gone. The durable recorder moves capture and state into native code backed by
disk, so an unfinished recording survives process death.

## Storage layout

Everything lives under Application Support, excluded from iCloud backup:

```
Library/Application Support/YoumiLens/DurableRecorder/
└── sessions/
    └── <recordingSessionId>/
        ├── session.json                       durable metadata
        ├── segments/
        │   ├── 000001-<segmentId>.m4a         immutable, finalized
        │   └── 000002-<segmentId>.partial.m4a in-flight capture
        └── final/
            ├── lecture.exporting.m4a          temporary export
            └── lecture.m4a                    final asset
```

Two rules make this durable:

- **Segments are immutable.** Once a segment is committed it is never rewritten.
  Resuming appends a *new* segment; it never reopens an old one.
- **Metadata writes are atomic.** `session.json` is replaced with
  `options: .atomic`, so a crash mid-write cannot leave torn metadata.

`.partial.m4a` names in-flight capture. The suffix is what lets a later launch
distinguish "audio we committed" from "audio we were still writing when we died".

## Session lifecycle

```
created → preparing → ready → recording ⇄ paused → finalizing → finalized
                                   ↓         ↓
                                 failed   abandoned
```

`finalized` and `abandoned` are terminal. Pausing finalizes the current segment,
which is why the prescribed recovery flow pauses before termination: a paused
session has all of its audio already committed.

## Recovery flow

On launch the recorder lists recoverable sessions for the current lecture:

```
session.recoverable && !state.isTerminal          unfinished work
  ‖ (state == finalized && !handoffCompletedAt)   exported but not handed off
```

The second clause is the important one. It closes the crash window between
"native export finished" and "the JS layer created the lecture record".

If a match exists, the recording screen shows the recovery card and **blocks
starting a new recording** until the user resumes, finishes, or discards. That
block is deliberate: silently starting fresh would strand the old audio.

**Finish does not require Resume.** After relaunch, tapping Finish claims
finalization authority for a paused (or already-finalizing) session with
committed segments, exports through the existing path, and leaves handoff
acknowledgement unchanged.

### Reconciliation

`reconcileSession` walks the session directory and reports issues rather than
repairing destructively:

| Issue code | Meaning |
| --- | --- |
| `missing_referenced_file` | metadata references a segment that is gone |
| `invalid_referenced_file` | referenced segment is not readable audio |
| `incomplete_temporary_file` | a `.partial.m4a` from a kill mid-capture |
| `stale_temporary_file_quarantined` | informational: inactive partial moved to `quarantine/` |
| `orphan_finalized_file` | valid audio on disk not referenced by metadata |
| `invalid_orphan_file` | unreferenced file that is not valid audio |
| `unsupported_segment_format` | unexpected file in `segments/` |

Hard-blocking codes for Resume are `missing_referenced_file`,
`invalid_referenced_file`, and `invalid_orphan_file`.

**Stale partials do not strand committed audio.** When
`recoverRecordingSession` runs with no live capture, any `.partial.m4a` under
`segments/` is moved to `sessions/<id>/quarantine/` and the session is
re-reconciled. Committed `.m4a` segments and `final/lecture.m4a` are never
touched. A live `activeCapture` makes recovery return `recorderBusy` and leaves
the partial alone.

**A kill mid-capture still loses that partial segment's audio.** An AAC/M4A
file without its `moov` atom is not salvaged here (that is later work). The
partial is quarantined for evidence, not adopted as a committed segment.
Zero-segment sessions remain listed for recovery so the loss stays visible;
Finish must not invent an empty final asset when no committed segments exist.

## Handoff and idempotency

The final asset must reach the lecture record exactly once. Ordering:

1. Native export produces `final/lecture.m4a`.
2. JS creates or updates the **lecture record** (the downstream asset).
3. JS calls `acknowledgeFinalAssetHandoff`, setting `handoffCompletedAt`.

If step 3 fails, the UI does not navigate away and the session stays a
completion candidate. If the process dies between 2 and 3, the session is
re-offered — the user may see one duplicate prompt, but no audio is lost.

This is deliberately **at-least-once, not exactly-once**: duplicating a prompt is
recoverable, losing a lecture is not.

Both `export` and `acknowledgeFinalAssetHandoff` are idempotent. Re-exporting
returns the same stable URI without rewriting bytes; re-acknowledging keeps the
original timestamp.

### Finish after relaunch (no Resume)

Ownership is **process-local** (`ownedSessionId` in the foreground engine). A
cold relaunch therefore has no owner even when committed segments are intact.

`recoverRecordingSession` remains inspection-only and does not claim. Resume
claims when the user continues capture. **Finish claims for finalization only**
when this process has no live owner and no active capture, and the session is
`paused` or `finalizing`. It never starts the microphone or opens a new
segment. A different live owner still returns `recorderBusy` without mutating
the victim session.

Prescribed recovery verification therefore includes: pause → kill → relaunch →
**Finish** (without Resume) → export → handoff ack.

## Feature gate

`lib/recording/featureGate.ts` selects the engine:

```ts
export const CONFIGURED_RECORDING_ENGINE: RecordingEngine = 'legacy';
```

Committed value is **always `legacy`**. `scripts/recording-adapter.test.mjs`
fails if it is anything else — that test failing is the guard working, not a
broken test. Guests always use legacy via `forceLegacy`.

## Entry point for recovery (easy to get wrong)

`app/recording.tsx` mints a **fresh `lectureId` on every new recording**. So the
recovery card never appears from the record button. `ensureNativeProgressIdentity`
writes an in-progress lecture shell when native capture starts, and the user
returns through **that in-progress lecture in the library**. Any manual
verification must re-enter the lecture, not start a new recording.
