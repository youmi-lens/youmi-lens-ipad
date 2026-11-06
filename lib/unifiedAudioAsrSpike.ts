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
  retryAttempted?: boolean;
  retrySucceeded?: boolean;
};

const PCM_SAMPLE_RATE = 48_000;
/** If the native spike produces no PCM within this window, retry once. */
const NO_FRAME_TIMEOUT_MS = 2_500;
/** After PCM has flowed, silence longer than this is treated as a stall. */
const STALL_TIMEOUT_MS = 5_000;
const UNAVAILABLE =
  'Unified audio ASR spike requires a native rebuild with expo-unified-audio-asr-spike. Recording still uses the production path.';

type ActiveStream = {
  runToken: number;
  onPcm16Frame: (frame: ArrayBuffer) => void;
  onUnavailable?: () => void;
  subscription: { remove: () => void } | null;
};

/**
 * Bumped on every stop and every new start. An in-flight start that resumes
 * after `await stop` / `await native.start` must abandon work when its token
 * no longer matches — otherwise Pause/Finish/unmount can be undone by a
 * stale start that adopts the post-teardown generation.
 */
let runToken = 0;
let active: ActiveStream | null = null;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
let stallTimer: ReturnType<typeof setTimeout> | null = null;
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

function clearWatchdog(): void {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

function clearStallTimer(): void {
  if (stallTimer) {
    clearTimeout(stallTimer);
    stallTimer = null;
  }
}

function logSpike(event: string, extra?: Record<string, unknown>): void {
  if (extra) console.log(`[unifiedAudioAsrSpike] ${event}`, JSON.stringify(extra));
  else console.log(`[unifiedAudioAsrSpike] ${event}`);
}

/** PCM16 LE base64 → ArrayBuffer (matches liveMicStream frame type). */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const atobFn = (globalThis as { atob?: (value: string) => string }).atob;
  if (typeof atobFn !== 'function') {
    // Hermes / RN usually provide atob; fall back to a tiny decoder.
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const clean = base64.replace(/[^A-Za-z0-9+/]/g, '');
    const bytes: number[] = [];
    for (let i = 0; i < clean.length; i += 4) {
      const c0 = clean[i];
      const c1 = clean[i + 1];
      const c2 = clean[i + 2];
      const c3 = clean[i + 3];
      if (c0 === undefined || c1 === undefined) break;
      const a = chars.indexOf(c0);
      const b = chars.indexOf(c1);
      if (a < 0 || b < 0) break;
      const c = c2 === undefined ? -1 : chars.indexOf(c2);
      const d = c3 === undefined ? -1 : chars.indexOf(c3);
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

function deliverFrame(token: number, frame: ArrayBuffer): void {
  if (token !== runToken || !active || active.runToken !== token) return;
  const isFirstFrame = status.framesReceived === 0;
  status = {
    ...status,
    isStreaming: true,
    framesReceived: status.framesReceived + 1,
    lastEvent: isFirstFrame ? 'first_pcm_frame' : 'pcm_frame',
    error: undefined,
  };
  if (isFirstFrame) {
    clearWatchdog();
    logSpike('first_pcm_frame', { afterRetry: Boolean(status.retryAttempted) });
    if (status.retryAttempted && !status.retrySucceeded) {
      status = { ...status, retrySucceeded: true };
      logSpike('retry_succeeded');
    }
  }
  armStallTimer(token);
  try {
    active.onPcm16Frame(frame);
  } catch (error) {
    status = {
      ...status,
      isStreaming: false,
      error: error instanceof Error ? error.message : 'Spike PCM deliver failed.',
      lastEvent: 'pcm_deliver_failed',
    };
  }
}

function armWatchdog(token: number): void {
  clearWatchdog();
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    if (token !== runToken) return;
    if (status.framesReceived > 0) return;
    if (!status.retryAttempted) {
      logSpike('no_frame_timeout', { afterMs: NO_FRAME_TIMEOUT_MS });
      void retryStream(token);
    } else {
      logSpike('retry_failed');
      status = {
        ...status,
        isStreaming: false,
        retrySucceeded: false,
        lastEvent: 'no_pcm_after_retry',
      };
      active?.onUnavailable?.();
    }
  }, NO_FRAME_TIMEOUT_MS);
}

function armStallTimer(token: number): void {
  clearStallTimer();
  stallTimer = setTimeout(() => {
    stallTimer = null;
    if (token !== runToken) return;
    if (status.framesReceived <= 0) return;
    logSpike('pcm_stall_timeout', { afterMs: STALL_TIMEOUT_MS, frames: status.framesReceived });
    if (!status.retryAttempted) {
      void retryStream(token);
    } else {
      status = {
        ...status,
        isStreaming: false,
        retrySucceeded: false,
        lastEvent: 'pcm_stall_after_retry',
      };
      active?.onUnavailable?.();
    }
  }, STALL_TIMEOUT_MS);
}

async function retryStream(token: number): Promise<void> {
  if (token !== runToken) return;
  const cfg = active;
  if (!cfg) return;
  const native = loadNative();
  if (!native) {
    cfg.onUnavailable?.();
    return;
  }

  logSpike('retry_attempt');
  status = { ...status, retryAttempted: true, lastEvent: 'retry_attempt' };

  try {
    // Keep the same runToken + listener; only bounce the native engine.
    try {
      await native.stop();
    } catch {
      // best effort
    }
    if (token !== runToken) return;
    status = { ...status, framesReceived: 0, isStreaming: false };
    const started = await native.start();
    if (token !== runToken) {
      try {
        await native.stop();
      } catch {
        // best effort
      }
      return;
    }
    status = {
      ...status,
      isSupported: true,
      isStreaming: Boolean(started?.isRunning),
      sampleRate: started?.sampleRate ?? PCM_SAMPLE_RATE,
      fileUri: started?.fileUri,
      lastEvent: 'spike_retried',
    };
    armWatchdog(token);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unified audio ASR spike retry failed.';
    logSpike('retry_error', { message });
    status = { ...status, isStreaming: false, retrySucceeded: false, error: message };
    cfg.onUnavailable?.();
  }
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

  // Invalidate any prior start/stop BEFORE awaiting teardown so a Pause /
  // Finish that lands during this await cannot be adopted by a stale start.
  const token = ++runToken;
  await stopUnifiedAudioAsrSpike({ preserveRunToken: true });
  if (token !== runToken) return cloneStatus();

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
        if (token !== runToken) return;
        try {
          const frame = base64ToArrayBuffer(event.base64);
          if (event.sampleRate) {
            status = { ...status, sampleRate: event.sampleRate };
          }
          deliverFrame(token, frame);
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

    active = {
      runToken: token,
      onPcm16Frame: input.onPcm16Frame,
      onUnavailable: input.onUnavailable,
      subscription,
    };

    const started = await native.start();
    if (token !== runToken) {
      try {
        await native.stop();
      } catch {
        // best effort
      }
      return cloneStatus();
    }
    status = {
      ...status,
      isSupported: true,
      isStreaming: Boolean(started?.isRunning),
      sampleRate: started?.sampleRate ?? PCM_SAMPLE_RATE,
      fileUri: started?.fileUri,
      error: undefined,
      lastEvent: 'spike_started',
    };
    armWatchdog(token);
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

export async function stopUnifiedAudioAsrSpike(
  options: { preserveRunToken?: boolean } = {},
): Promise<UnifiedSpikeStreamStatus> {
  clearWatchdog();
  clearStallTimer();
  if (!options.preserveRunToken) {
    runToken += 1;
  }
  const prior = active;
  // Keep the listener attached through native.stop() so a synchronous trailing
  // PCM payload (and any last queued frame event) can still reach captions.
  const native = loadNative();
  let fileUri: string | undefined = status.fileUri;
  let trailingBase64: string | undefined;
  if (native) {
    try {
      const stopped: SpikeStatus = await native.stop();
      fileUri = stopped?.fileUri ?? fileUri;
      trailingBase64 =
        typeof stopped?.trailingPcmBase64 === 'string' && stopped.trailingPcmBase64.length > 0
          ? stopped.trailingPcmBase64
          : undefined;
    } catch {
      // best effort
    }
  }

  if (trailingBase64 && prior) {
    try {
      const frame = base64ToArrayBuffer(trailingBase64);
      if (frame.byteLength >= 2) {
        prior.onPcm16Frame(frame);
        status = {
          ...status,
          framesReceived: status.framesReceived + 1,
          lastEvent: 'trailing_pcm_flushed',
        };
      }
    } catch {
      // Trailing flush is best-effort; never block stop.
    }
  }

  active = null;
  if (prior?.subscription) {
    try {
      prior.subscription.remove();
    } catch {
      // already removed
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
