import { useEffect, useState } from 'react';

import { listRecoverableSessions, type DurableRecordingSession } from '@/modules/expo-durable-recorder';

import { recoverableSessionsForLecture } from './policy.mjs';

export type DurableMediaOwnership = {
  /** Whether the lookup for the current lectureId has resolved. */
  checked: boolean;
  /** Whether a recoverable durable session with at least one segment exists. */
  hasDurableEvidence: boolean;
};

/**
 * Whether `lectureId` already owns a recoverable native-durable session with
 * at least one validated segment — the one signal
 * resolveRecordingEngineOwnershipDecision needs to keep an existing
 * durable recording from being silently resumed through legacy.
 *
 * The persisted `recordingEngine` field on the lecture record is NOT used
 * for this: a later legacy write can overwrite it while the durable
 * session itself sits untouched on disk (exactly what happened to a real
 * lecture — a ~96-minute durable session the app stopped looking for).
 * This queries the durable recorder's own session store directly, the
 * same way useNativeDurableLectureRecorder already does for its own
 * recovery-offer UI.
 */
export function useDurableMediaOwnership(lectureId: string): DurableMediaOwnership {
  const [state, setState] = useState<DurableMediaOwnership>({ checked: false, hasDurableEvidence: false });

  useEffect(() => {
    let mounted = true;
    setState({ checked: false, hasDurableEvidence: false });
    void listRecoverableSessions()
      .then((sessions) => {
        if (!mounted) return;
        const matches: DurableRecordingSession[] = recoverableSessionsForLecture(sessions, lectureId);
        const hasDurableEvidence = matches.some((session) => (session.segments?.length ?? 0) > 0);
        setState({ checked: true, hasDurableEvidence });
      })
      .catch(() => {
        // Fail closed: cannot prove durable evidence exists, so don't claim
        // it does — but still mark checked so the caller isn't stuck
        // waiting forever. Falls through to rollout policy, same as today.
        if (!mounted) return;
        setState({ checked: true, hasDurableEvidence: false });
      });
    return () => {
      mounted = false;
    };
  }, [lectureId]);

  return state;
}
