import { useCallback, useEffect, useRef, useState } from 'react';

import {
  abandonSession,
  acknowledgeFinalAssetHandoff,
  createSession,
  deleteSession,
  exportFinalizedAsset,
  finalizeSession,
  getMicrophonePermissionStatus,
  listRecoverableSessions,
  pauseRecording as pauseNative,
  prepareRecording,
  recoverRecordingSession,
  resumeRecording as resumeNative,
  startRecording as startNative,
  stopRecording as stopNative,
  transitionSession,
  type DurableRecordingSession,
} from '@/modules/expo-durable-recorder';

import { durationBucket, logRecordingEvent } from './diagnostics';
import { finalizedDurationMillis, recoverableSessionsForLecture } from './policy.mjs';
import type { LectureRecorder, RecorderPermission } from './types';

function permission(value: string): RecorderPermission {
  return value === 'granted' ? 'granted' : value === 'denied' || value === 'restricted' ? 'denied' : 'undetermined';
}

export function useNativeDurableLectureRecorder(enabled: boolean, lectureId: string): LectureRecorder {
  const [permissionChecked, setPermissionChecked] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<RecorderPermission>('undetermined');
  const [recoveryChecked, setRecoveryChecked] = useState(false);
  const [recoverableSession, setRecoverableSession] = useState<DurableRecordingSession | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [durationMillis, setDurationMillis] = useState(0);
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const sessionRef = useRef<DurableRecordingSession | null>(null);
  const baseDurationRef = useRef(0);
  const activeStartedAtRef = useRef<number | null>(null);
  const activeRef = useRef(false);

  const applySession = useCallback((session: DurableRecordingSession) => {
    sessionRef.current = session;
    const base = finalizedDurationMillis(session);
    baseDurationRef.current = base;
    activeStartedAtRef.current = null;
    setDurationMillis(base);
    setIsRecording(session.state === 'recording');
    activeRef.current = session.state === 'recording';
    setIsPaused(session.state === 'paused');
  }, []);

  useEffect(() => () => {
    const session = sessionRef.current;
    if (enabled && activeRef.current && session) {
      void pauseNative({ recordingSessionId: session.recordingSessionId }).catch(() => {});
      activeRef.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let mounted = true;
    void Promise.all([getMicrophonePermissionStatus(), listRecoverableSessions()]).then(([state, sessions]) => {
      if (!mounted) return;
      setPermissionStatus(permission(state)); setPermissionChecked(true);
      const match = recoverableSessionsForLecture(sessions, lectureId)[0] ?? null;
      setRecoverableSession(match);
      if (match) applySession(match);
      logRecordingEvent('recorder_engine_selected', {
        engine: 'nativeDurable',
        hasRecoverableSession: Boolean(match),
        recoverableSessionCount: recoverableSessionsForLecture(sessions, lectureId).length,
      });
      if (match) {
        logRecordingEvent('native_recovery_offered', {
          sessionState: match.state,
          segmentCount: match.segments.length,
          durationBucket: durationBucket(finalizedDurationMillis(match)),
          handoffCompleted: Boolean(match.handoffCompletedAt),
        });
      }
    }).catch((failure: unknown) => {
      if (!mounted) return;
      const detail = failure instanceof Error ? failure.message : String(failure);
      setError('Could not inspect durable recordings.'); setErrorDetail(detail);
      setPermissionChecked(true);
      logRecordingEvent('native_initialization_failed', { reason: 'native_storage_unavailable' });
    }).finally(() => { if (mounted) setRecoveryChecked(true); });
    return () => { mounted = false; };
  }, [applySession, enabled, lectureId]);

  useEffect(() => {
    if (!isRecording) return;
    const timer = setInterval(() => {
      const started = activeStartedAtRef.current;
      setDurationMillis(baseDurationRef.current + (started ? Date.now() - started : 0));
    }, 250);
    return () => clearInterval(timer);
  }, [isRecording]);

  const fail = useCallback((message: string, failure: unknown) => {
    const detail = failure instanceof Error ? failure.message : String(failure);
    setError(message); setErrorDetail(detail);
    if (__DEV__) console.warn('[recorder] native durable operation failed', { message: detail });
  }, []);

  const requestPermission = useCallback(async () => {
    try {
      let session = sessionRef.current;
      if (!session) { session = await createSession({ lectureId }); applySession(session); }
      const status = await prepareRecording({ recordingSessionId: session.recordingSessionId, requestPermission: true });
      if (status.session) applySession(status.session);
      setPermissionStatus(permission(status.permission)); setPermissionChecked(true);
      return status.permission === 'granted';
    } catch (failure) { fail('Could not request microphone permission.', failure); return false; }
  }, [applySession, fail, lectureId]);

  const startRecording = useCallback(async () => {
    if (!enabled || recoverableSession) return false;
    try {
      setError(null); setErrorDetail(null); setRecordingUri(null);
      let session = sessionRef.current;
      if (!session || session.state === 'finalized' || session.state === 'abandoned' || session.state === 'failed') {
        session = await createSession({ lectureId }); applySession(session);
      }
      const prepared = await prepareRecording({ recordingSessionId: session.recordingSessionId, requestPermission: true });
      setPermissionStatus(permission(prepared.permission)); setPermissionChecked(true);
      const started = await startNative({ recordingSessionId: session.recordingSessionId });
      if (started.session) sessionRef.current = started.session;
      activeStartedAtRef.current = Date.now(); activeRef.current = true; setIsPaused(false); setIsRecording(true);
      logRecordingEvent('native_recording_started', { engine: 'nativeDurable' });
      return true;
    } catch (failure) {
      fail('Could not start the recording. Please try again.', failure);
      logRecordingEvent('native_initialization_failed', { reason: 'native_initialization_failed' });
      return false;
    }
  }, [applySession, enabled, fail, lectureId, recoverableSession]);

  const pauseRecording = useCallback(async () => {
    const session = sessionRef.current; if (!session || !isRecording) return;
    try {
      const status = await pauseNative({ recordingSessionId: session.recordingSessionId });
      if (status.session) applySession(status.session);
      logRecordingEvent('native_recording_paused', {
        segmentCount: status.session?.segments.length ?? session.segments.length,
      });
    } catch (failure) { fail('Could not pause the recording.', failure); }
  }, [applySession, fail, isRecording]);

  const resumeRecording = useCallback(async () => {
    const session = sessionRef.current; if (!session) return;
    try {
      const status = session.state === 'paused'
        ? await resumeNative({ recordingSessionId: session.recordingSessionId })
        : await (async () => {
            const prepared = await prepareRecording({
              recordingSessionId: session.recordingSessionId,
              requestPermission: true,
            });
            setPermissionStatus(permission(prepared.permission)); setPermissionChecked(true);
            return startNative({ recordingSessionId: session.recordingSessionId });
          })();
      if (status.session) sessionRef.current = status.session;
      baseDurationRef.current = finalizedDurationMillis(status.session ?? session);
      activeStartedAtRef.current = Date.now(); activeRef.current = true; setIsPaused(false); setIsRecording(true);
      logRecordingEvent('native_recording_resumed', {
        segmentCount: (status.session ?? session).segments.length,
      });
    } catch (failure) { fail('Could not resume the recording.', failure); }
  }, [fail]);

  const finishSession = useCallback(async (session: DurableRecordingSession): Promise<string | null> => {
    try {
      let finalSession = session;
      if (finalSession.state === 'paused' || finalSession.state === 'recording') {
        try {
          const stopped = await stopNative({ recordingSessionId: finalSession.recordingSessionId });
          if (stopped.session) finalSession = stopped.session;
        } catch {
          const recovered = await recoverRecordingSession({ recordingSessionId: finalSession.recordingSessionId });
          finalSession = recovered.session;
          const stopped = await stopNative({ recordingSessionId: finalSession.recordingSessionId });
          if (stopped.session) finalSession = stopped.session;
        }
      } else if (finalSession.state === 'finalizing') {
        finalSession = await finalizeSession({ recordingSessionId: finalSession.recordingSessionId });
      }
      const output = await exportFinalizedAsset({ recordingSessionId: finalSession.recordingSessionId });
      applySession(output.session); activeRef.current = false; setIsRecording(false); setIsPaused(false);
      setRecordingUri(output.fileUri);
      logRecordingEvent('native_recording_finalized', {
        segmentCount: output.session.segments.length,
        durationBucket: durationBucket(output.session.finalAsset?.durationMs ?? null),
        sessionState: output.session.state,
      });
      return output.fileUri;
    } catch (failure) { fail('Could not finish the recording.', failure); return null; }
  }, [applySession, fail]);

  const stopRecording = useCallback(async () => {
    const session = sessionRef.current; return session ? finishSession(session) : null;
  }, [finishSession]);
  const leaveRecording = useCallback(async () => {
    if (isRecording) await pauseRecording();
    return null;
  }, [isRecording, pauseRecording]);
  const recoverRecording = useCallback(async () => {
    const session = recoverableSession; if (!session) return false;
    try {
      const recovered = await recoverRecordingSession({ recordingSessionId: session.recordingSessionId });
      for (const issue of recovered.issues) {
        logRecordingEvent('native_reconciliation_issue', { issueCode: issue.code });
      }
      // incomplete_temporary_file is quarantined natively during recoverRecordingSession
      // when no live capture owns the partial. It must not hard-block Resume/Finish
      // when committed segments already exist (or when only a dead partial remains).
      if (recovered.issues.some((issue) => [
        'missing_referenced_file',
        'invalid_referenced_file',
        'invalid_orphan_file',
      ].includes(issue.code))) {
        throw new Error('A durable source segment is incomplete, missing, or invalid.');
      }
      applySession(recovered.session); setRecoverableSession(null); setIsPaused(true);
      logRecordingEvent('native_recovery_resumed', {
        segmentCount: recovered.session.segments.length,
        durationBucket: durationBucket(finalizedDurationMillis(recovered.session)),
      });
      return true;
    } catch (failure) { fail('Could not recover the unfinished recording.', failure); return false; }
  }, [applySession, fail, recoverableSession]);
  const finishRecoverableRecording = useCallback(async () => {
    const session = recoverableSession; if (!session) return null;
    const uri = await finishSession(session);
    if (uri) setRecoverableSession(null);
    return uri;
  }, [finishSession, recoverableSession]);
  const acknowledgeFinalizedOutput = useCallback(async () => {
    const session = sessionRef.current;
    if (!session?.finalAsset) return false;
    try {
      const acknowledged = await acknowledgeFinalAssetHandoff({
        recordingSessionId: session.recordingSessionId,
      });
      applySession(acknowledged);
      logRecordingEvent('native_handoff_completed', {
        segmentCount: acknowledged.segments.length,
        handoffCompleted: Boolean(acknowledged.handoffCompletedAt),
      });
      return true;
    } catch (failure) {
      fail('The lecture was saved, but recording completion could not be confirmed.', failure);
      return false;
    }
  }, [applySession, fail]);
  const discardRecoverableRecording = useCallback(async () => {
    let session = recoverableSession; if (!session) return;
    try {
      if (session.state === 'recording') session = (await recoverRecordingSession({ recordingSessionId: session.recordingSessionId })).session;
      if (session.state === 'created') session = await transitionSession({ recordingSessionId: session.recordingSessionId, state: 'preparing' });
      if (session.state === 'preparing') session = await transitionSession({ recordingSessionId: session.recordingSessionId, state: 'ready' });
      if (session.state === 'finalizing') session = await finalizeSession({ recordingSessionId: session.recordingSessionId });
      if (session.state === 'ready' || session.state === 'paused') session = await abandonSession({ recordingSessionId: session.recordingSessionId });
      await deleteSession(session.recordingSessionId);
      sessionRef.current = null; setRecoverableSession(null); setDurationMillis(0); setIsPaused(false); setIsRecording(false);
      logRecordingEvent('native_recovery_discarded', { sessionState: session.state });
    } catch (failure) { fail('Could not discard the unfinished recording.', failure); throw failure; }
  }, [fail, recoverableSession]);

  return {
    engine: 'nativeDurable', permissionChecked, permissionStatus, recoveryChecked, recoverableSession,
    isRecording, isPaused, durationMillis, recordingUri, error, errorDetail,
    requestPermission, startRecording, pauseRecording, resumeRecording, stopRecording, leaveRecording,
    recoverRecording, finishRecoverableRecording, discardRecoverableRecording,
    acknowledgeFinalizedOutput,
    // Visibility is screen-local. Keeping this session selected ensures a
    // dismissal can never trigger automatic recording or discard native data.
    dismissRecovery: () => {},
  };
}
