# Native recording test guide

Reference for what correct behaviour looks like, so a failure is recognisable
without re-deriving the design. Architecture lives in
`recovery-architecture.md`.

```
npm run test:recording      # everything below, ~7s, no device
```

## Normal flow

Start → pause → resume → finish → save.

| Stage | State | Segments | `finalAsset` | `handoffCompletedAt` |
| --- | --- | --- | --- | --- |
| Screen opened | `created` | 0 | – | – |
| Permission + prepare | `preparing` → `ready` | 0 | – | – |
| Recording | `recording` | 0 | – | – |
| Paused | `paused` | 1 | – | – |
| Resumed | `recording` | 1 | – | – |
| Paused again | `paused` | 2 | – | – |
| Finishing | `finalizing` → `finalized` | 2 | – | – |
| Exported | `finalized` | 2 | set | – |
| Saved downstream | `finalized` | 2 | set | set |

Files after a two-segment session:

```
segments/000001-<id>.m4a     > 0 bytes, integrityStatus "validated"
segments/000002-<id>.m4a     > 0 bytes, integrityStatus "validated"
final/lecture.m4a            > 0 bytes
```

Expected metadata:

- `segments[].sequence` is `1, 2, …` with no gaps
- `finalAsset.sourceSegmentIds` equals `segments.map(segmentId)` **in order**
- `finalAsset.durationMs` ≈ sum of segment durations (tolerance 400ms)
- `finalAsset.relativePath` is `final/lecture.m4a`
- Segment files are byte-identical before and after any later operation

## Recovery flow

Record → pause → force-quit → relaunch → resume → finish.

Expected:

- The same `recordingSessionId` is rediscovered — resume must **never** create a
  new session
- `lectureId` resolves to the original lecture
- Segment 1 is byte-identical to before the kill (compare SHA256)
- Resume appends segment 2; segment 1 stays immutable
- Final asset contains both segments in order

**Also required:** pause → force-quit → relaunch → **Finish without Resume**.
Direct Finish must finalize and export committed segments, release ownership,
and leave handoff acknowledgement unchanged. Covered by
`durable-recorder-recovery-core.test.swift` scenario D.

Entry point: the **in-progress lecture in the library**. A new recording never
shows the recovery card.

## Discard flow

Expected after discarding a recovered session:

- Session directory removed entirely, including `segments/`
- Session no longer listed by `listRecoverableSessions`
- `getSession` throws
- **No lecture audio and no downstream asset created**
- A further relaunch does not resurrect it

## Force termination

`SIGKILL` is a faithful stand-in for a swipe-away kill:

```bash
xcrun devicectl device process signal --device <udid> --signal SIGKILL --pid <pid>
xcrun devicectl device process launch --device <udid> com.aydenz.youmilensipad
```

- **Killed while paused** → all audio committed, cleanly resumable. This is the
  supported path.
- **Killed while recording** → a `.partial.m4a` remains. That segment's audio is
  **not salvaged** (no `moov` atom). Store reconciliation still reports
  `incomplete_temporary_file`. Engine recovery quarantines the partial under
  `quarantine/` and must **not** hard-block Resume/Finish when prior committed
  segments exist. Losing only the active partial is expected; stranding
  committed audio behind it is a bug.

## Feature gate

`CONFIGURED_RECORDING_ENGINE` must be `'legacy'` in any committed state.
`recording-adapter.test.mjs` fails otherwise — that failure is the guard
working. Guests always resolve to legacy via `forceLegacy`.

## Failure signatures

| Symptom | Likely cause |
| --- | --- |
| `recording-adapter` fails on `= 'legacy'` | Gate left on `nativeDurable` after device testing |
| "A durable source segment is incomplete, missing, or invalid." | Reconciliation hit a blocking issue; inspect `session.json` against `segments/` |
| Final file exists but Finish re-exports / no handoff | Crash after `promoteFinalAsset` before `commitFinalAsset`; recovery should adopt `final/lecture.m4a` |
| Segment file on disk missing from metadata | Crash after segment `moveItem` before metadata write; recovery should adopt contiguous orphans |
| Recovery card never appears | Opened a *new* recording instead of the in-progress lecture; or `handoffCompletedAt` already set |
| Recovery card appears with nothing to resume | Zero-segment session — intentional, see architecture doc |
| Final duration ≪ sum of segments | Exporter dropped a segment; check `sourceSegmentIds` ordering |
| Same lecture saved twice | Handoff acknowledged before the lecture record was committed — ordering must stay create-then-acknowledge |
| Session re-offered after a successful save | `handoffCompletedAt` not persisted |
| Swift harness fails to compile | A production Swift signature changed; harnesses compile real sources by design |

## Adding coverage

Extend `scripts/durable-recorder-recovery-core.test.swift` for durable-layer
behaviour, or add a `*.test.mjs` under `scripts/` for JS orchestration — the
release runner picks up new `*.test.mjs` files automatically. Swift runners
share `scripts/lib/swift-harness.mjs`; don't re-implement the compile step.

**Verify a new test can fail.** Break the production behaviour it covers,
confirm the test catches it, then restore. A test never observed failing has not
been shown to work.
