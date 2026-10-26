# Unified AVAudioEngine ASR spike (flag-gated)

**Status:** SPIKE — opt-in only. Production defaults are unchanged.

## Purpose

Live captions today open a **second** microphone stream (`liveMicStream` /
`react-native-audio-api`) while lecture audio is already captured by
`AVAudioRecorder` (legacy or `nativeDurable`). That dual-mic setup is why
realtime captions can lag or miss quieter speech even when the recording itself
sounds fine.

This spike proves a **single AVAudioEngine graph** that:

1. Writes durable-ish AAC/m4a (Documents/`unified-audio-asr-spike/`), and
2. Emits PCM16 mono frames into the existing Deepgram live-caption WebSocket
   (`sendAudioChunk`).

Goal: when the flag is ON, live captions track the **same mic path** as the
spike’s capture — improve realtime catch of speech (including quieter speech
as much as possible).

## How to enable

Set the env var to the exact string `1` (anything else is off):

```bash
EXPO_PUBLIC_UNIFIED_AUDIO_ASR_SPIKE=1
```

Typical local / internal dogfood only (e.g. `.env.local`, never commit secrets).
Rebuild the native iOS binary after adding the module so Expo autolinking
embeds `expo-unified-audio-asr-spike`:

```bash
npx expo prebuild --platform ios
# then your usual device run / EAS internal profile
```

Gate source of truth: `lib/recording/unifiedAudioAsrSpikeGate.ts`
(`isUnifiedAudioAsrSpikeEnabled()`).

## What stays unchanged (production safety)

| Area | Flag OFF (default) | Flag ON |
| --- | --- | --- |
| Recording engine selection (`featureGate` / rollout / `nativeDurable`) | Unchanged | Unchanged |
| Production `AVAudioRecorder` durable path | Default | Still the lecture recorder of record |
| Courses / recordings / data paths | Untouched | Untouched |
| Railway / Supabase / production config | Untouched | Untouched |
| Live caption mic source | `liveMicStream` @ 48 kHz | Spike PCM @ 48 kHz (second mic skipped) |

Checkpoint / background / recovery of the **full** durable store are **not**
reimplemented in this spike. Do not treat the spike’s AAC file as a substitute
for production durable segments.

## Sample rate / framing

| Stream | Format | Rate | Frame |
| --- | --- | --- | --- |
| PCM → Deepgram | mono PCM16 LE | **48_000** (resampled from hardware when needed) | ~100 ms (same as `liveMicStream`) |
| AAC file | mono MPEG-4 AAC | **44_100** (matches production durable settings ballpark) | continuous `AVAudioFile` write |

`startLiveCaptions(48_000, …)` is unchanged so the server expectation stays
aligned with the existing caption pipeline.

## Physical iPad verification checklist

Native Swift cannot be executed in this workspace without an iOS device /
Xcode build. After a rebuild with the flag ON:

1. Start a signed-in lecture recording; confirm live captions appear and track
   speech (including quieter speech as much as possible).
2. Confirm `liveMicStream` is **not** started (dev log source =
   `unified_audio_asr_spike` on first PCM frame).
3. Pause / resume: captions stop and restart with history preserved.
4. Finish: captions tear down; production lecture audio still finalizes via the
   normal durable/legacy path.
5. With flag **absent/0**: behavior identical to `main` (second-mic captions).
6. Note whether production `AVAudioRecorder` and the spike engine contend for
   the input (see residual risks). If captions are silent while recording
   works, the next iteration should route durable capture through the same
   `AVAudioEngine` **only when the flag is ON**.

## Residual risks

- **Mic contention:** Production lecture capture still uses `AVAudioRecorder`
  when the selected engine is legacy/`nativeDurable`. Running that alongside
  the spike’s `AVAudioEngine` may contend for the shared `AVAudioSession`
  input. Flag-OFF path is unaffected; flag-ON needs device confirmation.
- **Background / interrupt:** Spike does not reimplement durable checkpoint
  rollover, interruption recovery, or Finish background assertions.
- **Translation / Deepgram:** Unchanged WebSocket path; only the PCM source
  switches. Language pair and reconnect budget are untouched.
- **Native rebuild required:** Without embedding the new module, the flag ON
  path reports unavailable and falls back to the calm “captions unavailable”
  UX (lecture recording still works).
