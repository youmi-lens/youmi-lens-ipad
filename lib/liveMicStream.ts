import { Platform } from 'react-native';

type NativeAudioApi = typeof import('react-native-audio-api');
type NativeAudioRecorder = import('react-native-audio-api').AudioRecorder;

type StartMicStreamInput = {
  sampleRate?: number;
  onPcm16Frame: (frame: ArrayBuffer) => void;
};

export type LiveMicStreamStatus = {
  isSupported: boolean;
  isStreaming: boolean;
  framesReceived: number;
  sampleRate: number;
  error?: string;
};

const DEFAULT_SAMPLE_RATE = 48_000;
const CALLBACK_DURATION_SECONDS = 0.1;
let recorder: NativeAudioRecorder | null = null;
let status: LiveMicStreamStatus = {
  isSupported: false,
  isStreaming: false,
  framesReceived: 0,
  sampleRate: DEFAULT_SAMPLE_RATE,
};

function loadNativeAudioApi(): NativeAudioApi | null {
  if (Platform.OS === 'web') return null;
  try {
    // Lazy require keeps Expo Go usable: this native module is present only in a
    // development build / native build, not in Expo Go.
    return require('react-native-audio-api') as NativeAudioApi;
  } catch {
    return null;
  }
}

function cloneStatus(): LiveMicStreamStatus {
  return { ...status };
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
  const available = Platform.OS === 'ios' && Boolean(loadNativeAudioApi());
  status = { ...status, isSupported: available };
  return available;
}

export function getLiveMicStreamStatus(): LiveMicStreamStatus {
  return cloneStatus();
}

export async function startMicStream({
  onPcm16Frame,
  sampleRate = DEFAULT_SAMPLE_RATE,
}: StartMicStreamInput): Promise<LiveMicStreamStatus> {
  const audioApi = loadNativeAudioApi();
  if (Platform.OS !== 'ios' || !audioApi) {
    status = {
      isSupported: false,
      isStreaming: false,
      framesReceived: 0,
      sampleRate,
      error: 'Live captions require the Youmi Lens development build. Recording still works.',
    };
    return cloneStatus();
  }

  try {
    stopMicStream();
    const nextRecorder = new audioApi.AudioRecorder();
    recorder = nextRecorder;
    status = {
      isSupported: true,
      isStreaming: false,
      framesReceived: 0,
      sampleRate,
    };

    nextRecorder.onError((nativeError) => {
      status = {
        ...status,
        isStreaming: false,
        error: nativeError.message || 'Live microphone stream failed.',
      };
    });

    const callbackResult = nextRecorder.onAudioReady(
      {
        sampleRate,
        bufferLength: Math.round(sampleRate * CALLBACK_DURATION_SECONDS),
        channelCount: 1,
      },
      ({ buffer }) => {
        const firstChannel = buffer.getChannelData(0);
        const frame = float32MonoToPcm16Le(firstChannel);
        status = {
          ...status,
          isSupported: true,
          isStreaming: true,
          framesReceived: status.framesReceived + 1,
        };
        onPcm16Frame(frame);
      },
    );

    if (callbackResult.status === 'error') {
      throw new Error(callbackResult.message);
    }

    const startResult = nextRecorder.start();
    if (startResult.status === 'error') {
      throw new Error(startResult.message);
    }

    status = { ...status, isStreaming: true, error: undefined };
    return cloneStatus();
  } catch (error) {
    stopMicStream();
    status = {
      isSupported: true,
      isStreaming: false,
      framesReceived: status.framesReceived,
      sampleRate,
      error: error instanceof Error ? error.message : 'Could not start live microphone stream.',
    };
    return cloneStatus();
  }
}

export function stopMicStream(): LiveMicStreamStatus {
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
  status = { ...status, isStreaming: false };
  return cloneStatus();
}
