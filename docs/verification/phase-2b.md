# Phase 2B — durable native foreground audio engine

Commit: `0c57581` — *feat: add durable native foreground audio engine*

Preceded by Phase 2A (`b8d53dc`, durable session foundation) and Phase 1
(`7d39deb`, native contract).

## Scope

- Durable native **foreground** audio engine built on `AVAudioRecorder`
- Immutable recording segments in AAC / M4A
- Pause and resume, where pause finalizes the current segment
- Idempotent native commands
- Process-restart recovery of committed segments
- Playback of committed segments

Background recording is **not** implemented. Capture is foreground-only.

## Design notes

- Capture writes to `segments/NNNNNN-<segmentId>.partial.m4a`; the file is only
  renamed to its finalized name once inspected and committed. The naming split
  is what makes an interrupted capture detectable on the next launch.
- `AVAudioSession.interruptionNotification` and `routeChangeNotification` are
  observed so calls and headphone changes finalize cleanly rather than
  corrupting the active segment.
- Each segment records `routeAtStart` / `routeAtEnd`, sample rate, channel
  count, codec, byte length and duration, so an anomaly is diagnosable after the
  fact without the audio itself.
- The session layer (Phase 2A) is deliberately free of any AVFoundation import;
  `durable-recorder-session.test.mjs` asserts that separation so storage logic
  stays testable and audio-independent.

## Automated coverage

| Area | Covered by |
| --- | --- |
| Session store, atomic writes, canonical IDs, backup exclusion | `durable-recorder-session.test.mjs` |
| Capture engine, AAC settings, interruption/route observers | `durable-recorder-audio.test.mjs` |
| JS ↔ Swift contract shape | `durable-recorder-contract.test.mjs` |

Both Swift harnesses compile the real production sources.

## Physical device verification

Signed physical-device verification passed for start, pause, resume, finish and
playback, plus process-restart recovery of committed segments.
