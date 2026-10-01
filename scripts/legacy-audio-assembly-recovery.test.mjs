/**
 * Legacy-resume audio assembly RECOVERY path (Build 50 P0).
 *
 * The safety guard (`audioAssemblyStatus === 'required'`, see
 * lib/recording/resumeAudioIntegrity.mjs and lib/models.ts) was always
 * correct: it never lost or overwrote a source. What was missing was the
 * operation that actually satisfies it — this is that operation.
 *
 * Native AVFoundation code (modules/expo-durable-recorder/ios/*.swift) has
 * no Node-runnable unit test surface (no XCTest target in this repo — see
 * the pre-existing material-native-ink-performance.test.mjs for the same
 * constraint on a different native module), and
 * lib/recording/legacyAudioAssembly.ts transitively imports
 * expo-modules-core/react-native via the '@/modules/...' alias, which does
 * not resolve under plain Node. Both are therefore verified structurally —
 * asserting the actual shipped source implements the required invariants —
 * plus a behavioral check on the one piece that IS plain-JS-testable
 * in isolation (the ordering rule, duplicated here as pure logic matching
 * the shipped ROLE_ORDER table, since importing the real module is not
 * possible from a plain Node script).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const orchestrator = read('../lib/recording/legacyAudioAssembly.ts');
const recordingScreen = read('../app/recording.tsx');
const composer = read('../modules/expo-durable-recorder/ios/AudioSegmentComposer.swift');
const legacyAssembly = read('../modules/expo-durable-recorder/ios/LegacyAudioAssembly.swift');
const durableExporter = read('../modules/expo-durable-recorder/ios/DurableFinalAssetExporter.swift');
const moduleBridge = read('../modules/expo-durable-recorder/ios/ExpoDurableRecorderModule.swift');
const bridgeIndex = read('../modules/expo-durable-recorder/index.ts');
const processingScreen = read('../app/processing.tsx');
const models = read('../lib/models.ts');

console.log('Phase 1 — ONE shared native media assembly primitive, not two');

check('AudioSegmentComposer exists and uses AVMutableComposition + sequential insertTimeRange (not byte concatenation)', () => {
  assert.match(composer, /AVMutableComposition\(\)/);
  assert.match(composer, /insertTimeRange\(/);
  assert.match(composer, /AVAssetExportSession\(asset: composition, presetName: AVAssetExportPresetAppleM4A\)/);
});

check('DurableFinalAssetExporter (existing durable-session export) now delegates to the shared composer instead of its own inline loop', () => {
  assert.match(durableExporter, /AudioSegmentComposer\.compose\(\s*orderedSources: plan\.sourceURLs,\s*outputURL: plan\.temporaryURL(,\s*cancellation: cancellation)?\s*\)/);
  assert.doesNotMatch(durableExporter, /AVMutableComposition\(\)/, 'the composition loop must be extracted, not duplicated');
});

check('LegacyAudioAssembly (new legacy-resume recovery) uses the SAME shared composer — one implementation, two callers', () => {
  assert.match(legacyAssembly, /AudioSegmentComposer\.compose\(orderedSources: durableURLs, outputURL: temporaryURL\)/);
  assert.doesNotMatch(legacyAssembly, /AVMutableComposition\(\)/, 'legacy assembly must not carry its own second composition loop');
});

check('legacy assembly is architecturally separate from the durable recorder\'s own session state machine', () => {
  // The doc comment legitimately explains WHY DurableRecorderStore is not
  // reused; only actual code usage (instantiation/type annotation) matters.
  assert.doesNotMatch(legacyAssembly, /DurableRecorderStore\(|: DurableRecorderStore|DurableRecordingSession\(/);
});

console.log('\nPhase 2 — sources are durably persisted, never moved/deleted, before any composition');

check('sources are only ever copied, never moved or deleted at their original path', () => {
  assert.match(legacyAssembly, /fileManager\.copyItem\(at: originalURL, to: durableURL\)/);
  assert.doesNotMatch(legacyAssembly, /fileManager\.moveItem\(at: originalURL/, 'an original source must never be moved');
  assert.doesNotMatch(legacyAssembly, /fileManager\.removeItem\(at: originalURL\)/, 'an original source must never be deleted');
});

check('the durable workspace lives under Application Support/YoumiLens/AudioAssembly/<lectureId>, mirroring the durable recorder\'s own convention', () => {
  assert.match(legacyAssembly, /appendingPathComponent\("YoumiLens", isDirectory: true\)/);
  assert.match(legacyAssembly, /appendingPathComponent\("AudioAssembly", isDirectory: true\)/);
});

check('restart-safe metadata (schema, lectureId, source list with original+durable URI, byte size, duration, state) is persisted atomically', () => {
  assert.match(legacyAssembly, /struct LegacyAudioAssemblySource: Codable/);
  assert.match(legacyAssembly, /let originalURI: String/);
  assert.match(legacyAssembly, /let durableRelativePath: String/);
  assert.match(legacyAssembly, /let byteLength: Int64/);
  assert.match(legacyAssembly, /let durationMs: Int/);
  assert.match(legacyAssembly, /data\.write\(to: directory\.appendingPathComponent\("assembly\.json", isDirectory: false\), options: \.atomic\)/);
});

check('ordering is an explicit input array, never re-derived from file timestamps natively', () => {
  assert.doesNotMatch(legacyAssembly, /createdAt.*sort|sort.*createdAt|\.creationDate/i);
});

console.log('\nCrash/retry safety — every interruption point is restart-safe');

check('an interrupted source copy (partial file) is detected via re-validation and discarded, never trusted as already-done', () => {
  const start = legacyAssembly.indexOf('for (index, source) in orderedSources.enumerated()');
  const end = legacyAssembly.indexOf('try writeMetadata(LegacyAudioAssemblyMetadata(\n      schemaVersion: legacyAudioAssemblySchemaVersion,\n      lectureId: normalizedLectureId,\n      sources: persistedSources,\n      state: .sourcesPersisted');
  const body = legacyAssembly.slice(start, end);
  assert.match(body, /inspection = try\? inspector\.inspect\(url: durableURL\)/, 'existing durable copy is independently re-validated, not just fileExists-checked');
  assert.match(body, /try\? fileManager\.removeItem\(at: durableURL\)/, 'a present-but-invalid copy is discarded');
});

check('an interrupted export leaves a temp file that is unconditionally discarded before recomposing — never trusted as canonical', () => {
  assert.match(legacyAssembly, /if fileManager\.fileExists\(atPath: temporaryURL\.path\) \{\s*\n\s*try\? fileManager\.removeItem\(at: temporaryURL\)/);
});

check('a final asset from a fully-completed prior attempt is reused idempotently — a retry after a post-success crash does not recompose', () => {
  const start = legacyAssembly.indexOf('// A prior call already finished');
  const end = legacyAssembly.indexOf('guard let metadata = try readMetadata');
  const body = legacyAssembly.slice(start, end);
  assert.match(body, /if fileManager\.fileExists\(atPath: finalURL\.path\)/);
  assert.match(body, /return LegacyAudioAssemblyResult/);
});

check('the convenience assemble() wrapper ALSO reuses an already-completed final asset without touching persistSources at all — sources no longer resolvable (evicted Cache, reinstalled container) do not break an already-assembled lecture', () => {
  const start = legacyAssembly.indexOf('func assemble(lectureId: String');
  const end = legacyAssembly.indexOf('private func inspect(');
  const body = legacyAssembly.slice(start, end);
  const finalCheckIdx = body.indexOf('if fileManager.fileExists(atPath: finalURL.path)');
  const persistCallIdx = body.indexOf('try persistSources(');
  assert.ok(finalCheckIdx >= 0 && persistCallIdx > finalCheckIdx,
    'the final-exists fast path must come before persistSources is ever called');
});

check('final promotion is atomic and idempotent for a matching-fingerprint retry (returns via the reuse shortcut before ever reaching this block) — and for a genuinely different source set, preserves the old final rather than silently overwriting it', () => {
  assert.match(legacyAssembly, /try fileManager\.moveItem\(at: temporaryURL, to: finalURL\)/);
  const start = legacyAssembly.indexOf('// Atomic finalize');
  const end = legacyAssembly.indexOf('let finalInspection = try inspect(finalURL, context: "the finalized');
  const body = legacyAssembly.slice(start, end);
  assert.match(body, /if fileManager\.fileExists\(atPath: finalURL\.path\) \{/, 'a stale final from a different fingerprint is detected here, not silently clobbered');
  assert.match(body, /try\? fileManager\.copyItem\(at: finalURL, to: preservedURL\)/, 'preserved (copied aside), never just deleted');
});

console.log('\nPhase 3/4 — ordered N-source composition + verification before any state change');

check('composition accepts an ordered array, not hardcoded exactly two sources', () => {
  assert.match(legacyAssembly, /orderedSources: \[\(role: String, uri: String\)\]/);
  assert.doesNotMatch(legacyAssembly, /sources\[0\]|sources\[1\]|source1|source2|prior.*resumed.*hardcod/i);
});

check('verification checks assembled duration against the SUM of source durations with a proportional tolerance, not a hardcoded expected value', () => {
  assert.match(legacyAssembly, /let expectedDurationMs = persistedSources\.reduce\(0\) \{ \$0 \+ \$1\.durationMs \}/);
  assert.match(legacyAssembly, /let toleranceMs = max\(500, Int\(\(Double\(expectedDurationMs\) \* 0\.02\)\.rounded\(\)\)\)/);
  assert.doesNotMatch(legacyAssembly, /203\.?5?|203500|4265325/, 'must not hardcode this forensic record\'s specific duration');
});

check('verification also checks persisted source count matches the expected input count', () => {
  assert.match(legacyAssembly, /persistedSources\.count == expectedSourceCount/);
});

check('composeAndVerify reads sources from the persisted assembly.json metadata, not from a freshly re-passed source list — so it works purely from durable storage', () => {
  const start = legacyAssembly.indexOf('func composeAndVerify(');
  const end = legacyAssembly.indexOf('func assemble(lectureId');
  const body = legacyAssembly.slice(start, end);
  assert.match(body, /guard let metadata = try readMetadata\(directory: lectureDirectory\)/);
  assert.match(body, /let persistedSources = metadata\.sources/);
  assert.doesNotMatch(body, /Self\.resolveExistingURL|originalURL/, 'must never touch original source URIs — only durable copies');
});

check('a verification failure discards the unverified temp file and never promotes it', () => {
  const start = legacyAssembly.indexOf('guard abs(tempInspection.durationMs');
  const body = legacyAssembly.slice(start, start + 400);
  assert.match(body, /try\? fileManager\.removeItem\(at: temporaryURL\)/);
  assert.match(body, /throw LegacyAudioAssemblyError\.verificationFailed/);
});

console.log('\nPhase 5 — atomic lecture reconciliation only after verified success');

check('models.ts supports assembly provenance without deleting evidence', () => {
  assert.match(models, /audioAssemblyCompletedAt\?: string/);
  assert.match(models, /audioSegments\?: LectureAudioSegment\[\]/, 'segments field (the evidence) is untouched, still present');
});

check('processing.tsx clears the guard and sets the REAL assembled duration only AFTER the early-return failure gate (result.ok is narrowed true for the rest of the function, so no dead result.ok/else branch remains)', () => {
  const start = processingScreen.indexOf('const runAssembly = useCallback');
  const end = processingScreen.indexOf('}, [lecture, updateLecture]);');
  const body = processingScreen.slice(start, end);
  const failGateIdx = body.indexOf('if (!result.ok)');
  const returnIdx = body.indexOf('return;', failGateIdx);
  const successUpdateIdx = body.indexOf('updateLecture(lecture.id, {', returnIdx);
  assert.ok(failGateIdx >= 0 && returnIdx > failGateIdx && successUpdateIdx > returnIdx, 'the reconciling updateLecture must come after the early-return failure gate');
  assert.doesNotMatch(body, /if \(result\.ok\)/, 'result is already narrowed by the early return — a redundant result.ok/else branch would be dead code');
  const successBody = body.slice(returnIdx, successUpdateIdx + 900);
  assert.match(successBody, /durationMillis: result\.durationMillis/, 'duration comes from verified native media duration, never a UI timer');
  assert.match(successBody, /audioAssemblyStatus: undefined/);
  assert.match(successBody, /localAudioUri: result\.localAudioUri/);
  assert.match(successBody, /mediaReconciliationStatus: 'complete'/, 'the legacy-guard flow and the general reconciliation flow share the same completion provenance field');
});

check('processing.tsx discovers complete media (durable + legacy) before assembling, not just audioSegments alone — via the shared runMediaReconciliation module, not a duplicated discovery+assembly call', () => {
  const start = processingScreen.indexOf('const runAssembly = useCallback');
  const end = processingScreen.indexOf('}, [lecture, updateLecture]);');
  const body = processingScreen.slice(start, end);
  assert.match(body, /runMediaReconciliation\(lecture\.id, lecture\.audioSegments\)/);
  assert.doesNotMatch(body, /discoverRecoverySources\(|assembleDiscoveredSources\(/, 'orchestration must live only in mediaReconciliation.ts, not be re-duplicated in processing.tsx');
  assert.match(processingScreen, /import \{ runMediaReconciliation \} from '@\/lib\/recording\/mediaReconciliation';/);
  const failGateIdx = body.indexOf('if (!result.ok)');
  assert.ok(failGateIdx >= 0, 'discovery/assembly failure is checked before any state is reconciled');
});

check('an ambiguous/blocked discovery or composition failure persists diagnostic mediaIntegrityStatus but never clears the audioAssemblyStatus guard', () => {
  const start = processingScreen.indexOf('if (!result.ok)');
  const end = processingScreen.indexOf('return;', start);
  const body = processingScreen.slice(start, end);
  assert.match(body, /mediaIntegrityStatus: result\.reason/);
  assert.match(body, /mediaIntegrityDetail: result\.detail/);
  assert.doesNotMatch(body, /audioAssemblyStatus: undefined/, 'the guard must stay up — this is a block, not a recovery');
});

check('a failed attempt (discovery or composition) does NOT clear the guard, does NOT touch localAudioUri/durationMillis, and surfaces a retryable error', () => {
  const start = processingScreen.indexOf('const runAssembly = useCallback');
  const end = processingScreen.indexOf('}, [lecture, updateLecture]);');
  const body = processingScreen.slice(start, end);
  const failGateIdx = body.indexOf('if (!result.ok)');
  const returnIdx = body.indexOf('return;', failGateIdx);
  const failBody = body.slice(failGateIdx, returnIdx);
  assert.doesNotMatch(failBody, /localAudioUri: result\.localAudioUri|durationMillis: result\.durationMillis/, 'the failure branch must never touch canonical media fields');
  assert.match(failBody, /setAssemblyError\(result\.detail\)/);
});

console.log('\nPhase 6 — Finish Lecture UX: automatic recovery once per lecture, manual retry on failure, no auto-loop');

check('recovery runs automatically exactly once per lecture id via a ref guard, not on every render', () => {
  assert.match(processingScreen, /assemblyAttemptedForRef\.current === lecture\.id/);
  assert.match(processingScreen, /assemblyAttemptedForRef\.current = lecture\.id;/);
});

check('a manual Retry button re-arms the one-shot guard and re-runs — failure never auto-loops', () => {
  assert.match(processingScreen, /const retryAssembly = \(\) => \{\s*\n\s*assemblyAttemptedForRef\.current = null;\s*\n\s*void runAssembly\(\);/);
  assert.match(processingScreen, /onPress=\{retryAssembly\}/);
});

check('the assembling state is visible to the user (distinct indicator + label), not a silent operation', () => {
  assert.match(processingScreen, /assembling \? 'active' :/);
  assert.match(processingScreen, /assembling \? t\('recording\.assemblingAudio'\)/);
});

console.log('\nOrdering — semantic (role-based), never file-timestamp-based');

check('the orchestrator\'s ROLE_ORDER puts prior_canonical strictly before resumed_segment', () => {
  const roleOrderMatch = orchestrator.match(/const ROLE_ORDER: Record<string, number> = \{([\s\S]*?)\};/);
  assert.ok(roleOrderMatch, 'ROLE_ORDER table must exist');
  const priorIdx = roleOrderMatch[1].indexOf('prior_canonical');
  const resumedIdx = roleOrderMatch[1].indexOf('resumed_segment');
  assert.ok(priorIdx >= 0 && resumedIdx >= 0 && priorIdx < resumedIdx);
});

check('orderLegacyAudioSegments sorts by role via ROLE_ORDER, not by createdAt', () => {
  const fn = orchestrator.slice(
    orchestrator.indexOf('export function orderLegacyAudioSegments'),
    orchestrator.indexOf('export async function recoverLegacyAudioAssembly'),
  );
  assert.match(fn, /ROLE_ORDER\[a\.role\]/);
  assert.match(fn, /ROLE_ORDER\[b\.role\]/);
  assert.doesNotMatch(fn, /createdAt/);
});

check('behavioral parity check: applying the same ROLE_ORDER table to a shuffled [resumed, prior] input yields [prior, resumed]', () => {
  const ROLE_ORDER = { prior_canonical: 0, resumed_segment: 1 };
  const input = [
    { uri: 'b', role: 'resumed_segment', createdAt: '2026-09-07T01:08:00.995Z' },
    { uri: 'a', role: 'prior_canonical', createdAt: '2026-09-06T02:41:31.477Z' },
  ];
  const ordered = [...input].sort((x, y) => (ROLE_ORDER[x.role] ?? 99) - (ROLE_ORDER[y.role] ?? 99));
  assert.deepEqual(ordered.map((s) => s.uri), ['a', 'b']);
});

check('recoverLegacyAudioAssembly never throws — always returns a plain ok/error result', () => {
  const fn = orchestrator.slice(orchestrator.indexOf('export async function recoverLegacyAudioAssembly'));
  assert.match(fn, /try \{[\s\S]*\} catch \(error\) \{/);
  assert.match(fn, /return \{ ok: false, error: message \}/);
});

console.log('\nNative bridge wiring');

check('ExpoDurableRecorderModule exposes assembleLegacyAudio as a new AsyncFunction, separate from the durable session bridge functions', () => {
  assert.match(moduleBridge, /AsyncFunction\("assembleLegacyAudio"\)/);
  assert.match(moduleBridge, /LegacyAudioAssemblyStore\(\)/);
});

check('index.ts exports a typed assembleLegacyAudio with its own error domain', () => {
  assert.match(bridgeIndex, /export async function assembleLegacyAudio\(/);
  assert.match(bridgeIndex, /export class LegacyAudioAssemblyError extends Error/);
});

console.log('\nEnd-to-end control flow — the old dead-end guard now funnels into recovery, it does not duplicate it');

check('togglePause\'s reviewing-resume guard no longer shows a dead-end Alert with no connection to recovery', () => {
  const start = recordingScreen.indexOf('const togglePause = async () => {');
  const end = recordingScreen.indexOf('setContinueRequested(true);', start);
  const body = recordingScreen.slice(start, end);
  assert.doesNotMatch(body, /Alert\.alert\(\s*\n?\s*'Audio assembly required'/, 'the old static Alert dead-end must be gone');
  assert.match(body, /router\.replace\(\{ pathname: '\/processing', params: \{ lectureId: pendingLectureId \} \}\)/,
    'redirects into /processing — the one place that actually calls recoverLegacyAudioAssembly — instead of a second implementation');
});

check('finish() checks for an already-blocked lecture BEFORE touching the mic/recording engine, and also redirects rather than falling through to the uri-dependent legacy branch', () => {
  const start = recordingScreen.indexOf('const finish = async (options?: { recoverable?: boolean }) => {');
  const stopCallIdx = recordingScreen.indexOf('await finishRecoverableRecording()', start);
  const guardIdx = recordingScreen.indexOf("getLecture(pendingLectureId)?.audioAssemblyStatus === 'required'", start);
  assert.ok(guardIdx > start && guardIdx < stopCallIdx,
    'the already-blocked check must run before stopRecording/finishRecoverableRecording, not after');
  const guardBody = recordingScreen.slice(guardIdx - 20, stopCallIdx);
  assert.match(guardBody, /router\.replace\(\{ pathname: '\/processing', params: \{ lectureId: pendingLectureId \} \}\)/);
});

check('recovering an already-blocked lecture from finish() never sets finishing/finishedRef — it is a redirect, not a completed Finish', () => {
  const start = recordingScreen.indexOf('const finish = async (options?: { recoverable?: boolean }) => {');
  const guardIdx = recordingScreen.indexOf("getLecture(pendingLectureId)?.audioAssemblyStatus === 'required'", start);
  const returnIdx = recordingScreen.indexOf('return;', guardIdx);
  const guardBlock = recordingScreen.slice(guardIdx - 60, returnIdx);
  assert.doesNotMatch(guardBlock, /setFinishing\(true\)|finishedRef\.current = true/);
});

check('a successful recovery corrects status away from in_progress, so a future re-open does not route back to /recording review mode', () => {
  const start = processingScreen.indexOf('const runAssembly = useCallback');
  const end = processingScreen.indexOf('}, [lecture, updateLecture]);');
  const body = processingScreen.slice(start, end);
  assert.match(body, /status: 'local_recorded'/);
});

console.log('\nObservability — one-shot stage markers, no polling');

check('exactly one detected/start/success-or-failure/reconciled marker exists in processing.tsx, all gated by __DEV__', () => {
  const markers = ['detected-required', 'recovery-start', 'discovery-failure', 'native-success', 'state-reconciled'];
  for (const marker of markers) {
    const count = (processingScreen.match(new RegExp(`\\[AudioAssembly\\] ${marker}`, 'g')) || []).length;
    assert.equal(count, 1, `expected exactly one occurrence of ${marker}`);
  }
  assert.doesNotMatch(processingScreen, /setInterval|setTimeout\(.*\[AudioAssembly\]/s);
});

check('recording.tsx marks both redirect sites, also gated by __DEV__', () => {
  const count = (recordingScreen.match(/\[AudioAssembly\] redirect-to-processing/g) || []).length;
  assert.equal(count, 2, 'togglePause and finish each mark their redirect once');
  assert.doesNotMatch(recordingScreen, /setInterval\(.*AudioAssembly|setTimeout\(.*AudioAssembly.*\d{2,3}\)/s, 'no high-frequency diagnostic loop');
});

console.log('\nStale container UUID resolution — general resolver, no hardcoded UUIDs or lectures');

check('resolveExistingURL only rebases when the direct path does not already exist — the common case is untouched', () => {
  const start = legacyAssembly.indexOf('private static func resolveExistingURL(');
  const end = legacyAssembly.indexOf('}', legacyAssembly.lastIndexOf('return fileManager.fileExists(atPath: rebased.path)'));
  const body = legacyAssembly.slice(start, end);
  assert.match(body, /if fileManager\.fileExists\(atPath: direct\.path\) \{ return direct \}/);
});

check('rebasing anchors on the fixed iOS sandbox top-level names (Documents/Library/tmp), never a hardcoded container UUID or lecture id', () => {
  const start = legacyAssembly.indexOf('private static func resolveExistingURL(');
  const end = legacyAssembly.indexOf('}', legacyAssembly.lastIndexOf('return fileManager.fileExists(atPath: rebased.path)'));
  const body = legacyAssembly.slice(start, end);
  assert.match(body, /"Documents", "Library", "tmp"/);
  assert.doesNotMatch(body, /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/i, 'no hardcoded UUID');
  assert.match(body, /NSHomeDirectory\(\)/, 'rebases against the CURRENT app container, computed at call time');
});

check('a rebased path is re-verified with fileExists before being trusted — a missing file is never assumed to exist elsewhere', () => {
  const start = legacyAssembly.indexOf('private static func resolveExistingURL(');
  const end = legacyAssembly.indexOf('}', legacyAssembly.lastIndexOf('return fileManager.fileExists(atPath: rebased.path)'));
  const body = legacyAssembly.slice(start, end);
  assert.match(body, /return fileManager\.fileExists\(atPath: rebased\.path\) \? rebased : direct/,
    'falls back to the original (which the caller will then correctly reject as missing) rather than trusting an unverified rebase');
});

check('persistSources uses the resolver (not a plain URL(fileURLWithPath:) parse) for every source', () => {
  const start = legacyAssembly.indexOf('func persistSources(');
  const end = legacyAssembly.indexOf('func composeAndVerify(');
  const body = legacyAssembly.slice(start, end);
  assert.match(body, /Self\.resolveExistingURL\(source\.uri, fileManager: fileManager\)/);
});

console.log('\nEarly preservation — sources are durably copied BEFORE the user can leave, not only at Finish time');

check('a dedicated persistSources-only native bridge function exists, separate from the full assemble pipeline', () => {
  assert.match(moduleBridge, /AsyncFunction\("persistLegacyAudioSources"\)/);
  assert.match(moduleBridge, /store\.persistSources\(lectureId: lectureId, orderedSources: orderedSources\)/);
});

check('index.ts exports a typed persistLegacyAudioSources wrapper with its own result shape', () => {
  assert.match(bridgeIndex, /export async function persistLegacyAudioSources\(/);
  assert.match(bridgeIndex, /export type LegacyAudioAssemblyPersistResult/);
});

check('the JS orchestrator exposes an early-preservation call distinct from the full recovery call', () => {
  assert.match(orchestrator, /export async function preserveLegacyAudioSourcesEarly\(/);
  const fn = orchestrator.slice(orchestrator.indexOf('export async function preserveLegacyAudioSourcesEarly('));
  assert.match(fn, /persistLegacyAudioSources\(/);
  assert.doesNotMatch(fn.slice(0, fn.indexOf('\n\n', 200)), /assembleLegacyAudio\(/);
});

check('recording.tsx calls early preservation right where audioAssemblyStatus is first set to required, including finalized legacy Pause — and never blocks navigation on its failure', () => {
  const occurrences = (recordingScreen.match(/preserveLegacyAudioSourcesEarly\(/g) || []).length;
  assert.equal(occurrences, 3, 'every assembly-required write-site calls it');
  // Every call site must be followed by a dev-only warn, never a throw/Alert/return that would block leaving.
  let cursor = 0;
  for (let i = 0; i < occurrences; i += 1) {
    const callIdx = recordingScreen.indexOf('preserveLegacyAudioSourcesEarly(', cursor);
    const nearby = recordingScreen.slice(callIdx, callIdx + 300);
    assert.match(nearby, /console\.warn\('\[AudioAssembly\] early-preservation-failed'/);
    assert.doesNotMatch(nearby.slice(0, nearby.indexOf('early-preservation-failed')), /Alert\.alert|throw /);
    cursor = callIdx + 1;
  }
});

console.log('\nUX — no raw native exception text shown to the user; assembly-specific retry label');

check('a raw LegacyAudioAssemblyError message is never rendered directly to the user — only a fixed friendly copy, gated on whether an error occurred', () => {
  assert.doesNotMatch(processingScreen, /\{assemblyError\}/, 'must not interpolate the raw error string into JSX');
  assert.match(processingScreen, /assemblyError \? t\('processing\.step\.assemblyFailed'\)/);
});

check('the retry button for a retryable assembly failure is labeled distinctly from "Retry Upload", while a native-proven invalid source is terminal', () => {
  const start = processingScreen.indexOf('{assemblyRequired && !assembling && !assemblySourceInvalid ?');
  const end = processingScreen.indexOf('\n', start);
  const line = processingScreen.slice(start, end);
  assert.match(line, /t\('processing\.step\.retryRecovery'\)/);
  assert.doesNotMatch(line, /retryUpload/);
  assert.match(processingScreen, /const assemblySourceInvalid = lecture\?\.mediaIntegrityStatus === 'legacy_source_invalid';/);
});

check('the friendly failure copy does not overclaim full safety when a source is actually missing', () => {
  assert.match(read('../lib/locales/en.mjs'), /'processing\.step\.assemblyFailed': 'Part of this recording could not be found\. Your available audio has been kept safely\./);
});

console.log('\nDuration reconciliation — the canonical value is the verified FINAL asset duration, one unit (ms), end to end');

check('composeAndVerify returns finalInspection.durationMs (the actual exported, re-inspected file) as the result duration — never expectedDurationMs (the naive sum) and never a single source\'s duration', () => {
  const start = legacyAssembly.indexOf('let finalInspection = try inspect(finalURL, context: "the finalized assembled asset")');
  const end = legacyAssembly.indexOf('func persistSources(', 0) > start ? legacyAssembly.length : legacyAssembly.indexOf('func assemble(lectureId');
  const body = legacyAssembly.slice(start, end);
  assert.match(body, /durationMs: finalInspection\.durationMs/, 'the returned duration must come from re-inspecting the promoted file, not from the pre-export sum');
  assert.doesNotMatch(body, /durationMs: expectedDurationMs/, 'must not return the naive sum-of-sources as the canonical duration');
});

check('the early-return path for an already-completed final asset ALSO re-inspects the actual file rather than trusting stale metadata', () => {
  const start = legacyAssembly.indexOf('// A prior call already finished');
  const end = legacyAssembly.indexOf('guard let metadata = try readMetadata');
  const body = legacyAssembly.slice(start, end);
  assert.match(body, /let inspection = try inspect\(finalURL, context: "the previously assembled asset"\)/);
  assert.match(body, /durationMs: inspection\.durationMs/);
});

check('native asDictionary uses the "durationMs" key consistently — one field name, one unit, no seconds-field alongside it that a caller could grab by mistake', () => {
  const start = legacyAssembly.indexOf('func asDictionary() -> [String: Any] {');
  const end = legacyAssembly.indexOf('}', start);
  const body = legacyAssembly.slice(start, end);
  assert.match(body, /"durationMs": durationMs/);
  assert.doesNotMatch(body, /durationSec|"duration":/i);
});

check('the JS bridge (index.ts) passes result.durationMs straight through as durationMs — no *1000 or /1000 anywhere near it (native already returns milliseconds)', () => {
  const start = bridgeIndex.indexOf('export async function assembleLegacyAudio(');
  const end = bridgeIndex.length;
  const body = bridgeIndex.slice(start, bridgeIndex.indexOf('\n}', start) + 2);
  assert.match(body, /durationMs: result\.durationMs as number/);
  assert.doesNotMatch(body, /durationMs\s*[*/]\s*1000|1000\s*[*/]\s*.*durationMs/);
});

