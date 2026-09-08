import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  LEGACY_RESUME_ASSEMBLY_REQUIRED,
  buildLegacyResumeSegmentManifest,
  planLegacyResumeFinalization,
  requiresAudioAssembly,
} from '../lib/recording/resumeAudioIntegrity.mjs';
import { getLectureRecoveryState, nextProcessingAction } from '../lib/processingResume.mjs';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const base = {
  id: 'lecture-1', status: 'local_recorded', remoteRecordingId: 'remote-1',
  localAudioUri: 'file:///documents/lecture-1.m4a', uploadStatus: 'not_uploaded', processingStatus: 'not_started',
};

console.log('Resumed recording data integrity');

check('CASE 1: uninterrupted recording remains eligible for its one canonical upload', () => {
  assert.equal(nextProcessingAction(base), 'upload');
  assert.equal(requiresAudioAssembly(base), false);
});

check('CASE 2: resumed legacy recording retains prior then new segment in deterministic order', () => {
  const plan = planLegacyResumeFinalization({
    priorCanonicalUri: 'file:///documents/lecture-1.m4a',
    resumedSegmentUri: 'file:///documents/lecture-1/segments/resume-2.m4a',
    now: '2026-09-04T18:12:32.000Z',
  });
  assert.equal(plan.kind, 'assembly_required');
  assert.equal(plan.canonicalUri, 'file:///documents/lecture-1.m4a');
  assert.deepEqual(plan.segments.map((segment) => segment.uri), [
    'file:///documents/lecture-1.m4a',
    'file:///documents/lecture-1/segments/resume-2.m4a',
  ]);
});

check('CASE 3: an invalid/failing assembly plan does not nominate a replacement canonical audio URI', () => {
  const plan = planLegacyResumeFinalization({ priorCanonicalUri: 'file:///documents/lecture-1.m4a' });
  assert.deepEqual(plan, { kind: 'invalid', reason: 'missing_preserved_audio' });
});

check('CASE 4: retry cannot upload either stale canonical or latest segment while assembly is required', () => {
  const blocked = { ...base, audioAssemblyStatus: 'required', uploadStatus: 'upload_failed' };
  assert.equal(nextProcessingAction(blocked), 'none');
  assert.deepEqual(getLectureRecoveryState(blocked), { kind: 'none', plan: null });
});

check('CASE 5: segment manifest uses actual source identity, not corrupted logical-duration metadata', () => {
  const manifest = buildLegacyResumeSegmentManifest({
    existingSegments: [{ uri: 'file:///documents/lecture-1.m4a', role: 'prior_canonical', createdAt: 'a' }],
    priorCanonicalUri: 'file:///documents/lecture-1.m4a',
    resumedSegmentUri: 'file:///documents/lecture-1/segments/resume-2.m4a',
    now: 'b',
  });
  assert.equal(manifest.length, 2);
  assert.equal(JSON.stringify(manifest).includes('4520'), false);
});

check('CASE 6: Finish explicitly preserves the new segment and never routes it through canonical replacement', () => {
  const screen = readFileSync(new URL('../app/recording.tsx', import.meta.url), 'utf8');
  const finishStart = screen.indexOf('const existing = getLecture(pendingLectureId);');
  const guard = screen.slice(
    screen.indexOf('if (legacyResumeHasPriorAudio && uri)', finishStart),
    screen.indexOf('const rawFinalAudio = uri', finishStart),
  );
  assert.match(guard, /persistLectureResumeSegment\(uri, pendingLectureId\)/);
  assert.match(guard, /audioAssemblyStatus: 'required'/);
  assert.match(guard, /localAudioUri: plan\.canonicalUri/);
  assert.doesNotMatch(guard, /persistLectureLocalAudio\(uri, pendingLectureId\)/);
});

assert.equal(LEGACY_RESUME_ASSEMBLY_REQUIRED, 'legacy_resume_assembly_required');
console.log(`\nresumed-recording-data-integrity: ${passed} checks passed`);
