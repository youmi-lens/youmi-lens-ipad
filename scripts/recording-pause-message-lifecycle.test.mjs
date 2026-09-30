/**
 * UX contract: the bottom "Recording paused — tap Resume to continue." message (the hook's `error`) is cleared only
 * after native CONFIRMS the recording is active again — by a successful manual Resume, or by native recovering on its
 * own — and stays visible when Resume fails. It is never cleared optimistically on the button tap.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const check = (label, fn) => { fn(); console.log(`  ok  ${label}`); };
const slice = (text, from, to) => {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `missing: ${from}`);
  const end = to ? text.indexOf(to, start + from.length) : text.length;
  assert.ok(end > start, `missing end: ${to}`);
  return text.slice(start, end);
};

const hook = read('lib/recording/useNativeDurableLectureRecorder.ts');
const screen = read('app/recording.tsx');
const resume = slice(hook, 'const resumeRecording = useCallback(async () => {', 'const finishSession = useCallback(');

console.log('Pause message lifecycle');
check('successful manual Resume clears the stale pause reason AND the message, after native success', () => {
  const nativeCall = resume.indexOf('await resumeNative(');
  const clearDegraded = resume.indexOf('setDegradedReason(null);');
  const clearError = resume.indexOf('setError(null); setErrorDetail(null);');
  assert.ok(nativeCall >= 0 && clearDegraded > nativeCall, 'degraded reason is cleared only after the native resume returned');
  assert.ok(clearError > nativeCall, 'the visible message is cleared only after the native resume returned');
  const tryBlock = slice(resume, 'try {', '} catch (failure) {');
  assert.ok(tryBlock.includes('setError(null); setErrorDetail(null);'), 'clearing happens inside the success path');
});
check('a failed Resume keeps the warning visible and never clears it', () => {
  const catchBlock = slice(resume, '} catch (failure) {', 'return false;');
  assert.match(catchBlock, /fail\(/, 'failure surfaces a message');
  assert.doesNotMatch(catchBlock, /setError\(null\)|setDegradedReason\(null\)/);
});
check('the message is never cleared on the button tap itself (no optimistic clear in the screen)', () => {
  const toggle = slice(screen, 'if (isPaused) {\n      const resumed = await resumeRecording();', 'else {\n      const paused = await pauseRecording();');
  assert.doesNotMatch(toggle, /setError|setDegradedReason/);
});
check('when native recovers on its own (automatic recovery), the recording branch clears the stale message', () => {
  const branch = slice(hook, "if (session.state === 'recording') {", "if (session.state === 'finalized') {");
  assert.match(branch, /if \(!activeRef\.current\) \{[\s\S]*?setDegradedReason\(null\);\s*\n\s*setError\(null\); setErrorDetail\(null\);/);
});
check('both checkpoint and route recovery failures show the recovery message with their own reason', () => {
  assert.match(hook, /status\.interruptionState === 'checkpoint_begin_segment_failed'\s*\n\s*\|\| status\.interruptionState === 'route_recovery_failed'/);
});

console.log('Pause message lifecycle tests passed.');
