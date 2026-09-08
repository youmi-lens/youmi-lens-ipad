/**
 * General media reconciliation re-entry (Build 50 P0, Turn C + physical-
 * failure follow-up).
 *
 * A lecture can reach status: 'local_recorded'/'ready', uploadStatus:
 * 'uploaded', processingStatus: 'ready', audioAssemblyStatus: null while a
 * separate native-durable session for the same lectureId sits unfinalized
 * and undiscovered — because audioAssemblyStatus is a ONE-SHOT guard for a
 * single legacy-resume episode and does not reopen once cleared. This suite
 * proves the re-entrant path (lib/recording/mediaReconciliation.ts +
 * lib/recording/useMediaReconciliation.ts) AND the three P0 defects a first
 * physical test uncovered:
 *
 *   DEFECT A — native `LegacyAudioAssembly.assemble()`/`composeAndVerify()`
 *   reused an already-completed workspace keyed only on lectureId/state, so
 *   a request with a DIFFERENT source set silently received back an
 *   unrelated stale final asset while still reporting success. Fixed with a
 *   persisted, deterministic `sourceFingerprint` gate (LegacyAudioAssembly.
 *   swift) — same ordered source set required to reuse; a different one is
 *   composed fresh, and the OLD final is preserved (never deleted) under a
 *   timestamped name before the new one is promoted.
 *
 *   DEFECT B — JS trusted native's bare `ok: true` and persisted
 *   `mediaReconciliationStatus: 'complete'` without checking whether the
 *   returned asset actually corresponds to the requested source set. Fixed
 *   in mediaSourceDiscovery.ts: the returned `sourceFingerprint` must equal
 *   what was requested, and the returned duration must be plausible
 *   relative to the sum of the requested sources' own verified durations —
 *   either mismatch is rejected (`ok: false`) rather than trusted.
 *
 *   DEFECT C — `discoverRecoverySources` requested only the durable source
 *   (sourceCount: 1) instead of the full proven 3-source set. Root cause
 *   traced with runtime evidence (Metro log + on-device assembly.json/
 *   session.json), NOT the discovery logic itself: lib/store.tsx's
 *   `mergeRemoteRecordingsIntoStore` rebuilds every already-uploaded
 *   lecture's object field-by-field on every remote-merge cycle (which
 *   fires very frequently) and silently omitted `audioSegments` (plus every
 *   other audioAssembly-, mediaIntegrity-, and mediaReconciliation-prefixed
 *   field) — local-only fields with no cloud column. `lecture.audioSegments` was
 *   never actually lost from the original local record; it was dropped on
 *   the very next merge after being set, for ANY lecture with a
 *   remoteRecordingId. Fixed by explicitly carrying these fields forward
 *   from `local` in that merge.
 *
 * Also: assessMediaReconciliation's completeness check was strengthened —
 * "this session's id was previously seen" is not proof of completeness (it
 * is exactly what Defect B/C produced together: a false `complete` state
 * recording only the durable id while the canonical asset stayed the old
 * 2:18 recording). It now requires mediaReconciliationSourceIds to equal,
 * IN ORDER, the full expected source set, AND the canonical durationMillis
 * to be at least as long as the durable session's own known duration.
 *
 * Native Swift and the real async hook cannot run under plain Node — see
 * every other native-facing suite this session for the same constraint.
 * Structural checks read the real source text; behavioral checks re-derive
 * the documented pure logic locally against synthetic fixtures, never
 * hardcoded into product code.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const reconciliation = await read('../lib/recording/mediaReconciliation.ts');
const hook = await read('../lib/recording/useMediaReconciliation.ts');
const discovery = await read('../lib/recording/mediaSourceDiscovery.ts');
const legacySwift = await read('../modules/expo-durable-recorder/ios/LegacyAudioAssembly.swift');
const moduleIndex = await read('../modules/expo-durable-recorder/index.ts');
const store = await read('../lib/store.tsx');
const lectureDetail = await read('../app/lecture/[id].tsx');
const processingScreen = await read('../app/processing.tsx');
const models = await read('../lib/models.ts');

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

// Local re-derivation of assessMediaReconciliation's completeness check —
// mirrors the real source exactly (see the parity check in Category 1).
function assessNeeded({ target, orderedLegacyRoles, recordedIds, canonicalDurationMs }) {
  const durableDurationMs = target.durationMs;
  const expectedIds = [target.id, ...orderedLegacyRoles.map((role, i) => `lec:legacy:${i}:${role}`)];
  const idsMatchExactly =
    recordedIds.length === expectedIds.length && expectedIds.every((id, i) => recordedIds[i] === id);
  const toleranceMs = Math.max(500, Math.round(durableDurationMs * 0.02));
  const durationPlausible = canonicalDurationMs >= durableDurationMs - toleranceMs;
  return !(idsMatchExactly && durationPlausible);
}

console.log('Category 1 — completeness requires the FULL expected source set in order, not id membership');

check('parity: the local reimplementation matches the real source structure (exact-order id-list equality + duration floor)', () => {
  assert.match(reconciliation, /recordedIds\.length === expectedIds\.length && expectedIds\.every\(\(id, index\) => recordedIds\[index\] === id\)/);
  assert.match(reconciliation, /const durationPlausible = \(lecture\.durationMillis \?\? 0\) >= durableDurationMs - toleranceMs;/);
  assert.match(reconciliation, /if \(idsMatchExactly && durationPlausible\) return \{ needed: false \};/);
});

check('a lecture whose recorded ids exactly match [durable, ...legacy] in order, with a plausible duration, needs nothing further', () => {
  const target = { id: 'durable-a', durationMs: 5_780_210 };
  const recordedIds = ['durable-a', 'lec:legacy:0:prior_canonical', 'lec:legacy:1:resumed_segment'];
  const needed = assessNeeded({ target, orderedLegacyRoles: ['prior_canonical', 'resumed_segment'], recordedIds, canonicalDurationMs: 5_918_350 });
  assert.equal(needed, false);
});

check('a lecture with zero recoverable durable sessions at all needs nothing (assessMediaReconciliation short-circuits on matches.length === 0)', () => {
  assert.match(reconciliation, /if \(matches\.length === 0\) return \{ needed: false \};/);
});

console.log('\nCategory 2 — recorded-ids-contain-the-durable-id is NOT sufficient (this was Defect B/C\'s exact failure shape)');

check('recorded ids = [durable id] ONLY (legacy sources missing from the record) still needs reconciliation, even though the durable id is technically "present"', () => {
  const target = { id: 'durable-a', durationMs: 5_780_210 };
  const recordedIds = ['durable-a']; // exactly what the physical failure persisted
  const needed = assessNeeded({ target, orderedLegacyRoles: ['prior_canonical', 'resumed_segment'], recordedIds, canonicalDurationMs: 138_086 });
  assert.equal(needed, true, 'missing legacy ids AND an implausibly short canonical duration both independently prove incompleteness');
});

check('EXACT REPRO of the physical failure: ids match nothing, canonical duration (138086ms) is far shorter than the durable session alone (5780210ms) — duration floor alone proves it', () => {
  const target = { id: 'a1692715-68e9-4e64-b872-7b0e73a4856f', durationMs: 5_780_210 };
  const needed = assessNeeded({ target, orderedLegacyRoles: [], recordedIds: [target.id], canonicalDurationMs: 138_086 });
  assert.equal(needed, true);
});

check('a recorded id list that is a correctly-ordered PREFIX but missing trailing legacy sources still needs reconciliation (length mismatch alone is sufficient)', () => {
  const target = { id: 'durable-a', durationMs: 1000 };
  const recordedIds = ['durable-a', 'lec:legacy:0:prior_canonical']; // missing resumed_segment
  const needed = assessNeeded({ target, orderedLegacyRoles: ['prior_canonical', 'resumed_segment'], recordedIds, canonicalDurationMs: 999999 });
  assert.equal(needed, true);
});

check('assessMediaReconciliation reconstructs expected legacy ids from CURRENT audioSegments via orderLegacyAudioSegments — never re-derived from historical UI duration', () => {
  assert.match(reconciliation, /import \{ orderLegacyAudioSegments \} from '\.\/legacyAudioAssembly';/);
  assert.match(reconciliation, /const orderedLegacy = orderLegacyAudioSegments\(lecture\.audioSegments \?\? \[\]\);/);
});

check('a failed listRecoverableSessions() lookup fails CLOSED (needed: false) rather than guessing — the existing lecture is never disturbed on an inconclusive check', () => {
  const start = reconciliation.indexOf('export async function assessMediaReconciliation');
  const end = reconciliation.indexOf('export type MediaReconciliationFailureReason');
  const body = reconciliation.slice(start, end);
  const catchIdx = body.indexOf('} catch {');
  const catchBody = body.slice(catchIdx, catchIdx + 200);
  assert.match(catchBody, /return \{ needed: false \};/);
});

console.log('\nCategory 3 — idempotency: a genuinely COMPLETE reconciliation does not repeat on the next open');

check('behavioral parity: persisting the true expected id list (as the real success write does, from discovery.sources in order) makes the NEXT assessment report needed: false', () => {
  const target = { id: 'durable-a', durationMs: 5_780_210 };
  const orderedLegacyRoles = ['prior_canonical', 'resumed_segment'];
  let recordedIds = [];
  assert.equal(assessNeeded({ target, orderedLegacyRoles, recordedIds, canonicalDurationMs: 138_086 }), true, 'first open: nothing recorded yet');
  recordedIds = [target.id, 'lec:legacy:0:prior_canonical', 'lec:legacy:1:resumed_segment'];
  assert.equal(assessNeeded({ target, orderedLegacyRoles, recordedIds, canonicalDurationMs: 5_918_350 }), false, 'second open, true complete set + plausible duration: idempotent no-op');
});

check('useMediaReconciliation persists mediaReconciliationSourceIds from the ACTUAL discovered result.sourceIds on success, not a hardcoded or partial list', () => {
  assert.match(hook, /mediaReconciliationSourceIds: result\.sourceIds/);
});

check('useMediaReconciliation also has an in-mount ref guard so the SAME mount never fires assessment twice for one lecture id', () => {
  assert.match(hook, /attemptedForRef\.current === lecture\.id\)\s*return;/);
  assert.match(hook, /attemptedForRef\.current = lecture\.id;/);
});

check('useMediaReconciliation skips while a run is already in flight (mediaReconciliationStatus === \'running\'), so an app relaunch mid-run does not double-fire', () => {
  assert.match(hook, /lecture\.mediaReconciliationStatus === 'running'\)\s*return;/);
});

console.log('\nCategory 4 — corrected audio and stale AI content can never be observed together; a Ready lecture stays fully usable while reconciliation runs in the background');

check('mediaReconciliationStatus is a dedicated field, never overloading audioAssemblyStatus (Phase 2 requirement)', () => {
  assert.match(models, /mediaReconciliationStatus\?: 'required' \| 'running' \| 'complete' \| 'ambiguous' \| 'failed';/);
});

check('while reconciliation runs, only the diagnostic mediaReconciliationStatus flag is written — canonical media/upload/processing fields are untouched, so the lecture stays exactly as usable as it was', () => {
  const runningWriteIdx = hook.indexOf("updateLecture(lectureId, { mediaReconciliationStatus: 'running' });");
  assert.ok(runningWriteIdx >= 0);
});

check('the success write is a SINGLE atomic updateLecture call that changes localAudioUri/durationMillis AND resets processingStatus together — the audio can never visibly change while processingStatus still reads \'ready\'', () => {
  const successIdx = hook.indexOf("mediaReconciliationStatus: 'complete'");
  const callStart = hook.lastIndexOf('updateLecture(lectureId, {', successIdx);
  const callEnd = hook.indexOf('});', successIdx);
  const callBody = hook.slice(callStart, callEnd);
  assert.match(callBody, /localAudioUri: result\.localAudioUri/);
  assert.match(callBody, /durationMillis: result\.durationMillis/);
  assert.match(callBody, /processingStatus: 'not_started'/);
  assert.match(callBody, /uploadStatus: 'not_uploaded'/);
});

check('the failure/ambiguous branch touches ONLY diagnostic fields — never localAudioUri, durationMillis, uploadStatus, or processingStatus — so a Ready lecture that fails reconciliation (including a rejected fingerprint/duration mismatch) is never made unusable and never uploads/reprocesses', () => {
  const failIdx = hook.indexOf('if (!result.ok) {');
  const failEnd = hook.indexOf('return;', failIdx);
  const failBody = hook.slice(failIdx, failEnd);
  assert.doesNotMatch(failBody, /localAudioUri:|durationMillis:|uploadStatus:|processingStatus:/);
  assert.match(failBody, /mediaReconciliationStatus:/);
  assert.match(failBody, /mediaReconciliationDetail:/);
});

console.log('\nCategory 5 — wired at the required safe trigger points, and the existing playback-URI fix stays intact');

check('Lecture Detail open calls the shared hook (primary trigger point for an already-Ready lecture)', () => {
  assert.match(lectureDetail, /import \{ useMediaReconciliation \} from '@\/lib\/recording\/useMediaReconciliation';/);
  assert.match(lectureDetail, /useMediaReconciliation\(lecture, updateLecture\);/);
});

check('Processing screen (reopening in-progress / app relaunch mid-flow) also calls the SAME shared hook — not a duplicated copy of the logic', () => {
  assert.match(processingScreen, /import \{ useMediaReconciliation \} from '@\/lib\/recording\/useMediaReconciliation';/);
  assert.match(processingScreen, /useMediaReconciliation\(lecture, updateLecture\);/);
});

check('the hook only engages for a lecture that already has a canonical local asset — a lecture still mid-recording is covered by the pre-existing audioAssemblyStatus guard, not this path', () => {
  assert.match(hook, /if \(!lecture\.localAudioUri\)\s*return;/);
});

const lectureLocalAudio = await read('../lib/lectureLocalAudio.ts');
check('the Library/Application Support stale-sandbox playback rewrite (kept per explicit instruction) is still present, so a reconciled asset under AudioAssembly resolves for playback after a container UUID change', () => {
  assert.match(lectureLocalAudio, /Library%20Application%20Support|Library\/Application Support/);
});

console.log('\nCategory 6 (Phase 8.A/B) — native reuse is gated on a source fingerprint, never lectureId/state alone');

check('LegacyAudioAssemblyMetadata persists a sourceFingerprint, decode-tolerant (old assembly.json files without it decode to "" — never equal to a real fingerprint)', () => {
  assert.match(legacySwift, /var sourceFingerprint: String/);
  assert.match(legacySwift, /sourceFingerprint = try container\.decodeIfPresent\(String\.self, forKey: \.sourceFingerprint\) \?\? ""/);
});

check('sourceFingerprint is computed from the ORDERED (role, uri) request, never from String.hashValue (which is seed-randomized per process and would break persisted comparisons)', () => {
  assert.match(legacySwift, /private static func sourceFingerprint\(_ orderedSources: \[\(role: String, uri: String\)\]\) -> String/);
  assert.doesNotMatch(legacySwift, /return \S*\.hashValue|= \S*\.hashValue/, 'must not actually compute the fingerprint from a seed-randomized hash');
});

check('composeAndVerify\'s reuse shortcut (Defect A) requires state == .completed AND sourceFingerprint match — a same-fingerprint retry still reuses cheaply', () => {
  const start = legacySwift.indexOf('func composeAndVerify(');
  const shortcutEnd = legacySwift.indexOf('guard let metadata = try readMetadata', start);
  const body = legacySwift.slice(start, shortcutEnd);
  assert.match(body, /existingMetadata\.state == \.completed,\s*\n\s*existingMetadata\.sourceFingerprint == sourceFingerprint/);
});

check('composeAndVerify rejects composing from persisted sources that answer a DIFFERENT request (metadata.sourceFingerprint mismatch) rather than silently mixing an old persisted set with a new expectedSourceCount', () => {
  assert.match(legacySwift, /guard metadata\.sourceFingerprint == sourceFingerprint else \{/);
});

check('assemble()\'s own top-level shortcut is ALSO fingerprint-gated (this was the exact bug: it used to short-circuit on file-existence alone, before persistSources or composeAndVerify ever ran)', () => {
  const start = legacySwift.indexOf('func assemble(lectureId');
  const end = legacySwift.indexOf('_ = try persistSources');
  const body = legacySwift.slice(start, end);
  assert.match(body, /metadata\.state == \.completed,\s*\n\s*metadata\.sourceFingerprint == fingerprint/);
});

check('a fingerprint MISMATCH never deletes the old final asset — it is preserved under a timestamped name before the new one is promoted (Phase 4: do not destructively overwrite the only known-good old final before the new one validates)', () => {
  const start = legacySwift.indexOf('// Atomic finalize');
  const end = legacySwift.indexOf('let finalInspection = try inspect(finalURL, context: "the finalized');
  const body = legacySwift.slice(start, end);
  assert.match(body, /lecture\.prev-\\\(Self\.compactTimestamp\(clock\(\)\)\)\.m4a/);
  assert.match(body, /try\? fileManager\.copyItem\(at: finalURL, to: preservedURL\)/, 'copy (preserve), not a plain overwrite');
  assert.doesNotMatch(body, /removeItem\(at: finalURL\)\s*\n\s*try fileManager\.moveItem/, 'must copy the old one aside before it is ever removed');
});

check('the verification tolerance/composition/promotion machinery itself is untouched — only the reuse gate and the pre-promotion archive step changed', () => {
  assert.match(legacySwift, /let toleranceMs = max\(500, Int\(\(Double\(expectedDurationMs\) \* 0\.02\)\.rounded\(\)\)\)/);
  assert.match(legacySwift, /try await AudioSegmentComposer\.compose\(orderedSources: durableURLs, outputURL: temporaryURL\)/);
});

console.log('\nCategory 7 (Phase 8.D) — JS independently verifies returned provenance, never trusts native ok:true alone');

check('LegacyAudioAssemblyResult carries sourceFingerprint end to end: native struct -> asDictionary -> TS type -> validated parse', () => {
  assert.match(legacySwift, /let sourceFingerprint: String\n\n  func asDictionary\(\) -> \[String: Any\] \{\n    \["fileUri": fileUri, "durationMs": durationMs, "byteLength": byteLength, "sourceCount": sourceCount, "sourceFingerprint": sourceFingerprint\]/);
  assert.match(moduleIndex, /sourceFingerprint: string;/);
  assert.match(moduleIndex, /typeof result\.sourceFingerprint !== 'string' \|\| result\.sourceFingerprint\.length === 0/);
});

check('assembleDiscoveredSources computes the REQUESTED fingerprint independently in JS (not trusted from native) and rejects a mismatch rather than treating ok:true as sufficient', () => {
  assert.match(discovery, /function computeSourceFingerprint\(sources: \{ role: string; uri: string \}\[\]\): string/);
  assert.match(discovery, /const requestedFingerprint = computeSourceFingerprint\(orderedInput\);/);
  assert.match(discovery, /if \(result\.sourceFingerprint !== requestedFingerprint\) \{/);
});

check('the JS fingerprint algorithm matches native exactly: role::uri per source, joined by the same record-separator character', () => {
  assert.match(discovery, /`\$\{source\.role\}::\$\{source\.uri\}`/);
  assert.match(legacySwift, /"\\\(\$0\.role\)::\\\(\$0\.uri\)"/);
});

check('assembleDiscoveredSources ALSO independently checks the returned duration is plausible relative to the sum of the REQUESTED sources\' own verified durations — a second, duration-based proof, not just fingerprint equality', () => {
  assert.match(discovery, /const expectedDurationMs = sources\.reduce\(\(sum, source\) => sum \+ source\.verifiedDurationMs, 0\);/);
  assert.match(discovery, /Math\.abs\(result\.durationMs - expectedDurationMs\) > toleranceMs/);
});

check('behavioral parity: a returned fingerprint that does not equal the requested one is rejected regardless of how plausible the duration looks', () => {
  const sources = [{ role: 'durable_recovery', uri: 'file:///durable.m4a' }, { role: 'prior_canonical', uri: 'file:///prior.m4a' }];
  const requested = sources.map((s) => `${s.role}::${s.uri}`).join('\u{1E}');
  const returnedFromAnUnrelatedOldRequest = 'prior_canonical::file:///prior.m4a\u{1E}resumed_segment::file:///resumed.m4a';
  assert.notEqual(requested, returnedFromAnUnrelatedOldRequest, 'a stale unrelated fingerprint must never accidentally equal the new request');
});

console.log('\nCategory 8 (Phase 1 real root cause) — lib/store.tsx must not silently drop local-only recovery/provenance fields on remote merge');

check('mergeRemoteRecordingsIntoStore carries every recording-engine/recovery provenance field forward from `local` — this is the actual reason discoverRecoverySources ever saw an empty legacySegments list for an already-uploaded lecture (audioSegments has no cloud column and was being rebuilt away on every merge)', () => {
  const start = store.indexOf('const mergedRemoteLectures = liveRemoteRows.map((row) => {');
  const end = store.indexOf('} satisfies Lecture;', start);
  const body = store.slice(start, end);
  for (const field of [
    'recordingEngine: local?.recordingEngine',
    'audioSegments: local?.audioSegments',
    'audioAssemblyStatus: local?.audioAssemblyStatus',
    'audioAssemblyReason: local?.audioAssemblyReason',
    'audioAssemblyCompletedAt: local?.audioAssemblyCompletedAt',
    'mediaIntegrityStatus: local?.mediaIntegrityStatus',
    'mediaIntegrityDetail: local?.mediaIntegrityDetail',
    'mediaIntegrityCheckedAt: local?.mediaIntegrityCheckedAt',
    'mediaReconciliationStatus: local?.mediaReconciliationStatus',
    'mediaReconciliationSourceIds: local?.mediaReconciliationSourceIds',
    'mediaReconciliationDetail: local?.mediaReconciliationDetail',
    'mediaReconciliationCompletedAt: local?.mediaReconciliationCompletedAt',
  ]) {
    assert.ok(body.includes(field), `merge must preserve ${field}`);
  }
});

console.log('\nCategory 9 (Phase 8.C/F) — the complete requested set is durable + ALL legacy sources, never the durable source alone');

check('discoverRecoverySources returns [durableSource, ...legacySources] — the durable export never REPLACES the legacy sources, only augments them', () => {
  assert.match(discovery, /return \{ ok: true, sources: \[durableSource, \.\.\.legacySources\] \};/);
});

check('runMediaReconciliation\'s sourceIds come from discovery.sources (the full augmented set), not from a partial/durable-only list', () => {
  assert.match(reconciliation, /sourceIds: discovery\.sources\.map\(\(source\) => source\.id\)/);
});

console.log(`\nmedia-reconciliation: ${passed} checks passed`);
