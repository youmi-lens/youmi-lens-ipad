/**
 * Complete recovery-media source discovery for a lecture.
 *
 * The conceptual bug this fixes: legacy-resume recovery derived its source
 * set from `recordingEngine === 'legacy'` / `audioSegments` alone.
 * `recordingEngine` is the CURRENT/LAST engine, not a complete media
 * manifest — a lecture can carry real, validated audio from an earlier
 * native-durable session that a later legacy resume never looked for. This
 * is exactly what happened to a real lecture: a ~96-minute durable session
 * sat paused and unfinalized while the lecture later resumed through
 * legacy and only ever assembled its own two short files.
 *
 * This module discovers ALL recoverable media for a lectureId — durable
 * and legacy — and proves a safe, non-overlapping chronological order
 * before returning anything. It never guesses: if chronology cannot be
 * proven, it reports ambiguity and returns no sources rather than risking
 * duplicated, missing, or reordered classroom audio.
 */
import {
  assembleLegacyAudio,
  LegacyAudioAssemblyError,
  listRecoverableSessions,
  persistLegacyAudioSources,
  type DurableRecordingSession,
} from '@/modules/expo-durable-recorder';

import type { LectureAudioSegment } from '@/lib/models';

import { finalizeAndExportDurableSession } from './durableSessionRecovery';
import { orderLegacyAudioSegments, type LegacyAudioRecoveryResult } from './legacyAudioAssembly';
import { recoverableSessionsForLecture } from './policy.mjs';

/** One recoverable audio component, whichever engine produced it. */
export type RecoverySource = {
  id: string;
  lectureId: string;
  engine: 'nativeDurable' | 'legacy';
  role: string;
  uri: string;
  verifiedDurationMs: number;
  /** Epoch ms real-world window, when provable; null if not established. */
  windowStartMs: number | null;
  windowEndMs: number | null;
  provenance: string;
};

export type RecoverySourceDiscoveryResult =
  | { ok: true; sources: RecoverySource[] }
  | { ok: false; reason: 'ambiguous_overlap' | 'durable_export_failed' | 'legacy_persist_failed' | 'legacy_source_invalid' | 'no_sources'; detail: string };

function durableSessionWindow(session: DurableRecordingSession): { startMs: number | null; endMs: number | null } {
  const segments = session.segments ?? [];
  if (segments.length === 0) return { startMs: null, endMs: null };
  const ordered = [...segments].sort((a, b) => a.sequence - b.sequence);
  const startMs = Date.parse(ordered[0].createdAt);
  const endMs = Date.parse(ordered[ordered.length - 1].finalizedAt);
  return {
    startMs: Number.isFinite(startMs) ? startMs : null,
    endMs: Number.isFinite(endMs) ? endMs : null,
  };
}

/**
 * Discovers every recoverable media source for `lectureId` and proves a
 * safe assembly order. Read-only for legacy sources except for durably
 * copying them (never moves/deletes originals — same guarantee
 * `persistLegacyAudioSources` already makes); the durable session is only
 * finalized/exported once ordering is already proven safe.
 */
