/**
 * Finish failure UX. Native already reports the safe background-expiry condition with an actionable message; the UI used
 * to replace it with the generic "Could not finish the recording.", which reads like the lecture was lost. Only THAT
 * known condition may reassure the owner; every other failure keeps the generic, non-reassuring text.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FINISH_BACKGROUND_EXPIRED_MESSAGE,
  FINISH_FAILURE_GENERIC_MESSAGE,
  finishFailureUserMessage,
  isBackgroundExpiredFinishFailure,
} from '../lib/recording/finishFailure.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };
const slice = (text, from, to) => {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `missing: ${from}`);
  const end = to ? text.indexOf(to, start + from.length) : text.length;
  assert.ok(end > start, `missing end: ${to}`);
  return text.slice(start, end);
};

const NATIVE_EXPIRY =
  'The durable final audio asset could not be created: The final export was interrupted because the app ran out of '
  + 'background time. The recording is safe on this device — open the app and tap Finish again.';
const EXPORT_CODE = 'ERR_DURABLE_RECORDER_FINAL_ASSET_EXPORT';

console.log('Finish failure message');
check('A. the known background-expiry failure shows the safe / retry message', () => {
  const failure = { ok: false, errorCode: EXPORT_CODE, error: NATIVE_EXPIRY };
  assert.equal(isBackgroundExpiredFinishFailure(failure), true);
  assert.equal(finishFailureUserMessage(failure), FINISH_BACKGROUND_EXPIRED_MESSAGE);
  assert.match(FINISH_BACKGROUND_EXPIRED_MESSAGE, /recording is safe/i);
  assert.match(FINISH_BACKGROUND_EXPIRED_MESSAGE, /keep Youmi Lens open/i);
  assert.match(FINISH_BACKGROUND_EXPIRED_MESSAGE, /tap Finish again/i);
  // the runtime decorates native messages (prefixes/causes): the marker match must survive that
  assert.equal(
    finishFailureUserMessage({ errorCode: EXPORT_CODE, error: `Calling the 'exportFinalizedAsset' function has failed\n→ ${NATIVE_EXPIRY}` }),
    FINISH_BACKGROUND_EXPIRED_MESSAGE,
  );
});
check('B. arbitrary Finish failures never claim the recording is safe', () => {
  const others = [
    { errorCode: EXPORT_CODE, error: 'The durable final audio asset could not be created: A source segment is missing' },
    { errorCode: EXPORT_CODE, error: 'The durable final audio asset could not be created: AVAssetExportSession could not be created.' },
    { errorCode: 'ERR_DURABLE_RECORDER_FINAL_ASSET_MISSING', error: 'The durable final audio asset is missing.' },
    { errorCode: 'ERR_DURABLE_RECORDER_STORAGE', error: NATIVE_EXPIRY }, // phrase alone, wrong code: must not borrow the reassurance
    { errorCode: EXPORT_CODE, error: 'unrelated' },
    { errorCode: undefined, error: NATIVE_EXPIRY },
    { error: 'The durable session export produced no verified duration.' },
    { error: undefined },
    null,
    undefined,
  ];
  for (const failure of others) {
    assert.equal(finishFailureUserMessage(failure), FINISH_FAILURE_GENERIC_MESSAGE, JSON.stringify(failure));
    assert.doesNotMatch(finishFailureUserMessage(failure), /safe/i);
  }
  assert.equal(FINISH_FAILURE_GENERIC_MESSAGE, 'Could not finish the recording.');
});

const hook = read('lib/recording/useNativeDurableLectureRecorder.ts');
const recovery = read('lib/recording/durableSessionRecovery.ts');
const finish = slice(hook, 'const finishSession = useCallback(', 'const stopRecording = useCallback(');

check('the hook routes the failure text through the classifier and still surfaces the raw detail', () => {
  assert.match(finish, /fail\(finishFailureUserMessage\(result\), result\.error\);/);
  assert.match(hook, /import \{ finishFailureUserMessage \} from '\.\/finishFailure\.mjs';/);
});
check('the native error code is carried (not just its text) so classification needs BOTH code and phrase', () => {
  assert.match(recovery, /\{ ok: false; error: string; errorCode\?: string \}/);
  assert.match(recovery, /errorCode: error instanceof DurableRecorderError \? error\.code : undefined/);
});
check('C. successful Finish behavior is unchanged', () => {
  const success = slice(finish, 'finalAssetDurationMillisRef.current = result.durationMs;', 'return result.fileUri;');
  assert.match(success, /applySession\(result\.session\); activeRef\.current = false; setIsRecording\(false\); setIsPaused\(false\);/);
  assert.match(success, /setRecordingUri\(result\.fileUri\);/);
  assert.match(success, /native_recording_finalized/);
  assert.doesNotMatch(success, /finishFailureUserMessage|fail\(/);
});
check('D. retry behavior is unchanged: failure re-syncs with the durable session, keeps it, and returns null', () => {
  const failure = slice(finish, 'if (!result.ok) {', 'finalAssetDurationMillisRef.current = result.durationMs;');
  assert.match(failure, /finishingRef\.current = false;/);
  assert.match(failure, /await getSession\(session\.recordingSessionId\)/);
  assert.match(failure, /applySession\(latest\); activeRef\.current = false; setIsRecording\(false\); setIsPaused\(true\);/);
  assert.match(failure, /return null;/);
  assert.doesNotMatch(failure, /deleteSession|abandonSession|discardRecoverableRecording|transitionSession|setRecordingUri/, 'never mutates or discards the durable session');
  // the retry still goes through the same finalize+export entry, which re-exports a finalized session
  assert.match(recovery, /else if \(finalSession\.state === 'finalizing'\)/);
  assert.match(recovery, /const output = await exportFinalizedAsset\(/);
});
check('native export behavior was not touched by this change', () => {
  const exporter = read('modules/expo-durable-recorder/ios/DurableFinalAssetExporter.swift');
  assert.match(exporter, /The final export was interrupted because the app ran out of background time\./);
  assert.match(exporter, /open the app and tap Finish again\./);
});

console.log('Finish failure message tests passed.');
