import {
  getRecordingPermissionsAsync,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { LectureRecorder, RecorderPermission } from './types';

function toStatus(res: { granted: boolean; canAskAgain: boolean }): RecorderPermission {
  if (res.granted) return 'granted';
  if (!res.canAskAgain) return 'denied';
  return 'undetermined';
}

export function useLegacyLectureRecorder(enabled: boolean): LectureRecorder {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 250);
  const [permissionChecked, setPermissionChecked] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<RecorderPermission>('undetermined');
  const [isPaused, setIsPaused] = useState(false);
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const activeRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let mounted = true;
    getRecordingPermissionsAsync().then((res) => {
      if (mounted) setPermissionStatus(toStatus(res));
    }).catch(() => {}).finally(() => {
      if (mounted) setPermissionChecked(true);
    });
    return () => { mounted = false; };
  }, [enabled]);

  useEffect(() => () => {
    if (activeRef.current) {
      recorder.stop().catch(() => {});
      activeRef.current = false;
    }
  }, [recorder]);

  const requestPermission = useCallback(async () => {
    try {
      const res = await requestRecordingPermissionsAsync();
      setPermissionStatus(toStatus(res)); setPermissionChecked(true);
      return res.granted;
    } catch { setError('Could not request microphone permission.'); return false; }
  }, []);

  const startRecording = useCallback(async () => {
    if (!enabled) return false;
    try {
      setError(null); setErrorDetail(null);
      let granted = (await getRecordingPermissionsAsync()).granted;
      if (!granted) {
        const res = await requestRecordingPermissionsAsync();
        granted = res.granted; setPermissionStatus(toStatus(res));
      } else setPermissionStatus('granted');
      setPermissionChecked(true);
      if (__DEV__) console.info('[recorder] engine selected', { engine: 'legacy', granted });
      if (!granted) return false;
      if (activeRef.current) { await recorder.stop().catch(() => {}); activeRef.current = false; }
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
        shouldPlayInBackground: true,
        allowsBackgroundRecording: true,
      });
      await recorder.prepareToRecordAsync();
      recorder.record();
      activeRef.current = true; setIsPaused(false); setRecordingUri(null);
      return true;
    } catch (startError) {
      const detail = startError instanceof Error ? startError.message : String(startError);
      const base = detail.trim() ? `Could not start the recording. ${detail}` : 'Could not start the recording. Please try again.';
      const devHint = __DEV__ && /prepare/i.test(detail)
        ? '\n\n(Dev only) If this is a Simulator or an old dev build, rebuild the dev client (npx expo run:ios) and/or test on a physical iPad — real devices record normally.' : '';
      setError(`${base}${devHint}`); setErrorDetail(detail.trim() || null);
      activeRef.current = false;
      await recorder.stop().catch(() => {});
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: false,
        shouldPlayInBackground: false,
        allowsBackgroundRecording: false,
      }).catch(() => {});
      return false;
    }
  }, [enabled, recorder]);

  const pauseRecording = useCallback(async () => {
    try { recorder.pause(); setIsPaused(true); }
    catch { setError('Could not pause the recording.'); }
  }, [recorder]);
  const resumeRecording = useCallback(async () => {
    try { recorder.record(); setIsPaused(false); }
    catch { setError('Could not resume the recording.'); }
  }, [recorder]);
  const stopRecording = useCallback(async () => {
    try {
      await recorder.stop(); activeRef.current = false; setIsPaused(false);
      const uri = recorder.uri ?? null; setRecordingUri(uri);
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: false,
        shouldPlayInBackground: false,
        allowsBackgroundRecording: false,
      }).catch(() => {});
      return uri;
    } catch (stopError) {
      if (__DEV__) console.warn('[recorder] local recording stop failed', { message: stopError instanceof Error ? stopError.message : 'unknown' });
      setError('Could not finish the recording.'); return null;
    }
  }, [recorder]);

  return {
    engine: 'legacy', permissionChecked, permissionStatus, recoveryChecked: true,
    recoverableSession: null, isRecording: recorderState.isRecording, isPaused,
    durationMillis: recorderState.durationMillis, recordingUri, error, errorDetail,
    requestPermission, startRecording, pauseRecording, resumeRecording, stopRecording,
    leaveRecording: stopRecording,
    recoverRecording: async () => false,
    finishRecoverableRecording: async () => null,
    acknowledgeFinalizedOutput: async () => true,
    discardRecoverableRecording: async () => {},
    dismissRecovery: () => {},
  };
}