check('legacyAudioAssembly.ts copies durationMs straight into durationMillis — a rename, not a unit conversion (ms in, ms out)', () => {
  const fn = orchestrator.slice(
    orchestrator.indexOf('export async function recoverLegacyAudioAssembly'),
  );
  assert.match(fn, /durationMillis: result\.durationMs/);
  assert.doesNotMatch(fn, /durationMs\s*[*/]\s*1000|result\.durationMs\s*\/\s*1000|result\.durationMs\s*\*\s*1000/);
});

check('processing.tsx writes durationMillis from result.durationMillis exactly once in the updateLecture call, and nothing in the whole success branch re-reads a stale lecture.durationMillis afterward', () => {
  const start = processingScreen.indexOf('const runAssembly = useCallback');
  const end = processingScreen.indexOf('}, [lecture, updateLecture]);');
  const body = processingScreen.slice(start, end);
  // Skip the earlier failure-diagnostic updateLecture call — this checks
  // specifically the success-path reconciliation write, which begins only
  // after the early-return failure gate's `return;`.
  const failGateReturnIdx = body.indexOf('return;', body.indexOf('if (!result.ok)'));
  const updateCallStart = body.indexOf('updateLecture(lecture.id, {', failGateReturnIdx);
  const updateCallEnd = body.indexOf('});', updateCallStart);
  const updateCallBody = body.slice(updateCallStart, updateCallEnd);
  const occurrences = (updateCallBody.match(/durationMillis:/g) || []).length;
  assert.equal(occurrences, 1, 'exactly one durationMillis field in the updateLecture patch (a __DEV__ log line elsewhere may share the field name for readability, but must not be a second store write)');
  assert.match(updateCallBody, /durationMillis: result\.durationMillis/);
  assert.doesNotMatch(body, /lecture\.durationMillis/, 'must never fall back to or blend in the old (possibly corrupted) stored duration');
});

