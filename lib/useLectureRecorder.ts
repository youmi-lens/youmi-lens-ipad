import { useEffect } from 'react';

import { formatRecordingDiagnosticSummary, logRecordingEvent } from './recording/diagnostics';
import { resolveRecordingEngineDecisionForRuntime } from './recording/featureGate';
import type { LectureRecorder } from './recording/types';
import { useLegacyLectureRecorder } from './recording/useLegacyLectureRecorder';
import { useNativeDurableLectureRecorder } from './recording/useNativeDurableLectureRecorder';

export type { LectureRecorder, RecorderPermission } from './recording/types';
export type {
  RecordingEngine,
  RecordingEngineSource,
  RecordingFallbackReason,
} from './recording/featureGate';

export function useLectureRecorder(options: { lectureId: string; forceLegacy?: boolean }): LectureRecorder {
  const decision = resolveRecordingEngineDecisionForRuntime({
    forceLegacy: options.forceLegacy === true,
  });
  const engine = decision.engine;
  const legacy = useLegacyLectureRecorder(engine === 'legacy');
  const nativeDurable = useNativeDurableLectureRecorder(engine === 'nativeDurable', options.lectureId);
  const active = engine === 'nativeDurable' ? nativeDurable : legacy;

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

  return active;
}
