import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { traceRecordingLifecycle } from './lifecycleTrace';

import {
  abandonSession,
  acknowledgeFinalAssetHandoff,
  addRecordingStatusListener,
  createSession,
  deleteSession,
  exportFinalizedAsset,
  finalizeSession,
  getMicrophonePermissionStatus,
  getRecordingStatus,
  getSession,
  listRecoverableSessions,
  pauseRecording as pauseNative,
  prepareRecording,
  recoverRecordingSession,
  resumeRecording as resumeNative,
  startRecording as startNative,
  stopRecording as stopNative,
  transitionSession,
  DurableRecorderError,
  type DurableRecordingSession,
  type DurableRecordingStatus,
} from '@/modules/expo-durable-recorder';

import { durationBucket, logRecordingEvent } from './diagnostics';
import { finalizeAndExportDurableSession } from './durableSessionRecovery';
import { finalizedDurationMillis, recoverableSessionsForLecture } from './policy.mjs';
import { evaluateNativeStatusUpdate } from './statusSync.mjs';
import type { LectureRecorder, RecorderPermission } from './types';

function permission(value: string): RecorderPermission {
  return value === 'granted' ? 'granted' : value === 'denied' || value === 'restricted' ? 'denied' : 'undetermined';
}

// A different session is GENUINELY, actively recording right now — the one
// conflict a paused session's ownership release (native claim()) still
// correctly refuses to silently resolve. Distinguishing it lets the UI show
// a clear, specific reason instead of the generic "Could not resume/start
// the recording." both share otherwise.
function isRecorderBusyError(failure: unknown): boolean {
  return failure instanceof DurableRecorderError && failure.code === 'ERR_DURABLE_RECORDER_BUSY';
}

