/**
 * SPIKE JS bridge — when `isUnifiedAudioAsrSpikeEnabled()`, recording.tsx uses
 * this instead of `liveMicStream` so live captions share one AVAudioEngine
 * graph with a durable-ish AAC writer.
 *
 * Flag OFF → callers must not invoke start; production dual-mic path unchanged.
 * Native module absent (Expo Go / no rebuild yet) → start returns unsupported.
 */
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

import { isUnifiedAudioAsrSpikeEnabled } from '@/lib/recording/unifiedAudioAsrSpikeGate';
import type {
  ExpoUnifiedAudioAsrSpikeModule,
  SpikePcmFrameEvent,
  SpikeStatus,
} from '@/modules/expo-unified-audio-asr-spike';

export type UnifiedSpikeStreamStatus = {
  isSupported: boolean;
  isStreaming: boolean;
  framesReceived: number;
  sampleRate: number;
  fileUri?: string;
  error?: string;
  lastEvent?: string;
};

const PCM_SAMPLE_RATE = 48_000;
const UNAVAILABLE =
  'Unified audio ASR spike requires a native rebuild with expo-unified-audio-asr-spike. Recording still uses the production path.';

type ActiveStream = {
  generation: number;
  onPcm16Frame: (frame: ArrayBuffer) => void;
  onUnavailable?: () => void;
  subscription: { remove: () => void } | null;
};

let streamGeneration = 0;
let active: ActiveStream | null = null;
let status: UnifiedSpikeStreamStatus = {
  isSupported: false,
  isStreaming: false,
  framesReceived: 0,
  sampleRate: PCM_SAMPLE_RATE,
};

function isExpoGo(): boolean {
  return (
    Constants.appOwnership === 'expo' ||
    Constants.executionEnvironment === ExecutionEnvironment.StoreClient
  );
}

function loadNative(): ExpoUnifiedAudioAsrSpikeModule | null {
  if (Platform.OS === 'web' || isExpoGo()) return null;
  try {
    return requireOptionalNativeModule<ExpoUnifiedAudioAsrSpikeModule>('ExpoUnifiedAudioAsrSpike');
  } catch {
    return null;
  }
}

function cloneStatus(): UnifiedSpikeStreamStatus {
  return { ...status };
}

