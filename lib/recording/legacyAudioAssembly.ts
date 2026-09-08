/**
 * Legacy-resume audio recovery orchestration.
 *
 * The safety guard (`audioAssemblyStatus === 'required'`, see models.ts) was
 * always correct — it never lost or overwrote a source. What was missing
 * was the operation that actually SATISFIES the guard: assembling the
 * preserved prior-canonical + resumed-segment audio into one verified file
 * so Finish Lecture can proceed. This module is that operation's JS side;
 * the actual AVFoundation composition runs natively (see
 * modules/expo-durable-recorder/ios/LegacyAudioAssembly.swift).
 */
import { assembleLegacyAudio, LegacyAudioAssemblyError, persistLegacyAudioSources } from '@/modules/expo-durable-recorder';

import type { LectureAudioSegment } from '@/lib/models';

export type LegacyAudioRecoveryResult =
  | { ok: true; localAudioUri: string; durationMillis: number }
  | { ok: false; error: string };

export type LegacyAudioPreservationResult =
  | { ok: true; sourceCount: number }
  | { ok: false; error: string };

const ROLE_ORDER: Record<string, number> = {
  prior_canonical: 0,
  resumed_segment: 1,
};

/**
 * Orders preserved segments semantically (prior canonical, then resumed),
 * never by file timestamp — `createdAt` on these records is evidence only,
 * not an ordering signal (see resumeAudioIntegrity.mjs's own manifest
 * builder, which carries the same principle). An unrecognized role sorts
 * after every known role rather than throwing, so a future third role is
 * still included (append-safe) instead of silently dropped.
 */
export function orderLegacyAudioSegments(
  segments: LectureAudioSegment[],
): LectureAudioSegment[] {
  return [...segments].sort((a, b) => {
    const left = ROLE_ORDER[a.role] ?? Number.MAX_SAFE_INTEGER;
    const right = ROLE_ORDER[b.role] ?? Number.MAX_SAFE_INTEGER;
    return left - right;
  });
}

/**
 * Copies a legacy-resume lecture's preserved segments into durable app
 * storage WITHOUT composing anything yet. Meant to be called as soon as
 * `audioAssemblyStatus` is first set to 'required' — before the user can
 * leave the recording flow — so the durable copies exist independently of
 * whatever later happens to the original expo-audio Cache/Documents files
 * (eviction, or a reinstall that rotates the app's container UUID and
 * invalidates every absolute URI persisted before it). Best-effort by
 * design: callers should not block navigation on this failing, since
 * assembleLegacyAudio's own eventual full run will retry persistence from
 * whatever sources are still resolvable at that later point anyway — this
 * call only widens the window in which sources stay recoverable, it does
 * not replace assembly-time persistence.
 */
export async function preserveLegacyAudioSourcesEarly(
  lectureId: string,
  segments: LectureAudioSegment[] | undefined,
): Promise<LegacyAudioPreservationResult> {
  const ordered = orderLegacyAudioSegments(segments ?? []);
  if (ordered.length === 0) {
    return { ok: false, error: 'No preserved audio segments were found to persist.' };
  }
  try {
    const result = await persistLegacyAudioSources(
      lectureId,
      ordered.map((segment) => ({ role: segment.role, uri: segment.uri })),
    );
    return { ok: true, sourceCount: result.sourceCount };
  } catch (error) {
    const message = error instanceof LegacyAudioAssemblyError
      ? error.message
      : 'Audio source preservation failed unexpectedly.';
    return { ok: false, error: message };
  }
}

/**
 * Runs the full native recovery pipeline for a legacy-resume lecture's
 * preserved audio segments and reports a plain success/failure result —
 * never throws, so call sites can show a retryable failure state without
 * their own try/catch boilerplate. Never mutates the lecture record itself;
 * the caller decides how to reconcile state after a success.
 */
export async function recoverLegacyAudioAssembly(
  lectureId: string,
  segments: LectureAudioSegment[] | undefined,
): Promise<LegacyAudioRecoveryResult> {
  const ordered = orderLegacyAudioSegments(segments ?? []);
  if (ordered.length === 0) {
    return { ok: false, error: 'No preserved audio segments were found to assemble.' };
  }
  try {
    const result = await assembleLegacyAudio(
      lectureId,
      ordered.map((segment) => ({ role: segment.role, uri: segment.uri })),
    );
    return { ok: true, localAudioUri: result.fileUri, durationMillis: result.durationMs };
  } catch (error) {
    const message = error instanceof LegacyAudioAssemblyError
      ? error.message
      : 'Audio assembly failed unexpectedly.';
    return { ok: false, error: message };
  }
}