export function useNativeDurableLectureRecorder(enabled: boolean, lectureId: string): LectureRecorder {
  const [permissionChecked, setPermissionChecked] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<RecorderPermission>('undetermined');
  const [recoveryChecked, setRecoveryChecked] = useState(false);
  const [recoverableSession, setRecoverableSession] = useState<DurableRecordingSession | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  // See LectureRecorder.degradedReason — non-null only for a pause the owner
  // didn't choose (checkpoint rollover failure, interruption, route change).
  const [degradedReason, setDegradedReason] = useState<string | null>(null);
  const [durationMillis, setDurationMillis] = useState(0);
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const sessionRef = useRef<DurableRecordingSession | null>(null);
  const baseDurationRef = useRef(0);
  const activeStartedAtRef = useRef<number | null>(null);
  const activeRef = useRef(false);
  const lastStatusSequenceRef = useRef(0);
  const finishingRef = useRef(false);
  // Duration of the durable final asset (AVFoundation-inspected) from the last successful Finish. The only
  // authoritative lecture duration for this engine — see resolveFinalLectureDurationMillis.
  const finalAssetDurationMillisRef = useRef<number | null>(null);

  const noteStatusSequence = useCallback((status: DurableRecordingStatus | null | undefined) => {
    if (typeof status?.statusSequence === 'number' && status.statusSequence > lastStatusSequenceRef.current) {
      lastStatusSequenceRef.current = status.statusSequence;
    }
  }, []);

  const fail = useCallback((message: string, failure: unknown) => {
    const detail = failure instanceof Error ? failure.message : String(failure);
    setError(message); setErrorDetail(detail);
    if (__DEV__) console.warn('[recorder] native durable operation failed', { message: detail });
  }, []);

  const applySession = useCallback((session: DurableRecordingSession) => {
    traceRecordingLifecycle('SESSION_APPLIED', { state: session.state, segments: session.segments.length });
    sessionRef.current = session;
    const base = finalizedDurationMillis(session);
    baseDurationRef.current = base;
    activeStartedAtRef.current = null;
    setDurationMillis(base);
    setIsRecording(session.state === 'recording');
    activeRef.current = session.state === 'recording';
    setIsPaused(session.state === 'paused');
    // Any direct session apply (recovery hydration, explicit pause/resume/
    // finish) reflects the owner's own action or a fresh reattachment —
    // clear any stale degraded flag. The one place that SETS it
    // (applyNativeStatus's forced-pause branch, below) calls this first via
    // the same path, then sets it right after.
    setDegradedReason(null);
  }, []);

  const applyNativeStatus = useCallback((status: DurableRecordingStatus) => {
    traceRecordingLifecycle('NATIVE_STATUS_RECEIVED', {
      runtime: status.runtimeState, sessionState: status.session?.state, interruption: status.interruptionState ?? null,
      route: status.routeChangeState ?? null, seq: status.statusSequence ?? null,
    });
    const current = sessionRef.current;
    const decision = evaluateNativeStatusUpdate({
      currentSessionId: current?.recordingSessionId,
      currentState: current?.state,
      finishing: finishingRef.current,
      lastSequence: lastStatusSequenceRef.current,
      status,
    });
    if (
      decision.reason === 'no_current_session' ||
      decision.reason === 'session_mismatch' ||
      decision.reason === 'stale_sequence'
    ) {
      return;
    }
    // Advance for accepted updates and for newer events rejected only because
    // Finish/terminal already won — so a late pause cannot apply afterward.
    lastStatusSequenceRef.current = decision.nextSequence;
    if (!decision.accept || !current || !status.session) return;

    const session = status.session;
    if (session.state === 'paused') {
      const wasRecording = activeRef.current || current.state === 'recording';
      applySession(session);
      if (wasRecording) {
        // A forced transition FROM recording (never one the owner chose —
        // pauseRecording() below applies its own session directly and never
        // reaches this branch). Surface the reason so the UI can show a
        // targeted "tap Resume to continue" recovery state instead of a
        // plain, indistinguishable paused screen — this is the fix for the
        // P0 where a checkpoint rollover failure left the owner staring at
        // an ordinary-looking paused screen with no indication anything had
        // gone wrong.
        setDegradedReason(status.interruptionState ?? status.routeChangeState ?? 'native_forced_pause');
        // Reuses the SAME error surface the screen already renders (no new
        // UI) — only for this specific, previously-silent P0 case. A plain
        // interruption/route-change forced pause is left exactly as it
        // already behaved (out of this fix's scope), since those already
        // have their own established, working recovery flow.
        if (status.interruptionState === 'checkpoint_begin_segment_failed') {
          fail('Recording paused — tap Resume to continue.', 'checkpoint_begin_segment_failed');
        }
        logRecordingEvent('native_recording_paused', {
          segmentCount: session.segments.length,
          reason: status.interruptionState
            ?? status.routeChangeState
            ?? status.runtimeState
            ?? 'native_status',
        });
      }
      return;
    }

    if (session.state === 'recording') {
      // Keep an already-running local timer intact; only correct a false paused UI.
      sessionRef.current = session;
      baseDurationRef.current = finalizedDurationMillis(session);
      if (!activeRef.current) {
        activeStartedAtRef.current = Date.now();
        activeRef.current = true;
        setIsPaused(false);
        setIsRecording(true);
        setDurationMillis(baseDurationRef.current);
      }
      return;
    }

    if (session.state === 'finalized') {
      applySession(session);
      activeRef.current = false;
      setIsRecording(false);
      setIsPaused(false);
    }
  }, [applySession, fail]);

  useEffect(() => {
    if (!enabled) return;
    let mounted = true;
    // The Expo native module, not this React hook, owns an active durable
    // capture. A screen can unmount while the module keeps recording and
    // checkpointing. On remount, read live native status as well as durable
    // metadata so the UI reattaches rather than treating navigation as Pause.
    void Promise.all([
      getMicrophonePermissionStatus(),
      listRecoverableSessions(),
      getRecordingStatus().catch(() => null),
    ]).then(([state, sessions, liveStatus]) => {
      if (!mounted) return;
      setPermissionStatus(permission(state)); setPermissionChecked(true);
      const match = recoverableSessionsForLecture(sessions, lectureId)[0] ?? null;
      setRecoverableSession(match);
      const liveMatch = match && liveStatus?.recordingSessionId === match.recordingSessionId
        ? liveStatus?.session ?? null
        : null;
      if (liveMatch) noteStatusSequence(liveStatus);
      if (liveMatch ?? match) applySession(liveMatch ?? match);
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
  }, [applySession, enabled, lectureId, noteStatusSequence]);

  // Native is authoritative for forced-pause. One listener for the hook lifetime.
  useEffect(() => {
    if (!enabled) return;
    return addRecordingStatusListener((status) => {
      applyNativeStatus(status);
    });
  }, [applyNativeStatus, enabled]);

  // Lifecycle safety net: refresh once on foreground (no interval polling).
  useEffect(() => {
    if (!enabled) return;
    const subscription = AppState.addEventListener('change', (next) => {
      traceRecordingLifecycle('APPSTATE', { state: next, sessionState: sessionRef.current?.state ?? null, uiRecording: activeRef.current });
      if (next !== 'active') return;
      const session = sessionRef.current;
      if (!session) return;
      if (session.state === 'finalized' || session.state === 'abandoned' || session.state === 'failed') return;
      if (!activeRef.current && session.state !== 'paused' && session.state !== 'recording') return;
      traceRecordingLifecycle('FOREGROUND_REFRESH_START');
      void getRecordingStatus()
        .then((status) => { traceRecordingLifecycle('FOREGROUND_REFRESH_DONE', { runtime: status.runtimeState, sessionState: status.session?.state }); applyNativeStatus(status); })
        .catch(() => { traceRecordingLifecycle('FOREGROUND_REFRESH_FAILED'); });
    });
    return () => subscription.remove();
  }, [applyNativeStatus, enabled]);

  useEffect(() => {
    if (!isRecording) return;
    const timer = setInterval(() => {
      const started = activeStartedAtRef.current;
      setDurationMillis(baseDurationRef.current + (started ? Date.now() - started : 0));
    }, 250);
    return () => clearInterval(timer);
  }, [isRecording]);

  const requestPermission = useCallback(async () => {
    try {
      let session = sessionRef.current;
      if (!session) { session = await createSession({ lectureId }); applySession(session); }
      const status = await prepareRecording({ recordingSessionId: session.recordingSessionId, requestPermission: true });
      if (status.session) applySession(status.session);
      noteStatusSequence(status);
      setPermissionStatus(permission(status.permission)); setPermissionChecked(true);
      return status.permission === 'granted';
    } catch (failure) { fail('Could not request microphone permission.', failure); return false; }
  }, [applySession, fail, lectureId, noteStatusSequence]);

  const startRecording = useCallback(async () => {
    if (!enabled || recoverableSession) return false;
    try {
      setError(null); setErrorDetail(null); setRecordingUri(null);
      finishingRef.current = false;
      let session = sessionRef.current;
      if (!session || session.state === 'finalized' || session.state === 'abandoned' || session.state === 'failed') {
        session = await createSession({ lectureId }); applySession(session);
      }
      const prepared = await prepareRecording({ recordingSessionId: session.recordingSessionId, requestPermission: true });
      noteStatusSequence(prepared);
      setPermissionStatus(permission(prepared.permission)); setPermissionChecked(true);
      const started = await startNative({ recordingSessionId: session.recordingSessionId });
      noteStatusSequence(started);
      if (started.session) sessionRef.current = started.session;
      activeStartedAtRef.current = Date.now(); activeRef.current = true; setIsPaused(false); setIsRecording(true);
      logRecordingEvent('native_recording_started', { engine: 'nativeDurable' });
      return true;
    } catch (failure) {
      // A genuinely active OTHER session is the one conflict a paused
      // session's ownership release still correctly refuses to silently
      // resolve (native claim()) — give a specific, actionable reason
      // instead of the generic message this catch otherwise shares with
      // every other start failure.
      fail(
        isRecorderBusyError(failure)
          ? 'Another recording is currently active. Finish or pause it before starting a new one.'
          : 'Could not start the recording. Please try again.',
        failure,
      );
      logRecordingEvent('native_initialization_failed', { reason: 'native_initialization_failed' });
      return false;
    }
  }, [applySession, enabled, fail, lectureId, noteStatusSequence, recoverableSession]);

  const pauseRecording = useCallback(async () => {
    const session = sessionRef.current; if (!session || !isRecording) return false;
    traceRecordingLifecycle('UI_PAUSE_REQUEST');
    try {
      const status = await pauseNative({ recordingSessionId: session.recordingSessionId });
      noteStatusSequence(status);
      if (status.session) applySession(status.session);
      logRecordingEvent('native_recording_paused', {
        segmentCount: status.session?.segments.length ?? session.segments.length,
      });
      return true;
    } catch (failure) { fail('Could not pause the recording.', failure); return false; }
  }, [applySession, fail, isRecording, noteStatusSequence]);

  const resumeRecording = useCallback(async () => {
    const session = sessionRef.current; if (!session) return false;
    traceRecordingLifecycle('UI_RESUME_REQUEST', { sessionState: session.state });
    try {
      const status = session.state === 'paused'
        ? await resumeNative({ recordingSessionId: session.recordingSessionId })
        : await (async () => {
            const prepared = await prepareRecording({
              recordingSessionId: session.recordingSessionId,
              requestPermission: true,
            });
            noteStatusSequence(prepared);
            setPermissionStatus(permission(prepared.permission)); setPermissionChecked(true);
            return startNative({ recordingSessionId: session.recordingSessionId });
          })();
      noteStatusSequence(status);
      if (status.session) sessionRef.current = status.session;
      baseDurationRef.current = finalizedDurationMillis(status.session ?? session);
      activeStartedAtRef.current = Date.now(); activeRef.current = true; setIsPaused(false); setIsRecording(true);
      // A successful resume — including retrying the segment a checkpoint
      // rollover failed to open — is no longer degraded.
      setDegradedReason(null);
      logRecordingEvent('native_recording_resumed', {
        segmentCount: (status.session ?? session).segments.length,
      });
      return true;
    } catch (failure) {
      fail(
        isRecorderBusyError(failure)
          ? 'Another recording is currently active. Finish or pause it before resuming this one.'
          : 'Could not resume the recording.',
        failure,
      );
      return false;
    }
  }, [fail, noteStatusSequence]);

  const finishSession = useCallback(async (session: DurableRecordingSession): Promise<string | null> => {
    finishingRef.current = true;
    // A session with no committed segments AND no active capture in flight
    // has genuinely nothing to finalize — the exact P0 shape (a session
    // stuck at `created`, zero segments, that never actually started
    // capturing). Without this, it would fall through to
    // finalizeAndExportDurableSession's `durationMs <= 0` guard and surface
    // the SAME generic "Could not finish the recording." as a real,
    // committed-audio finalize failure — indistinguishable to the owner.
    // `state !== 'recording'` matters: a session mid-first-segment (zero
    // committed segments because no checkpoint has fired yet) still has
    // real audio in flight and must go through the normal finalize path.
    if (session.segments.length === 0 && session.state !== 'recording') {
      finishingRef.current = false;
      fail('Nothing has been recorded yet.', 'zero_segment_session');
      return null;
    }
    finalAssetDurationMillisRef.current = null;
    const finishStartedAt = Date.now();
    traceRecordingLifecycle('FINISH_JS_BEGIN', { state: session.state, segments: session.segments.length, appState: AppState.currentState });
    const result = await finalizeAndExportDurableSession(session, noteStatusSequence);
    traceRecordingLifecycle('FINISH_JS_RESULT', {
      ok: result.ok, ms: Date.now() - finishStartedAt, appState: AppState.currentState,
      durationMs: result.ok ? result.durationMs : null,
    });
    if (!result.ok) {
      finishingRef.current = false;
      // A failed Finish may already have stopped native capture. Re-read the durable session so the JS timer stops
      // counting wall-clock time against a recorder that is no longer recording (P0 d184e93f: the stale timer kept
      // running and was autosaved as the lecture duration).
      try {
        const latest = await getSession(session.recordingSessionId);
        if (latest.state !== 'recording') {
          applySession(latest); activeRef.current = false; setIsRecording(false); setIsPaused(true);
        }
      } catch {
        // Keep the existing state; the error below is still surfaced.
      }
      fail('Could not finish the recording.', result.error);
      return null;
    }
    finalAssetDurationMillisRef.current = result.durationMs;
    applySession(result.session); activeRef.current = false; setIsRecording(false); setIsPaused(false);
    setRecordingUri(result.fileUri);
    logRecordingEvent('native_recording_finalized', {
      segmentCount: result.session.segments.length,
      durationBucket: durationBucket(result.session.finalAsset?.durationMs ?? null),
      sessionState: result.session.state,
    });
    return result.fileUri;
  }, [applySession, fail, noteStatusSequence]);

  const stopRecording = useCallback(async () => {
    const session = sessionRef.current; return session ? finishSession(session) : null;
  }, [finishSession]);
  const leaveRecording = useCallback(async () => {
    // Deliberately no-op for the durable engine. Navigation and React
    // unmounting are not recording-state transitions; only pauseRecording
    // and stopRecording may stop native capture. The native module retains
    // exclusive ownership of this recordingSessionId while the screen is away.
    return null;
  }, []);
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
      lastStatusSequenceRef.current = 0;
      finishingRef.current = false;
      logRecordingEvent('native_recovery_discarded', { sessionState: session.state });
    } catch (failure) { fail('Could not discard the unfinished recording.', failure); throw failure; }
  }, [fail, recoverableSession]);

  return {
    engine: 'nativeDurable', permissionChecked, permissionStatus, recoveryChecked, recoverableSession,
    isRecording, isPaused, degradedReason, durationMillis, recordingUri, liveFileUri: null, error, errorDetail,
    requestPermission, startRecording, pauseRecording, resumeRecording, stopRecording, leaveRecording,
    getFinalAudioDurationMillis: () => finalAssetDurationMillisRef.current,
    recoverRecording, finishRecoverableRecording, discardRecoverableRecording,
    acknowledgeFinalizedOutput,
    // Visibility is screen-local. Keeping this session selected ensures a
    // dismissal can never trigger automatic recording or discard native data.
    dismissRecovery: () => {},
  };
}
