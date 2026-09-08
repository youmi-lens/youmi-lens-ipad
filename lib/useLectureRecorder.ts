import { useEffect, useRef, useState } from 'react';

import { formatRecordingDiagnosticSummary, logRecordingEvent } from './recording/diagnostics';
import { resolveRecordingEngineOwnershipDecisionForRuntime } from './recording/featureGate';
import type { RolloutEligibility } from './recording/rolloutProvider';
import type { LectureRecorder } from './recording/types';
import { useDurableMediaOwnership } from './recording/useDurableMediaOwnership';
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

  // A lecture that already owns recoverable native-durable media must never
  // silently resume through legacy, even when the current rollout default is
  // legacy — see resolveRecordingEngineOwnershipDecisionForRuntime's own doc
  // comment. This is a live lookup, not a read of the lecture's own
  // persisted `recordingEngine`, which is not reliable evidence (a later
  // legacy write can overwrite it while the durable session itself sits
  // untouched on disk).
  const ownership = useDurableMediaOwnership(options.lectureId);

  // Do not decide (or freeze) the engine until the durable-ownership lookup
  // has resolved — deciding early risks locking in a premature 'legacy' pick
  // before durable evidence has had a chance to load. Neither underlying
  // engine activates during this brief gap (both `enabled` flags below stay
  // false), the same safe idle state either hook already has today whenever
  // it is the non-selected engine.
  const engineChecked = frozenEngineRef.current !== null || ownership.checked;
  const decision = engineChecked
    ? resolveRecordingEngineOwnershipDecisionForRuntime({
        forceLegacy: options.forceLegacy === true,
        rollout: options.rollout ?? null,
        frozenEngine: frozenEngineRef.current,
        hasDurableEvidence: ownership.hasDurableEvidence,
      })
    : null;
  if (decision && frozenEngineRef.current === null) frozenEngineRef.current = decision.engine;
  const engine = frozenEngineRef.current;
  const legacy = useLegacyLectureRecorder(!options.visualFixture && engineChecked && engine === 'legacy');
  const nativeDurable = useNativeDurableLectureRecorder(!options.visualFixture && engineChecked && engine === 'nativeDurable', options.lectureId);
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

  // `decision` is only null for the brief render(s) before the durable-
  // ownership lookup resolves — nothing has started yet (see engineChecked
  // above), so there is nothing meaningful to log during that gap.
  const { engine: decidedEngine, source, fallbackReason } = decision ?? { engine: null, source: null, fallbackReason: null };
  const { errorDetail, recordingUri, recoverableSession } = active;

  useEffect(() => {
    if (!decision) return;
    if (decision.fallbackReason) {
      logRecordingEvent('recorder_fallback_to_legacy', {
        engine: decision.engine,
        source: decision.source,
        reason: decision.fallbackReason,
      });
    }
    if (!__DEV__) return;
    // Developer-readable summary. Carries no identifiers, paths, or content.
    console.info(
      '[recorder] diagnostics',
      formatRecordingDiagnosticSummary({
        engine: decision.engine,
        source: decision.source,
        fallbackReason: decision.fallbackReason,
        nativeCapabilityAvailable: decision.fallbackReason === null,
        recoverableSessionCount: recoverableSession ? 1 : 0,
        hasReconciliationIssues: Boolean(errorDetail),
        lastOutcome: recordingUri ? 'finalized' : null,
        defaultsToLegacy: true,
      }),
    );
  }, [decidedEngine, source, fallbackReason, errorDetail, recordingUri, recoverableSession]);

  return options.visualFixture ? fixture : active;
}
