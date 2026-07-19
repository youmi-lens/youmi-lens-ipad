/**
 * Phase 4B — guarded rollout resolution for the recording screen.
 *
 * Responsibilities, in order of importance:
 *
 *  1. When the activation gate is off (the committed default) this hook makes
 *     **zero** network requests and returns null immediately. That is what
 *     keeps the app safe while the rollout table does not exist.
 *  2. It never blocks recording. Resolution is asynchronous and legacy is used
 *     until a decision arrives; nothing here can leave the screen loading.
 *  3. A result from a previous user or a superseded request is discarded, so a
 *     slow response can never be applied to the wrong account.
 */
import { useEffect, useRef, useState } from 'react';

import { logRecordingEvent } from './diagnostics';
import { REMOTE_ROLLOUT_ENABLED } from './featureGate';
import { createRequestDeduper } from './requestDedupe.mjs';
import { fetchRolloutEligibility, type RolloutEligibility } from './rolloutProvider';

/** In-flight requests keyed by user, so re-renders and double-mounts share one. */
const deduper = createRequestDeduper();

function dedupedFetch(userId: string): Promise<RolloutEligibility> {
  return deduper.run(
    userId,
    () => fetchRolloutEligibility({ userId }),
    () => logRecordingEvent('rollout_request_deduplicated', {}),
  ) as Promise<RolloutEligibility>;
}

/** Test seam: clears in-flight tracking between cases and on sign-out. */
export function resetRolloutRequests(): void {
  deduper.clear();
}

/**
 * Resolves rollout eligibility for the signed-in user.
 *
 * Returns null while unresolved — the policy treats that as "no rollout input"
 * and falls back to legacy, so a pending decision never enables native.
 */
export function useRolloutEligibility(options: {
  userId: string | null;
  authLoading: boolean;
}): RolloutEligibility | null {
  const { userId, authLoading } = options;
  const [eligibility, setEligibility] = useState<RolloutEligibility | null>(null);

  // Incremented on every auth change; a response tagged with an old value is
  // stale and must be dropped rather than applied to a different account.
  const generationRef = useRef(0);
  const disabledLoggedRef = useRef(false);

  useEffect(() => {
    // Committed default: the gate is off, so no request is ever issued.
    if (!REMOTE_ROLLOUT_ENABLED) {
      if (!disabledLoggedRef.current) {
        disabledLoggedRef.current = true;
        logRecordingEvent('rollout_remote_provider_disabled', { reason: 'rollout_remote_disabled' });
      }
      return;
    }

    // Wait for auth to settle. Resolving against a half-known identity risks
    // reading another account's cached decision.
    if (authLoading) return;

    generationRef.current += 1;
    const generation = generationRef.current;

    // Signed out: no per-user rollout exists and nobody is enrolled anonymously.
    if (!userId) {
      setEligibility(null);
      return;
    }

    let cancelled = false;
    logRecordingEvent('rollout_resolution_started', {});

    void dedupedFetch(userId).then((result) => {
      if (cancelled || generation !== generationRef.current) {
        logRecordingEvent('rollout_resolution_ignored_as_stale', {});
        return;
      }
      setEligibility(result);
      logRecordingEvent('rollout_resolution_completed', {
        engine: result.eligible ? 'nativeDurable' : 'legacy',
        source: result.source,
        reason: result.reason ?? undefined,
        cohort: result.cohort ?? undefined,
        configRevision: result.revision ?? undefined,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [userId, authLoading]);

  return REMOTE_ROLLOUT_ENABLED ? eligibility : null;
}
