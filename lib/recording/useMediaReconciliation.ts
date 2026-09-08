/**
 * Re-entrant trigger for general media reconciliation (see
 * mediaReconciliation.ts for the "why"). Shared by every safe trigger point
 * (Lecture Detail open, Processing open, app relaunch) so the assess/run/
 * persist sequence exists in exactly one place.
 *
 * Sequencing is the safety property here, not extra guard fields: while
 * discovery/composition runs, NOTHING about the lecture's current canonical
 * media, upload state, or processing state is touched — only the
 * diagnostic-only `mediaReconciliationStatus: 'running'` flag is set, which
 * nothing else reads for routing/gating. The lecture stays exactly as
 * usable as it was. Only after the corrected asset is independently
 * validated does a single atomic updateLecture flip the canonical audio
 * AND reset uploadStatus/processingStatus together — so the app can never
 * observe "corrected audio, but AI content still describing the old one":
 * the moment the audio changes, processingStatus leaves 'ready' in the same
 * write, and the existing orchestrator re-drives upload+processing through
 * its own already-safe path (mergeProcessingSnapshot never lets an empty
 * in-flight snapshot clobber the preserved prior transcript/summary).
 *
 * Idempotency comes from assessMediaReconciliation itself (it compares
 * against the already-persisted mediaReconciliationSourceIds), so repeat
 * opens with an unchanged source set are a single cheap listRecoverableSessions
 * call and nothing else — this hook adds only an in-mount ref to avoid
 * firing twice for the same lecture id within one mount.
 */
import { useEffect, useRef } from 'react';

import type { Lecture } from '@/lib/models';

import { assessMediaReconciliation, runMediaReconciliation } from './mediaReconciliation';

export function useMediaReconciliation(
  lecture: Lecture | undefined,
  updateLecture: (id: string, patch: Partial<Lecture>) => void,
) {
  const attemptedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!lecture) return;
    // Only relevant for a lecture that already has a canonical local asset —
    // a lecture still mid-recording/mid-assembly is covered by the existing
    // audioAssemblyStatus guard, not this re-entry path.
    if (!lecture.localAudioUri) return;
    if (lecture.mediaReconciliationStatus === 'running') return;
    if (attemptedForRef.current === lecture.id) return;
    attemptedForRef.current = lecture.id;

    const lectureId = lecture.id;
    void (async () => {
      const assessment = await assessMediaReconciliation(lectureId, lecture);
      if (!assessment.needed) return;

      if (__DEV__) {
        console.info('[MediaRecovery] reconciliation-required', {
          lectureId,
          durableSessionId: assessment.durableSessionId,
          durableSegmentCount: assessment.durableSegmentCount,
        });
      }
      updateLecture(lectureId, { mediaReconciliationStatus: 'running' });

      const result = await runMediaReconciliation(lectureId, lecture.audioSegments);
      if (!result.ok) {
        if (__DEV__) console.info('[MediaRecovery] reconciliation-failed', { lectureId, reason: result.reason, detail: result.detail });
        updateLecture(lectureId, {
          mediaReconciliationStatus: result.reason === 'ambiguous_overlap' ? 'ambiguous' : 'failed',
          mediaReconciliationDetail: result.detail,
        });
        return;
      }

      if (__DEV__) console.info('[MediaRecovery] reconciliation-complete', { lectureId, durationMillis: result.durationMillis, sourceCount: result.sourceIds.length });
      updateLecture(lectureId, {
        localAudioUri: result.localAudioUri,
        durationMillis: result.durationMillis,
        mediaReconciliationStatus: 'complete',
        mediaReconciliationSourceIds: result.sourceIds,
        mediaReconciliationCompletedAt: new Date().toISOString(),
        // The corrected audio invalidates any AI content generated from the
        // old, incomplete asset — re-drive it through the existing,
        // already-safe upload/processing pipeline rather than duplicating
        // that orchestration here.
        uploadStatus: 'not_uploaded',
        uploadError: undefined,
        processingStatus: 'not_started',
      });
    })();
  }, [lecture, updateLecture]);
}
