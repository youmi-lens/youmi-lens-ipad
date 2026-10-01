import Constants, { ExecutionEnvironment } from 'expo-constants';
import { AppState, Platform } from 'react-native';

import { traceRecordingLifecycle } from './recording/lifecycleTrace';

type NativeAudioRecorder = {
  onError: (callback: (error: { message?: string }) => void) => void;
  onAudioReady: (
    options: { sampleRate: number; bufferLength: number; channelCount: number },
    callback: (event: { buffer: { getChannelData: (channel: number) => Float32Array } }) => void,
  ) => { status: 'success' } | { status: 'error'; message: string };
  start: () => { status: 'success'; path?: string } | { status: 'error'; message: string };
  clearOnAudioReady: () => void;
  clearOnError: () => void;
  stop: () => unknown;
};

type NativeAudioApi = {
  AudioRecorder: new () => NativeAudioRecorder;
  AudioManager: {
    requestRecordingPermissions: () => Promise<'Undetermined' | 'Denied' | 'Granted'>;
    checkRecordingPermissions: () => Promise<'Undetermined' | 'Denied' | 'Granted'>;
    setAudioSessionOptions: (options: {
      iosCategory?: 'record' | 'playAndRecord';
      iosMode?: 'default';
      iosOptions?: string[];
    }) => void;
    setAudioSessionActivity: (enabled: boolean) => Promise<boolean>;
  };
};

type StartMicStreamInput = {
  sampleRate?: number;
  onPcm16Frame: (frame: ArrayBuffer) => void;
  /**
   * Called once when the live mic stream is confirmed unavailable — it started
   * but produced no PCM callbacks even after the single defensive retry. Local
   * lecture recording is unaffected and keeps running.
   */
  onUnavailable?: () => void;
};

export type LiveMicStreamStatus = {
  isSupported: boolean;
  isStreaming: boolean;
  framesReceived: number;
  sampleRate: number;
  error?: string;
  lastEvent?: string;
  permission?: string;
  callbackAttached?: boolean;
  nativeRecorderStarted?: boolean;
  firstCallbackAt?: string;
  lastCallbackSampleCount?: number;
  retryAttempted?: boolean;
  retrySucceeded?: boolean;
};

const DEFAULT_SAMPLE_RATE = 48_000;
const CALLBACK_DURATION_SECONDS = 0.1;
/** If the native mic produces no PCM callbacks within this window, retry once. */
const NO_FRAME_TIMEOUT_MS = 2_500;
const UNAVAILABLE_MESSAGE = 'Live captions require the Youmi Lens development build. Recording still works.';

let recorder: NativeAudioRecorder | null = null;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Bumped on every (re)start and stop. The no-frame watchdog and the retry
 * capture the generation they belong to and bail out if it has since changed,
 * so a pause / finish / restart can never be clobbered by a stale retry.
 */
let streamGeneration = 0;
/** Live stream config, kept so the no-frame watchdog can restart it once. */
let activeStream: {
  generation: number;
  sampleRate: number;
  onPcm16Frame: (frame: ArrayBuffer) => void;
  onUnavailable?: () => void;
} | null = null;

let status: LiveMicStreamStatus = {
  isSupported: false,
  isStreaming: false,
  framesReceived: 0,
  sampleRate: DEFAULT_SAMPLE_RATE,
};

/** Internal diagnostics. Logged to the JS console only — never shown in the UI. */
function logMic(event: string, extra?: Record<string, unknown>): void {
  if (extra) console.log(`[liveMic] ${event}`, JSON.stringify(extra));
  else console.log(`[liveMic] ${event}`);
}

function isExpoGo(): boolean {
  return (
    Constants.appOwnership === 'expo' ||
    Constants.executionEnvironment === ExecutionEnvironment.StoreClient
  );
}

function loadNativeAudioApi(): NativeAudioApi | null {
  if (Platform.OS === 'web' || isExpoGo()) return null;
  try {
    // Native-only lazy require. Expo Go must never evaluate this package because
    // the native module is not embedded in the Expo Go binary.
    return require('react-native-audio-api') as NativeAudioApi;
  } catch {
    return null;
  }
}

function cloneStatus(): LiveMicStreamStatus {
  return { ...status };
}

function unavailableStatus(sampleRate: number): LiveMicStreamStatus {
  status = {
    isSupported: false,
    isStreaming: false,
    framesReceived: 0,
    sampleRate,
    error: UNAVAILABLE_MESSAGE,
  };
  return cloneStatus();
}

function float32MonoToPcm16Le(samples: Float32Array): ArrayBuffer {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    pcm[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
  }
  return pcm.buffer;
}

