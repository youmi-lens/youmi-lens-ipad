import { useEffect, useRef, useState } from 'react';

import { formatRecordingDiagnosticSummary, logRecordingEvent } from './recording/diagnostics';
import { resolveRecordingEngineDecisionForRuntime } from './recording/featureGate';
import type { RolloutEligibility } from './recording/rolloutProvider';
import type { LectureRecorder } from './recording/types';
import { useLegacyLectureRecorder } from './recording/useLegacyLectureRecorder';
import { useNativeDurableLectureRecorder } from './recording/useNativeDurableLectureRecorder';

export type { LectureRecorder, RecorderPermission } from './recording/types';
export type {
  RecordingEngine,
  RecordingEngineSource,
  RecordingFallbackReason,
} from './recording/featureGate';

export function useLectureRecorder(options: {
  lectureId: string;
  forceLegacy?: boolean;
  rollout?: RolloutEligibility | null;
  /** Explicit DEV visual fixture: never initializes either native recorder. */
  visualFixture?: boolean;
}): LectureRecorder {
  // The engine is resolved once per recording session and then frozen. A later
  // rollout change, cache refresh or token refresh must not switch engines
  // underneath an in-flight recording.
  const frozenEngineRef = useRef<'legacy' | 'nativeDurable' | null>(null);
  const decision = resolveRecordingEngineDecisionForRuntime({
    forceLegacy: options.forceLegacy === true,
    rollout: options.rollout ?? null,
    frozenEngine: frozenEngineRef.current,
  });
  if (frozenEngineRef.current === null) frozenEngineRef.current = decision.engine;
  const engine = decision.engine;
  const legacy = useLegacyLectureRecorder(!options.visualFixture && engine === 'legacy');
  const nativeDurable = useNativeDurableLectureRecorder(!options.visualFixture && engine === 'nativeDurable', options.lectureId);
  const active = engine === 'nativeDurable' ? nativeDurable : legacy;
  const [fixturePaused, setFixturePaused] = useState(false);
  const [fixtureMillis, setFixtureMillis] = useState(502000);
  useEffect(() => {
    if (!options.visualFixture || fixturePaused) return;
    const timer = setInterval(() => setFixtureMillis((value) => value + 1000), 1000);
    return () => clearInterval(timer);
  }, [options.visualFixture, fixturePaused]);
  const fixture: LectureRecorder = {
    engine: 'legacy', permissionChecked: true, permissionStatus: 'granted', recoveryChecked: true,
    recoverableSession: null, isRecording: true, isPaused: fixturePaused, durationMillis: fixtureMillis,
    recordingUri: null, error: null, errorDetail: null,
    requestPermission: async () => true, startRecording: async () => true,
    pauseRecording: async () => setFixturePaused(true), resumeRecording: async () => setFixturePaused(false),
    stopRecording: async () => null, leaveRecording: async () => null, recoverRecording: async () => false,
    finishRecoverableRecording: async () => null, acknowledgeFinalizedOutput: async () => true,
    discardRecoverableRecording: async () => {}, dismissRecovery: () => {},
  };

  const { engine: decidedEngine, source, fallbackReason } = decision;
  const { errorDetail, recordingUri, recoverableSession } = active;

  useEffect(() => {
    if (fallbackReason) {
      logRecordingEvent('recorder_fallback_to_legacy', {
        engine: decidedEngine,
        source,
        reason: fallbackReason,
      });
    }
    if (!__DEV__) return;
    // Developer-readable summary. Carries no identifiers, paths, or content.
    console.info(
      '[recorder] diagnostics',
      formatRecordingDiagnosticSummary({
        engine: decidedEngine,
        source,
        fallbackReason,
        nativeCapabilityAvailable: fallbackReason === null,
        recoverableSessionCount: recoverableSession ? 1 : 0,
        hasReconciliationIssues: Boolean(errorDetail),
        lastOutcome: recordingUri ? 'finalized' : null,
        defaultsToLegacy: true,
      }),
    );
  }, [decidedEngine, source, fallbackReason, errorDetail, recordingUri, recoverableSession]);

  return options.visualFixture ? fixture : active;
}
