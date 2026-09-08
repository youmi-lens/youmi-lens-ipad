/**
 * Legacy recorder resume integrity policy.
 *
 * `expo-audio` produces a new file after a recovered recording screen is
 * reopened. It cannot append that file to the previous asset. Until a native
 * composition path can validate an assembled asset, the two inputs must remain
 * separate and must never enter the upload pipeline as a falsely-complete
 * lecture.
 */

export const LEGACY_RESUME_ASSEMBLY_REQUIRED = 'legacy_resume_assembly_required';

function validUri(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function requiresAudioAssembly(lecture) {
  return lecture?.audioAssemblyStatus === 'required';
}

/**
 * Builds a deterministic, de-duplicated manifest in chronological order.
 * Durations are evidence only; they are not an expected-total target.
 */
export function buildLegacyResumeSegmentManifest(input = {}) {
  const existing = Array.isArray(input.existingSegments) ? input.existingSegments : [];
  const result = [];
  const seen = new Set();
  const add = (segment) => {
    if (!segment || !validUri(segment.uri) || seen.has(segment.uri)) return;
    seen.add(segment.uri);
    result.push(segment);
  };

  for (const segment of existing) add(segment);
  add({
    uri: input.priorCanonicalUri,
    role: 'prior_canonical',
    createdAt: input.priorCreatedAt ?? input.now,
  });
  add({
    uri: input.resumedSegmentUri,
    role: 'resumed_segment',
    createdAt: input.now,
  });
  return result;
}

/**
 * The only safe legacy-resume Finish plan is preservation, never replacement.
 */
export function planLegacyResumeFinalization(input = {}) {
  const priorCanonicalUri = validUri(input.priorCanonicalUri) ? input.priorCanonicalUri : null;
  const resumedSegmentUri = validUri(input.resumedSegmentUri) ? input.resumedSegmentUri : null;
  if (!priorCanonicalUri || !resumedSegmentUri) {
    return { kind: 'invalid', reason: 'missing_preserved_audio' };
  }
  return {
    kind: 'assembly_required',
    canonicalUri: priorCanonicalUri,
    segments: buildLegacyResumeSegmentManifest({
      existingSegments: input.existingSegments,
      priorCanonicalUri,
      resumedSegmentUri,
      priorCreatedAt: input.priorCreatedAt,
      now: input.now,
    }),
    reason: LEGACY_RESUME_ASSEMBLY_REQUIRED,
  };
}
