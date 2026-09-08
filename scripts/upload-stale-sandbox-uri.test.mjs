/**
 * P0 — upload path opened a stale sandbox-container file URI directly.
 *
 * Physical repro: RCTNetworking/RCTHTTPFormDataHelper threw
 * NSCocoaErrorDomain Code=260 ("lecture.m4a couldn't be opened") for
 * Library/Application Support/YoumiLens/AudioAssembly/<id>/final/lecture.m4a.
 * Filesystem evidence proved the file genuinely exists under the CURRENT
 * app container (154.7 MB, readable) — only the persisted `localAudioUri`'s
 * absolute path carried an OLDER container UUID from before a reinstall.
 *
 * Root cause: playback already resolves every persisted localAudioUri
 * through lib/lectureLocalAudio.ts's resolvePlayableLocalAudioUri (which
 * rewrites stale Documents/Library-Caches/Library-Application-Support
 * paths onto the current container and verifies the result actually
 * exists) — see app/lecture/[id].tsx's `resolveLectureAudioPlaybackState`
 * usage and its stale-URI self-heal effect. useProcessingOrchestrator's
 * startUpload never went through this resolver: it read `lecture.
 * localAudioUri` straight off the store and handed it directly to RN's
 * multipart file part, so a stale-container path reached native networking
 * code untouched.
 *
 * Fix: startUpload now resolves through the SAME canonical resolver before
 * uploading, self-heals the store when the resolved path differs (so
 * repeat attempts don't re-resolve every time), and fails safely — never
 * silently, never by deleting/regenerating anything — when the resolver
 * proves the file is genuinely missing everywhere.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const orchestrator = await read('../lib/useProcessingOrchestrator.ts');
const localAudio = await read('../lib/lectureLocalAudio.ts');
const lectureDetail = await read('../app/lecture/[id].tsx');

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };

console.log('Root cause — startUpload used to bypass the canonical resolver entirely');

check('startUpload imports and calls the SAME resolver playback already uses — no duplicated ad-hoc regex', () => {
  assert.match(orchestrator, /import \{ resolvePlayableLocalAudioUri \} from '\.\/lectureLocalAudio';/);
  const start = orchestrator.indexOf('const startUpload = (lectureId: string, remoteRecordingId: string) => {');
  const end = orchestrator.indexOf('uploadingRef.current.add(lectureId);', start);
  const body = orchestrator.slice(start, end);
  assert.match(body, /const resolvedLocalUri = resolvePlayableLocalAudioUri\(lecture\.localAudioUri, lecture\.id\);/);
});

check('resolvePlayableLocalAudioUri is a plain, non-hook function — safe to call from this non-component code path', () => {
  assert.match(localAudio, /export function resolvePlayableLocalAudioUri\(/);
  assert.doesNotMatch(localAudio, /export function resolvePlayableLocalAudioUri[\s\S]{0,80}use[A-Z]/, 'must not itself be a React hook');
});

check('the resolver preserves support for every known stale-container prefix: Documents, Library/Caches, Library/Application Support (both encodings)', () => {
  const rewriter = localAudio.slice(localAudio.indexOf('function rewriteSandboxUri'), localAudio.indexOf('function rewriteSandboxUri') + 1600);
  assert.match(rewriter, /\/Library\/Caches\//);
  assert.match(rewriter, /\/Library\/Application%20Support\//);
  assert.match(rewriter, /\/Library\/Application Support\//);
  assert.match(rewriter, /\/Documents\//);
});

console.log('\nA proven (file exists, stale path only) — resolve and self-heal, never re-derive the path twice');

check('a resolved path that differs from the persisted one is written back to the store — so the NEXT upload attempt (retry, relaunch) does not re-resolve from scratch', () => {
  const start = orchestrator.indexOf('const resolvedLocalUri = resolvePlayableLocalAudioUri');
  const end = orchestrator.indexOf('uploadingRef.current.add(lectureId);', start);
  const body = orchestrator.slice(start, end);
  assert.match(body, /if \(resolvedLocalUri !== lecture\.localAudioUri\) \{/);
  assert.match(body, /updateLecture\(lectureId, \{ localAudioUri: resolvedLocalUri \}\);/);
});

check('the upload itself is handed the RESOLVED uri, never the raw possibly-stale lecture.localAudioUri', () => {
  const start = orchestrator.indexOf('void uploadLectureAudio({');
  const end = orchestrator.indexOf('});', start);
  const body = orchestrator.slice(start, end);
  assert.match(body, /localUri: resolvedLocalUri,/);
  assert.doesNotMatch(body, /localUri: lecture\.localAudioUri,/);
});

console.log('\nB proven (genuinely missing everywhere) — fail safely, never delete/regenerate/silently retry');

check('a null resolution result marks the lecture upload_failed with a clear, honest error and returns before any upload attempt — never deletes or regenerates local state', () => {
  const start = orchestrator.indexOf('const resolvedLocalUri = resolvePlayableLocalAudioUri');
  const end = orchestrator.indexOf('if (resolvedLocalUri !== lecture.localAudioUri)', start);
  const body = orchestrator.slice(start, end);
  assert.match(body, /if \(!resolvedLocalUri\) \{/);
  assert.match(body, /uploadStatus: 'upload_failed',/);
  assert.match(body, /uploadError: 'The local recording could not be found on this device\.',/);
  assert.match(body, /return;/);
  assert.doesNotMatch(body, /removeItem|deleteAsync|unlink|localAudioUri: null/i, 'a missing file must never trigger deletion/regeneration of local state');
});

check('the missing-file branch never reaches uploadingRef.current.add or the actual upload call — no in-flight guard is taken for a request that will never fire', () => {
  const missingBranchStart = orchestrator.indexOf('if (!resolvedLocalUri) {');
  const missingBranchEnd = orchestrator.indexOf('return;', missingBranchStart) + 'return;'.length;
  const uploadingAddIdx = orchestrator.indexOf('uploadingRef.current.add(lectureId);');
  assert.ok(missingBranchEnd < uploadingAddIdx, 'the missing-file early return must come before the in-flight guard is armed');
});

console.log('\nExisting playback resolution path stays untouched by this fix');

check('app/lecture/[id].tsx still resolves through resolveLectureAudioPlaybackState and self-heals the SAME way — this fix only extends the pattern to upload, not a parallel one', () => {
  assert.match(lectureDetail, /resolveLectureAudioPlaybackState/);
  assert.match(lectureDetail, /updateLecture\(lecture\.id, \{ localAudioUri: audioPlayback\.uri \}\);/);
});

console.log(`\nupload-stale-sandbox-uri: ${passed} checks passed`);