export async function discoverRecoverySources(
  lectureId: string,
  legacySegments: LectureAudioSegment[] | undefined,
): Promise<RecoverySourceDiscoveryResult> {
  const orderedLegacy = orderLegacyAudioSegments(legacySegments ?? []);

  // 1. Cheap durable-session lookup — window only, no export yet.
  let durableSession: DurableRecordingSession | null = null;
  try {
    const sessions = await listRecoverableSessions();
    const matches = recoverableSessionsForLecture(sessions, lectureId).filter(
      (session: DurableRecordingSession) => (session.segments?.length ?? 0) > 0,
    );
    if (matches.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous_overlap',
        detail: `${matches.length} recoverable durable sessions exist for this lecture; cannot prove a single safe order.`,
      };
    }
    durableSession = matches[0] ?? null;
  } catch (error) {
    // Cannot prove one way or the other whether durable evidence exists —
    // fail closed rather than silently proceeding legacy-only.
    return {
      ok: false,
      reason: 'ambiguous_overlap',
      detail: `Could not check for a durable session: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!durableSession && orderedLegacy.length === 0) {
    return { ok: false, reason: 'no_sources', detail: 'No recoverable media found for this lecture.' };
  }

  // 2. Durably persist legacy sources FIRST — this is the only way to get
  // their REAL measured duration and REAL file modification time (the
  // persisted audioSegments[].createdAt is not real file timing — see
  // resumeAudioIntegrity.mjs's own manifest builder, which sources it from
  // the lecture's `date` field, not the file's write time).
  let legacySources: RecoverySource[] = [];
  if (orderedLegacy.length > 0) {
    try {
      const persisted = await persistLegacyAudioSources(
        lectureId,
        orderedLegacy.map((segment) => ({ role: segment.role, uri: segment.uri })),
      );
      legacySources = persisted.sources.map((source, index) => {
        const endMs = source.sourceModifiedAtMs > 0 ? source.sourceModifiedAtMs : null;
        const startMs = endMs != null ? endMs - source.durationMs : null;
        return {
          id: `${lectureId}:legacy:${index}:${source.role}`,
          lectureId,
          engine: 'legacy' as const,
          role: source.role,
          uri: orderedLegacy[index]?.uri ?? '',
          verifiedDurationMs: source.durationMs,
          windowStartMs: startMs,
          windowEndMs: endMs,
          provenance: `legacy ${source.role}, native-verified duration + real file mtime`,
        };
      });
    } catch (error) {
      return {
        ok: false,
        // A native AVAudioFile validation failure is deterministic for this
        // immutable source. Retrying it cannot make an unfinalized/corrupt
        // M4A valid, so callers must not render an endless Retry loop.
        reason: error instanceof LegacyAudioAssemblyError && error.code === 'ERR_LEGACY_AUDIO_ASSEMBLY_SOURCE_VALIDATION_FAILED'
          ? 'legacy_source_invalid'
          : 'legacy_persist_failed',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (!durableSession) {
    return { ok: true, sources: legacySources };
  }

  // 3. Prove non-overlap BEFORE paying for durable export. The durable
  // session must provably END before the EARLIEST legacy source's
  // ESTIMATED START (mtime minus real measured duration) — comparing
  // against legacy mtime alone would not be conservative enough (a long
  // legacy recording could have STARTED before the durable session ended
  // even if it finished writing after).
  const { startMs: durableStartMs, endMs: durableEndMs } = durableSessionWindow(durableSession);
  if (durableEndMs == null) {
    return { ok: false, reason: 'ambiguous_overlap', detail: 'Durable session has no provable end time.' };
  }
  if (legacySources.length > 0) {
    const unknownWindow = legacySources.find((source) => source.windowStartMs == null);
    if (unknownWindow) {
      return {
        ok: false,
        reason: 'ambiguous_overlap',
        detail: `Legacy source "${unknownWindow.role}" has no readable modification time — cannot prove it does not overlap the durable session.`,
      };
    }
    const earliestLegacyStartMs = Math.min(...legacySources.map((source) => source.windowStartMs as number));
    if (durableEndMs >= earliestLegacyStartMs) {
      return {
        ok: false,
        reason: 'ambiguous_overlap',
        detail: 'The durable session and a legacy source are not provably non-overlapping by real timestamps.',
      };
    }
  }

  // 4. Order is proven safe — now finalize/export the durable session (or
  // reuse its existing final asset if already exported).
  const exported = await finalizeAndExportDurableSession(durableSession);
  if (!exported.ok) {
    return { ok: false, reason: 'durable_export_failed', detail: exported.error };
  }

  const durableSource: RecoverySource = {
    id: durableSession.recordingSessionId,
    lectureId,
    engine: 'nativeDurable',
    role: 'durable_recovery',
    uri: exported.fileUri,
    verifiedDurationMs: exported.durationMs,
    windowStartMs: durableStartMs,
    windowEndMs: durableEndMs,
    provenance: `native durable session ${durableSession.recordingSessionId}, ${durableSession.segments.length} segments`,
  };

  return { ok: true, sources: [durableSource, ...legacySources] };
}

/**
 * Same fingerprint algorithm as the native side's `sourceFingerprint`
 * (LegacyAudioAssembly.swift) — role and uri, in order, joined by a record
 * separator. Computed independently here (not trusted from native) so this
 * caller can prove the native result actually answers ITS request rather
 * than assuming `ok: true` means that.
 */
function computeSourceFingerprint(sources: { role: string; uri: string }[]): string {
  return sources.map((source) => `${source.role}::${source.uri}`).join('');
}

/**
 * Composes an already-discovered, already-ordered, already-proven-safe
 * source set into one verified final asset. The native composer does not
 * care which engine produced each source — it just copies+composes
 * ordered URIs, exactly as it already does for legacy-only recovery.
 *
 * Never trusts a bare `ok`/success from native — this was the exact Build
 * 50 P0 bug: native's own "reuse an already-completed workspace" shortcut
 * used to be keyed only on lectureId/state, so a request for a completely
 * different source set (e.g. reconciliation discovering a durable session a
 * legacy-only pass never knew about) could silently receive back an
 * unrelated stale asset while still reporting success. Native is now
 * fingerprint-aware itself (see LegacyAudioAssembly.swift), but this is a
 * second, independent check on the JS side: the returned
 * `sourceFingerprint` must equal what was actually requested, AND the
 * returned duration must be plausible relative to the sum of the REQUESTED
 * sources' own verified durations — not merely "native said ok".
 */
export async function assembleDiscoveredSources(
  lectureId: string,
  sources: RecoverySource[],
): Promise<LegacyAudioRecoveryResult> {
  if (sources.length === 0) {
    return { ok: false, error: 'No recoverable sources to assemble.' };
  }
  const orderedInput = sources.map((source) => ({ role: source.role, uri: source.uri }));
  const requestedFingerprint = computeSourceFingerprint(orderedInput);
  try {
    const result = await assembleLegacyAudio(lectureId, orderedInput);
    if (result.sourceFingerprint !== requestedFingerprint) {
      return {
        ok: false,
        error: 'The assembled audio does not correspond to the requested source set — rejected rather than trusted.',
      };
    }
    const expectedDurationMs = sources.reduce((sum, source) => sum + source.verifiedDurationMs, 0);
    const toleranceMs = Math.max(500, Math.round(expectedDurationMs * 0.02));
    if (Math.abs(result.durationMs - expectedDurationMs) > toleranceMs) {
      return {
        ok: false,
        error: `Assembled duration ${result.durationMs}ms does not match the sum of requested source durations ${expectedDurationMs}ms within a ${toleranceMs}ms tolerance.`,
      };
    }
    return { ok: true, localAudioUri: result.fileUri, durationMillis: result.durationMs };
  } catch (error) {
    const message = error instanceof LegacyAudioAssemblyError
      ? error.message
      : 'Audio assembly failed unexpectedly.';
    return { ok: false, error: message };
  }
}