/** PCM16 LE base64 → ArrayBuffer (matches liveMicStream frame type). */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const atobFn = (globalThis as { atob?: (value: string) => string }).atob;
  if (typeof atobFn !== 'function') {
    // Hermes / RN usually provide atob; fall back to a tiny decoder.
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const clean = base64.replace(/=+$/, '');
    const bytes: number[] = [];
    for (let i = 0; i < clean.length; i += 4) {
      const a = chars.indexOf(clean[i] ?? '');
      const b = chars.indexOf(clean[i + 1] ?? '');
      const c = chars.indexOf(clean[i + 2] ?? '');
      const d = chars.indexOf(clean[i + 3] ?? '');
      bytes.push((a << 2) | (b >> 4));
      if (c >= 0) bytes.push(((b & 15) << 4) | (c >> 2));
      if (d >= 0) bytes.push(((c & 3) << 6) | d);
    }
    return Uint8Array.from(bytes).buffer;
  }
  const binary = atobFn(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

export function isUnifiedAudioAsrSpikeAvailable(): boolean {
  if (!isUnifiedAudioAsrSpikeEnabled()) return false;
  if (Platform.OS !== 'ios' || isExpoGo()) {
    status = { ...status, isSupported: false };
    return false;
  }
  const available = Boolean(loadNative());
  status = { ...status, isSupported: available };
  return available;
}

export function getUnifiedAudioAsrSpikeStatus(): UnifiedSpikeStreamStatus {
  return cloneStatus();
}

export async function startUnifiedAudioAsrSpike(input: {
  onPcm16Frame: (frame: ArrayBuffer) => void;
  onUnavailable?: () => void;
}): Promise<UnifiedSpikeStreamStatus> {
  if (!isUnifiedAudioAsrSpikeEnabled()) {
    status = {
      isSupported: false,
      isStreaming: false,
      framesReceived: 0,
      sampleRate: PCM_SAMPLE_RATE,
      error: 'Unified audio ASR spike flag is off.',
      lastEvent: 'flag_off',
    };
    return cloneStatus();
  }

  if (Platform.OS !== 'ios' || isExpoGo()) {
    status = {
      isSupported: false,
      isStreaming: false,
      framesReceived: 0,
      sampleRate: PCM_SAMPLE_RATE,
      error: UNAVAILABLE,
      lastEvent: 'unsupported_runtime',
    };
    return cloneStatus();
  }

  const native = loadNative();
  if (!native) {
    status = {
      isSupported: false,
      isStreaming: false,
      framesReceived: 0,
      sampleRate: PCM_SAMPLE_RATE,
      error: UNAVAILABLE,
      lastEvent: 'native_unavailable',
    };
    input.onUnavailable?.();
    return cloneStatus();
  }

  await stopUnifiedAudioAsrSpike();
  const generation = streamGeneration;
  status = {
    isSupported: true,
    isStreaming: false,
    framesReceived: 0,
    sampleRate: PCM_SAMPLE_RATE,
    lastEvent: 'spike_start_requested',
  };

  let subscription: { remove: () => void } | null = null;
  try {
    if (typeof native.addListener === 'function') {
      subscription = native.addListener('onPcmFrame', (event: SpikePcmFrameEvent) => {
        if (generation !== streamGeneration) return;
        try {
          const frame = base64ToArrayBuffer(event.base64);
          status = {
            ...status,
            isStreaming: true,
            framesReceived: status.framesReceived + 1,
            sampleRate: event.sampleRate || PCM_SAMPLE_RATE,
            lastEvent: status.framesReceived === 0 ? 'first_pcm_frame' : 'pcm_frame',
          };
          input.onPcm16Frame(frame);
        } catch (error) {
          status = {
            ...status,
            isStreaming: false,
            error: error instanceof Error ? error.message : 'Spike PCM decode failed.',
            lastEvent: 'pcm_decode_failed',
          };
        }
      });
    }

    active = { generation, onPcm16Frame: input.onPcm16Frame, onUnavailable: input.onUnavailable, subscription };

    const started = await native.start();
    if (generation !== streamGeneration) return cloneStatus();
    status = {
      ...status,
      isSupported: true,
      isStreaming: Boolean(started?.isRunning),
      sampleRate: started?.sampleRate ?? PCM_SAMPLE_RATE,
      fileUri: started?.fileUri,
      error: undefined,
      lastEvent: 'spike_started',
    };
    if (__DEV__) {
      console.info('[unifiedAudioAsrSpike] started', {
        sampleRate: status.sampleRate,
        fileUriPresent: Boolean(status.fileUri),
      });
    }
    return cloneStatus();
  } catch (error) {
    await stopUnifiedAudioAsrSpike();
    const message = error instanceof Error ? error.message : 'Could not start unified audio ASR spike.';
    status = {
      isSupported: true,
      isStreaming: false,
      framesReceived: 0,
      sampleRate: PCM_SAMPLE_RATE,
      error: message,
      lastEvent: 'spike_start_failed',
    };
    if (__DEV__) console.warn('[unifiedAudioAsrSpike] start failed', { message });
    input.onUnavailable?.();
    return cloneStatus();
  }
}

export async function stopUnifiedAudioAsrSpike(): Promise<UnifiedSpikeStreamStatus> {
  streamGeneration += 1;
  const prior = active;
  active = null;
  if (prior?.subscription) {
    try {
      prior.subscription.remove();
    } catch {
      // already removed
    }
  }

  const native = loadNative();
  let fileUri: string | undefined = status.fileUri;
  if (native) {
    try {
      const stopped: SpikeStatus = await native.stop();
      fileUri = stopped?.fileUri ?? fileUri;
    } catch {
      // best effort
    }
  }

  status = {
    ...status,
    isStreaming: false,
    fileUri,
    lastEvent: 'spike_stopped',
  };
  return cloneStatus();
}