export function isLiveMicAvailable(): boolean {
  if (Platform.OS !== 'ios' || isExpoGo()) {
    status = { ...status, isSupported: false };
    return false;
  }

  const available = Boolean(loadNativeAudioApi());
  status = { ...status, isSupported: available };
  return available;
}

export function getLiveMicStreamStatus(): LiveMicStreamStatus {
  return cloneStatus();
}

function clearWatchdog(): void {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

/**
 * (Re)apply the iOS audio session options the live mic needs: playAndRecord,
 * session active. It never deactivates the session, so a concurrent local
 * lecture recording keeps running across a retry.
 */
async function configureAudioSession(audioApi: NativeAudioApi): Promise<void> {
  // Dev-only evidence of WHO mutates the shared AVAudioSession during a durable recording (no-op elsewhere).
  traceRecordingLifecycle('AUDIO_SESSION_MUTATION', {
    caller: 'liveMicStream.configureAudioSession', op: 'set_options', category: 'playAndRecord', mode: 'default',
    options: '', appState: AppState.currentState,
  });
  audioApi.AudioManager.setAudioSessionOptions({
    iosCategory: 'playAndRecord',
    iosMode: 'default',
    iosOptions: [],
  });
  try {
    const active = await audioApi.AudioManager.setAudioSessionActivity(true);
    traceRecordingLifecycle('AUDIO_SESSION_MUTATION', {
      caller: 'liveMicStream.configureAudioSession', op: 'set_active', active: true, result: Boolean(active),
      appState: AppState.currentState,
    });
  } catch (failure) {
    traceRecordingLifecycle('AUDIO_SESSION_MUTATION', {
      caller: 'liveMicStream.configureAudioSession', op: 'set_active', active: true, result: 'error',
      appState: AppState.currentState,
    });
    throw failure;
  }
}

/** Stop just the native PCM recorder. Does not touch the shared audio session. */
function stopNativeRecorder(): void {
  if (recorder) {
    try {
      recorder.clearOnAudioReady();
      recorder.clearOnError();
      recorder.stop();
    } catch {
      // Best effort cleanup. Local lecture recording must continue unaffected.
    }
  }
  recorder = null;
}

/**
 * Create the native recorder, attach the onAudioReady callback BEFORE start,
 * then start it. Throws on any native error.
 */
function startNativeRecorder(
  audioApi: NativeAudioApi,
  sampleRate: number,
  onPcm16Frame: (frame: ArrayBuffer) => void,
  generation: number,
): void {
  const nextRecorder = new audioApi.AudioRecorder();
  recorder = nextRecorder;
  status = { ...status, lastEvent: 'native_recorder_created' };

  nextRecorder.onError((nativeError) => {
    status = {
      ...status,
      isStreaming: false,
      error: nativeError.message || 'Live microphone stream failed.',
      lastEvent: 'native_recorder_error',
    };
    logMic('native_recorder_error', { message: nativeError.message ?? null });
  });

  // Attach the audio callback before start() so no early frames are missed.
  const callbackResult = nextRecorder.onAudioReady(
    {
      sampleRate,
      bufferLength: Math.round(sampleRate * CALLBACK_DURATION_SECONDS),
      channelCount: 1,
    },
    ({ buffer }) => {
      if (generation !== streamGeneration) return; // stale recorder — ignore
      try {
        const firstChannel = buffer.getChannelData(0);
        const frame = float32MonoToPcm16Le(firstChannel);
        const isFirstFrame = status.framesReceived === 0;
        status = {
          ...status,
          isSupported: true,
          isStreaming: true,
          framesReceived: status.framesReceived + 1,
          firstCallbackAt: status.firstCallbackAt ?? new Date().toISOString(),
          lastCallbackSampleCount: firstChannel.length,
          lastEvent: isFirstFrame ? 'first_audio_callback_fired' : 'audio_callback_fired',
        };
        if (isFirstFrame) {
          // PCM is flowing — the no-frame watchdog is no longer needed.
          clearWatchdog();
          logMic('first_pcm_callback', {
            sampleCount: firstChannel.length,
            afterRetry: Boolean(status.retryAttempted),
          });
          if (status.retryAttempted && !status.retrySucceeded) {
            status = { ...status, retrySucceeded: true };
            logMic('retry_succeeded');
          }
        }
        onPcm16Frame(frame);
      } catch (error) {
        status = {
          ...status,
          isStreaming: false,
          error:
            error instanceof Error ? error.message : 'Could not convert live microphone frame.',
          lastEvent: 'audio_callback_conversion_failed',
        };
      }
    },
  );

  if (callbackResult.status === 'error') {
    throw new Error(callbackResult.message);
  }
  status = { ...status, callbackAttached: true, lastEvent: 'audio_callback_attached' };
  logMic('callback_attached');

  const startResult = nextRecorder.start();
  if (startResult.status === 'error') {
    throw new Error(startResult.message);
  }
  status = {
    ...status,
    isStreaming: true,
    nativeRecorderStarted: true,
    error: undefined,
    lastEvent: 'native_recorder_started',
  };
  logMic('native_recorder_started', { sampleRate });
}

/** Arm the no-frame watchdog for `generation`. */
function armWatchdog(generation: number): void {
  clearWatchdog();
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    if (generation !== streamGeneration) return; // superseded by stop / restart
    if (status.framesReceived > 0) return; // frames arrived — all good
    if (!status.retryAttempted) {
      logMic('no_frame_timeout', { afterMs: NO_FRAME_TIMEOUT_MS });
      void retryStream(generation);
    } else {
      logMic('retry_failed');
      status = {
        ...status,
        isStreaming: false,
        retrySucceeded: false,
        lastEvent: 'no_pcm_after_retry',
      };
      activeStream?.onUnavailable?.();
    }
  }, NO_FRAME_TIMEOUT_MS);
}

