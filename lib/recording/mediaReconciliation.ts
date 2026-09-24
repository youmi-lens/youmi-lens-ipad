/**
 * General media reconciliation — the re-entry path for a lecture that
 * ALREADY finished a legacy-only recovery (or was never blocked at all)
 * but still has validated media that legacy-only discovery never knew to
 * look for. `audioAssemblyStatus` is a one-shot guard for a single
 * legacy-resume episode; it does not reopen once cleared, and a lecture
 * can reach `status: 'local_recorded'`, `uploadStatus: 'uploaded'`,
 * `processingStatus: 'ready'` while a completely separate native-durable
 * session for the same lectureId sits unfinalized and undiscovered. This
 * module is the check (cheap, safe at low-frequency boundaries) and the
 * shared execution (reused by both the legacy-guard flow and this one, so
 * the discovery/composition orchestration itself is never duplicated).
 */
import { listRecoverableSessions, type DurableRecordingSession } from '@/modules/expo-durable-recorder';

import type { Lecture } from '@/lib/models';

import { orderLegacyAudioSegments } from './legacyAudioAssembly';
import { assembleDiscoveredSources, discoverRecoverySources } from './mediaSourceDiscovery';
import { finalizedDurationMillis, recoverableSessionsForLecture } from './policy.mjs';

export type MediaReconciliationAssessment =
  | { needed: false }
  | {
      needed: true;
      durableSessionId: string;
      durableSegmentCount: number;
      durableDurationMs: number;
    };

/**
 * Cheap, low-frequency check — one `listRecoverableSessions()` call and a
 * pure comparison. Never exports, composes, or persists anything, so it is
 * safe to run on every Lecture Detail / Processing screen mount, not just
 * once.
 *
 * Completeness is proven two ways, NEITHER of which is merely "this
 * session's id was previously seen somewhere" — that was the exact Build
 * 50 P0 bug: a false `mediaReconciliationStatus: 'complete'` persisted
 * `mediaReconciliationSourceIds: [durableSessionId]` while the canonical
 * asset was still the old, unrelated 2:18 recording (native's own
 * completed-workspace-reuse shortcut had handed back a stale asset for a
 * different request — see mediaSourceDiscovery.ts / LegacyAudioAssembly.swift).
 *
 * 1. `mediaReconciliationSourceIds` must equal, IN ORDER, the full expected
 *    source set — the recoverable durable session first, then every
 *    currently-known legacy segment — not just contain the durable id.
 *    Missing, extra, or reordered entries mean the recorded completion does
 *    not actually describe the complete set and must be treated as
 *    incomplete regardless of what the status field says.
 * 2. The lecture's own `durationMillis` must be at least as long as the
 *    recoverable durable session's own already-known verified duration
 *    (from the same `listRecoverableSessions()` call above, so this stays
 *    cheap). A canonical asset that genuinely includes a session can never
 *    be shorter than that session alone — this alone catches the exact
 *    failure mode above even if the id-list check were ever satisfied.
 */
export async function assessMediaReconciliation(
  lectureId: string,
  lecture: Pick<Lecture, 'mediaReconciliationSourceIds' | 'audioSegments' | 'durationMillis'>,
): Promise<MediaReconciliationAssessment> {
  let sessions: DurableRecordingSession[];
  try {
    sessions = await listRecoverableSessions();
  } catch {
    // Cannot prove reconciliation is needed — fail closed (do nothing)
    // rather than guess. The existing lecture stays exactly as it is.
    return { needed: false };
  }
  const matches: DurableRecordingSession[] = recoverableSessionsForLecture(sessions, lectureId).filter(
    (session: DurableRecordingSession) => (session.segments?.length ?? 0) > 0,
  );
  if (matches.length === 0) return { needed: false };

  // Ambiguity between multiple candidate sessions is discoverRecoverySources'
  // job to reject at composition time — assessment only needs to decide
  // WHETHER to trigger, so the first match is a sufficient target here.
  const target = matches[0];
  const durableDurationMs = finalizedDurationMillis(target);

  const orderedLegacy = orderLegacyAudioSegments(lecture.audioSegments ?? []);
  const expectedIds = [
    target.recordingSessionId,
    ...orderedLegacy.map((segment, index) => `${lectureId}:legacy:${index}:${segment.role}`),
  ];
  const recordedIds = lecture.mediaReconciliationSourceIds ?? [];
  const idsMatchExactly =
    recordedIds.length === expectedIds.length && expectedIds.every((id, index) => recordedIds[index] === id);

  const toleranceMs = Math.max(500, Math.round(durableDurationMs * 0.02));
  const durationPlausible = (lecture.durationMillis ?? 0) >= durableDurationMs - toleranceMs;

  if (idsMatchExactly && durationPlausible) return { needed: false };

  return {
    needed: true,
    durableSessionId: target.recordingSessionId,
    durableSegmentCount: target.segments.length,
    durableDurationMs,
  };
}

export type MediaReconciliationFailureReason =
  | 'ambiguous_overlap'
  | 'durable_export_failed'
  | 'legacy_persist_failed'
  | 'legacy_source_invalid'
  | 'no_sources'
  | 'composition_failed';

export type MediaReconciliationResult =
  | { ok: true; localAudioUri: string; durationMillis: number; sourceIds: string[] }
  | { ok: false; reason: MediaReconciliationFailureReason; detail: string };

/**
 * Runs the SAME discovery + composition pipeline the legacy-guard flow
 * uses (mediaSourceDiscovery.ts) — shared, not duplicated — and reports a
 * plain result. Never mutates the lecture; the caller decides how/whether
 * to reconcile state, since the legacy-guard flow and this general
 * re-entry flow persist to different fields with different UX guarantees
 * (the legacy guard blocks Finish; this one must never make an
 * already-Ready lecture unusable while it runs).
 */
export async function runMediaReconciliation(
  lectureId: string,
  legacySegments: Lecture['audioSegments'],
): Promise<MediaReconciliationResult> {
  const discovery = await discoverRecoverySources(lectureId, legacySegments);
  if (!discovery.ok) {
    return { ok: false, reason: discovery.reason, detail: discovery.detail };
  }
  const result = await assembleDiscoveredSources(lectureId, discovery.sources);
  if (!result.ok) {
    return { ok: false, reason: 'composition_failed', detail: result.error };
  }
  return {
    ok: true,
    localAudioUri: result.localAudioUri,
    durationMillis: result.durationMillis,
    sourceIds: discovery.sources.map((source) => source.id),
  };
}
