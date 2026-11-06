/**
 * SPIKE GATE — unified AVAudioEngine capture for live captions.
 *
 * When enabled, recording.tsx skips the second-mic `liveMicStream` path and
 * feeds PCM from the spike module (`expo-unified-audio-asr-spike`) into the
 * existing Deepgram live-caption WebSocket (`sendAudioChunk`).
 *
 * Defaults OFF. Strict: only the exact string '1' enables it. Absent, '0',
 * 'true', or any other value leaves production behavior unchanged (dual mic:
 * durable AVAudioRecorder + react-native-audio-api liveMicStream).
 *
 * This gate does NOT change recording-engine selection (legacy / nativeDurable).
 * Production defaults, Railway/Supabase config, and durable store recovery are
 * intentionally untouched. See docs/verification/unified-audio-asr-spike.md.
 *
 * Pure / no local imports so unit tests can call it with injected env values
 * (same pattern as nativeDurableDevForce.ts / r6VerifyGate.ts).
 */
export function isUnifiedAudioAsrSpikeEnabled(
  options: { envValue?: string | undefined } = {},
): boolean {
  const envValue =
    options.envValue ??
    (typeof process !== 'undefined'
      ? process.env.EXPO_PUBLIC_UNIFIED_AUDIO_ASR_SPIKE
      : undefined);
  return envValue === '1';
}
