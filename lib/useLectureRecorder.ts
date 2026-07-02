/**
 * useLectureRecorder — a small abstraction over `expo-audio` for capturing a
 * single lecture recording locally on the device.
 *
 * V1 scope: local audio capture only. No upload, no transcription, no backend.
 */
import {
  getRecordingPermissionsAsync,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';

export type RecorderPermission = 'undetermined' | 'granted' | 'denied';

export type LectureRecorder = {
  /** Whether the microphone permission has been checked yet. */
  permissionChecked: boolean;
  permissionStatus: RecorderPermission;
  isRecording: boolean;
  isPaused: boolean;
  /** Real elapsed recording time, in milliseconds. */
  durationMillis: number;
  /** Local file URI of the finished recording (available after stop). */
  recordingUri: string | null;
  error: string | null;
  /** Raw native reason for the last start failure (diagnostics), or null. */
  errorDetail: string | null;
  requestPermission: () => Promise<boolean>;
  startRecording: () => Promise<boolean>;
  pauseRecording: () => void;
  resumeRecording: () => void;
  stopRecording: () => Promise<string | null>;
};

function toStatus(res: { granted: boolean; canAskAgain: boolean }): RecorderPermission {
  if (res.granted) return 'granted';
  if (!res.canAskAgain) return 'denied';
  return 'undetermined';
}

export function useLectureRecorder(): LectureRecorder {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 250);

  const [permissionChecked, setPermissionChecked] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<RecorderPermission>('undetermined');
  const [isPaused, setIsPaused] = useState(false);
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Raw native reason for the last start failure — surfaced for diagnostics. */
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  /** True while a recording session is live, used for unmount cleanup. */
  const activeRef = useRef(false);

  // Check the current permission state once on mount.
  useEffect(() => {
    let mounted = true;
    getRecordingPermissionsAsync()
      .then((res) => {
        if (!mounted) return;
        setPermissionStatus(toStatus(res));
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setPermissionChecked(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // Release the microphone if the screen is left while still recording.
  useEffect(() => {
    return () => {
      if (activeRef.current) {
        recorder.stop().catch(() => {});
        activeRef.current = false;
      }
    };
  }, [recorder]);

  const requestPermission = useCallback(async () => {
    try {
      const res = await requestRecordingPermissionsAsync();
      setPermissionStatus(toStatus(res));
      setPermissionChecked(true);
      return res.granted;
    } catch {
      setError('Could not request microphone permission.');
      return false;
    }
  }, []);

  const startRecording = useCallback(async () => {
    try {
      setError(null);
      setErrorDetail(null);

      let granted = (await getRecordingPermissionsAsync()).granted;
      if (!granted) {
        const res = await requestRecordingPermissionsAsync();
        granted = res.granted;
        setPermissionStatus(toStatus(res));
      } else {
        setPermissionStatus('granted');
      }
      setPermissionChecked(true);
      if (__DEV__) console.info('[recorder] microphone permission checked', { granted });
      if (!granted) return false;

      // Defensive cleanup: a previous session (or a failed prior start) can
      // leave the recorder / AVAudioSession active, which makes the next
      // prepareToRecordAsync throw. Release it first so Retry does a clean
      // start. No-op on a fresh session.
      if (activeRef.current) {
        await recorder.stop().catch(() => {});
        activeRef.current = false;
      }

      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      if (__DEV__) console.info('[recorder] local recording started');

      activeRef.current = true;
      setIsPaused(false);
      setRecordingUri(null);
      return true;
    } catch (startError) {
      const detail = startError instanceof Error ? startError.message : String(startError);
      if (__DEV__) console.warn('[recorder] local recording start failed', { message: detail });
      // Surface the real native reason (an audio-session/recording error — safe,
      // no secrets) so the failure is diagnosable instead of a generic message.
      const base = detail.trim()
        ? `Could not start the recording. ${detail}`
        : 'Could not start the recording. Please try again.';
      // Dev-only hint. "Failed to prepare recorder" in dev usually means the
      // dev-client binary is STALE (built before native modules were added, so
      // Metro is serving current JS into a mismatched native runtime) — rebuild
      // with `npx expo run:ios`. It can also be the iOS Simulator having no
      // capture route. Neither is a production/device failure; real iPads record
      // fine. Only shown in dev so production users never see it.
      const devHint =
        __DEV__ && /prepare/i.test(detail)
          ? '\n\n(Dev only) If this is a Simulator or an old dev build, rebuild the dev client (npx expo run:ios) and/or test on a physical iPad — real devices record normally.'
          : '';
      setError(`${base}${devHint}`);
      setErrorDetail(detail.trim() || null);
      // Leave nothing half-started so the next Retry begins clean.
      activeRef.current = false;
      await recorder.stop().catch(() => {});
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      return false;
    }
  }, [recorder]);

  const pauseRecording = useCallback(() => {
    try {
      recorder.pause();
      setIsPaused(true);
    } catch {
      setError('Could not pause the recording.');
    }
  }, [recorder]);

  const resumeRecording = useCallback(() => {
    try {
      recorder.record();
      setIsPaused(false);
    } catch {
      setError('Could not resume the recording.');
    }
  }, [recorder]);

  const stopRecording = useCallback(async () => {
    try {
      await recorder.stop();
      activeRef.current = false;
      setIsPaused(false);

      const uri = recorder.uri ?? null;
      setRecordingUri(uri);
      if (__DEV__) console.info('[recorder] local recording stopped', { hasUri: Boolean(uri) });

      // Reset the audio session so the device returns to normal playback.
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      return uri;
    } catch (stopError) {
      if (__DEV__) {
        console.warn('[recorder] local recording stop failed', {
          message: stopError instanceof Error ? stopError.message : 'unknown',
        });
      }
      setError('Could not finish the recording.');
      return null;
    }
  }, [recorder]);

  return {
    permissionChecked,
    permissionStatus,
    isRecording: recorderState.isRecording,
    isPaused,
    durationMillis: recorderState.durationMillis,
    recordingUri,
    error,
    errorDetail,
    requestPermission,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
  };
}