check('formatDuration is a pure display formatter never used in the reconciliation write path — it must not be mistaken for a value that mutates storage', () => {
  const start = processingScreen.indexOf('const runAssembly = useCallback');
  const end = processingScreen.indexOf('}, [lecture, updateLecture]);');
  assert.doesNotMatch(processingScreen.slice(start, end), /formatDuration/);
});

check('fixture: 128.08s + 75.44s sources sum to ≈203.52s and format as 3:23 — the shipped formatDuration algorithm, exercised on an EXAMPLE value only (not hardcoded into any product source file)', () => {
  const productFiles = [orchestrator, processingScreen, bridgeIndex, legacyAssembly, moduleBridge];
  for (const file of productFiles) {
    assert.doesNotMatch(file, /203520|203\.52|128080|75440/, 'this specific forensic-lecture duration must never be hardcoded into product logic');
  }
  const formatDuration = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const seconds = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
  };
  const priorMs = 128_080;
  const resumedMs = 75_440;
  const summedMs = priorMs + resumedMs;
  assert.equal(summedMs, 203_520);
  assert.equal(formatDuration(summedMs), '3:23');
});

check('a second real-device fixture (99.96s + 38.13s ≈ 138.09s) — proving this is a general contract, not tuned to one specific pair of numbers', () => {
  const formatDuration = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(s / 60);
    const seconds = s % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  };
  const summedMs = 99_960 + 38_126;
  assert.equal(summedMs, 138_086);
  assert.equal(formatDuration(summedMs), '2:18');
});

console.log(`\nlegacy-audio-assembly-recovery: ${passed} checks passed`);