/**
 * One-shot defensive retry: the mic started but no PCM callbacks arrived. Stop
 * the silent native recorder, reconfigure the audio session, and start a fresh
 * recorder once. The local lecture recording is left running untouched.
 */
async function retryStream(generation: number): Promise<void> {
  if (generation !== streamGeneration) return;
  const cfg = activeStream;
  if (!cfg) return;
  const audioApi = loadNativeAudioApi();
  if (!audioApi) {
    cfg.onUnavailable?.();
    return;
  }

  logMic('retry_attempt');
  status = { ...status, retryAttempted: true, lastEvent: 'retry_attempt' };

  stopNativeRecorder();
  try {
    await configureAudioSession(audioApi);
    if (generation !== streamGeneration) return; // stopped while reconfiguring
    status = { ...status, framesReceived: 0, firstCallbackAt: undefined };
    startNativeRecorder(audioApi, cfg.sampleRate, cfg.onPcm16Frame, generation);
    armWatchdog(generation);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Live microphone retry failed.';
    logMic('retry_error', { message });
    status = { ...status, isStreaming: false, retrySucceeded: false, error: message };
    cfg.onUnavailable?.();
  }
}

export async function startMicStream({
  onPcm16Frame,
  onUnavailable,
  sampleRate = DEFAULT_SAMPLE_RATE,
}: StartMicStreamInput): Promise<LiveMicStreamStatus> {
  if (Platform.OS !== 'ios' || isExpoGo()) {
    return unavailableStatus(sampleRate);
  }

  const audioApi = loadNativeAudioApi();
  if (!audioApi) {
    return unavailableStatus(sampleRate);
  }

  stopMicStream(); // tear down any previous stream; bumps streamGeneration
  const generation = streamGeneration;
  status = {
    isSupported: true,
    isStreaming: false,
    framesReceived: 0,
    sampleRate,
    lastEvent: 'mic_start_requested',
  };
  logMic('mic_start_requested', { sampleRate });

  try {
    const permission = await audioApi.AudioManager.checkRecordingPermissions();
    const grantedPermission =
      permission === 'Granted'
        ? permission
        : await audioApi.AudioManager.requestRecordingPermissions();
    status = { ...status, permission: grantedPermission, lastEvent: 'mic_permission_checked' };
    logMic('permission_checked', { permission: grantedPermission });
    if (grantedPermission !== 'Granted') {
      throw new Error(`Live microphone permission ${grantedPermission.toLowerCase()}.`);
    }

    // Keep the config so the no-frame watchdog can restart the stream once.
    activeStream = { generation, sampleRate, onPcm16Frame, onUnavailable };

    await configureAudioSession(audioApi);
    if (generation !== streamGeneration) return cloneStatus(); // stopped meanwhile
    logMic('audio_session_configured');

    startNativeRecorder(audioApi, sampleRate, onPcm16Frame, generation);
    armWatchdog(generation);

    return cloneStatus();
  } catch (error) {
    stopMicStream();
    status = {
      isSupported: true,
      isStreaming: false,
      framesReceived: 0,
      sampleRate,
      error: error instanceof Error ? error.message : 'Could not start live microphone stream.',
      lastEvent: 'mic_start_failed',
    };
    logMic('start_error', { message: status.error });
    return cloneStatus();
  }
}

export function stopMicStream(): LiveMicStreamStatus {
  clearWatchdog();
  streamGeneration += 1; // invalidate any pending watchdog / retry
  activeStream = null;
  stopNativeRecorder();
  status = { ...status, isStreaming: false };
  return cloneStatus();
}
