import { useEffect, useState } from 'react';

import { listRecoverableSessions, type DurableRecordingSession } from '@/modules/expo-durable-recorder';

import { ownedUnresolvedRecoverableSessions } from './policy.mjs';

export type UnresolvedRecordingGuard = {
  /** Whether the lookup has resolved (or was skipped because `enabled` is false). */
  checked: boolean;
  /** Exactly one other unresolved recoverable session exists — reattach to it instead of creating a new one. */
  singleMatch: DurableRecordingSession | null;
  /** More than one exists — ambiguous; do not guess which one, block instead. */
  ambiguous: boolean;
};

/**
 * Guards against silently creating a fresh lecture+session while a
 * DIFFERENT lecture already has a real, unresolved recoverable recording
 * sitting abandoned — the exact P0 shape: a native checkpoint rollover
 * failed to open its next segment, leaving a 132s recording paused and
 * recoverable, and a later param-less `/recording` mount created a
 * brand-new, empty lecture right alongside it instead of surfacing the
 * original for recovery.
 *
 * `enabled` should be false whenever an explicit `lectureId` is already
 * driving this screen — that case is always authoritative and already
 * handled by the normal per-lecture recovery lookup
 * (useDurableMediaOwnership / useNativeDurableLectureRecorder's own init
 * effect). This guard exists only for the param-less "start fresh" path.
 */
export function useUnresolvedRecordingGuard(
  enabled: boolean,
  excludeLectureId: string,
  activeRecoveryLectureIds: readonly string[],
): UnresolvedRecordingGuard {
  const [state, setState] = useState<UnresolvedRecordingGuard>({ checked: false, singleMatch: null, ambiguous: false });

  useEffect(() => {
    if (!enabled) {
      setState({ checked: true, singleMatch: null, ambiguous: false });
      return;
    }
    let mounted = true;
    setState({ checked: false, singleMatch: null, ambiguous: false });
    void listRecoverableSessions()
      .then((sessions) => {
        if (!mounted) return;
        // Native sessions live at the app-container level.  Only the caller's
        // current-account, active lecture IDs are authoritative ownership;
        // unknown, deleted, and cross-account sessions stay preserved but
        // cannot block or be adopted by this fresh-recording flow.
        const matches = ownedUnresolvedRecoverableSessions(sessions, excludeLectureId, activeRecoveryLectureIds);
        if (matches.length === 0) setState({ checked: true, singleMatch: null, ambiguous: false });
        else if (matches.length === 1) setState({ checked: true, singleMatch: matches[0], ambiguous: false });
        else setState({ checked: true, singleMatch: null, ambiguous: true });
      })
      .catch(() => {
        // Fail OPEN: this guard is a protection against silently orphaning
        // real audio, not a strict integrity boundary — a transient lookup
        // failure must not permanently block starting any new recording.
        if (!mounted) return;
        setState({ checked: true, singleMatch: null, ambiguous: false });
      });
    return () => {
      mounted = false;
    };
  }, [enabled, excludeLectureId, activeRecoveryLectureIds]);

  return state;
}
