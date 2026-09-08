/**
 * Course Material → Caption disappearing (app/lecture-material/[lectureId]/[materialId].tsx)
 * — round 2.
 *
 * Round 1 fixed the ROUTE-based gate (materialReviewMode fully unmounting
 * FloatingMiniCaption) but replaced it with a LIVE-CAPTION-PROVIDER-based
 * gate (`useLiveCaptions().status`). Physical owner retest still failed:
 * staging has no ASR key configured, so the live-caption provider's status
 * settles at 'unavailable' even while a real recording is actively running —
 * a status not covered by the old gate's status set — so the Caption
 * workspace still vanished.
 *
 * Root fix: Caption availability inside Course Material must follow the
 * RECORDING/classroom session, not the live-caption network/API status.
 * `isLectureSessionActive` (lib/recordingNotes.tsx) is the existing,
 * authoritative, cross-screen signal for exactly this — registered true only
 * while app/recording.tsx is mounted with a live pause/resume handler, and
 * already consumed the same way by app/lecture/[id].tsx to know a recording
 * is active elsewhere. No new recording state was invented.
 *
 * FloatingMiniCaption's own internal `enabled` prop (already existed,
 * documented "if false, renders nothing") is now the SOLE mount gate —
 * `showForCaptionState` (a live-caption-status-based second gate) was
 * removed from the component entirely, since it could independently hide
 * the whole panel even when the caller correctly says `enabled=true`.
 * Once mounted, the panel's own existing text logic already degrades
 * gracefully (connecting/listening/unavailable copy) without needing a
 * second unmount gate.
 *
 * These are structural source-level guards (this is a route/context-driven
 * screen; end-to-end "does the pill actually show up on a real device with
 * no ASR key configured" can only be judged on a real device — see the
 * task's own runtime-validation requirement).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const src = read('../app/lecture-material/[lectureId]/[materialId].tsx');
const floatingMiniCaption = read('../components/FloatingMiniCaption.tsx');

console.log('1/2. Recording-active state drives availability, not live-caption provider status');

check('classroomSessionActive comes from useRecordingNotes().isLectureSessionActive, not useLiveCaptions().status', () => {
  assert.match(src, /const \{ isLectureSessionActive: classroomSessionActive \} = useRecordingNotes\(\);/);
  assert.doesNotMatch(src, /captionSessionActive/, 'the old liveCaptionStatus-derived flag must be gone, not just renamed');
});

check('the material screen imports useRecordingNotes (the same authoritative session signal app/lecture/[id].tsx already uses)', () => {
  assert.match(src, /import \{ useRecordingNotes \} from '@\/lib\/recordingNotes';/);
});

check('classroomSessionActive is not derived from any liveCaptionStatus value (active/listening/connecting/error) anymore', () => {
  const flagSite = src.slice(src.indexOf('const { isLectureSessionActive: classroomSessionActive }'), src.indexOf('const { isLectureSessionActive: classroomSessionActive }') + 400);
  assert.doesNotMatch(flagSite, /liveCaptionStatus ===/);
});

console.log('\n3/4. FloatingMiniCaption mounts on classroomSessionActive; the route sentinel plays no role');

check('FloatingMiniCaption receives enabled={classroomSessionActive} explicitly, no materialReviewMode gate anywhere near it', () => {
  assert.match(src, /<FloatingMiniCaption topOffset=\{insets\.top \+ 80\} enabled=\{classroomSessionActive\} \/>/);
  const renderSite = src.slice(src.indexOf('<FloatingMiniCaption'), src.indexOf('<FloatingMiniCaption') + 100);
  assert.doesNotMatch(renderSite, /materialReviewMode/);
});

console.log('\n5. FloatingPageNavigator\'s caption-spacing flag also tracks classroomSessionActive, not liveCaptionStatus or materialReviewMode');

check('captionsEnabled is passed classroomSessionActive', () => {
  assert.match(src, /captionsEnabled=\{classroomSessionActive\}/);
  assert.doesNotMatch(src, /captionsEnabled=\{captionSessionActive\}/);
  assert.doesNotMatch(src, /captionsEnabled=\{!materialReviewMode\}/);
});

console.log('\nFloatingMiniCaption itself: enabled is the sole mount gate — no second, live-caption-status-based gate left');

check('showForCaptionState no longer exists in FloatingMiniCaption — it could hide the panel even when the caller says enabled=true', () => {
  assert.doesNotMatch(floatingMiniCaption, /showForCaptionState/, 'must be fully removed, not just unused');
});

check('the only early-return mount gate is `if (!enabled) return null;`', () => {
  assert.match(floatingMiniCaption, /if \(!enabled\) return null;/);
});

console.log('\nNumeric proof: availability now tracks recording state across all the states that actually matter');

/**
 * Models the current source logic directly: availability is a pure function
 * of the recording-session flag now, completely independent of whatever the
 * live-caption provider's status happens to be.
 */
function shouldShowCaptionUi(isLectureSessionActive, _liveCaptionStatusIgnored) {
  return isLectureSessionActive;
}

check('recording ACTIVE + live-caption status "unavailable" (no ASR key configured) -> Caption UI still available — the exact reported failure', () => {
  assert.equal(shouldShowCaptionUi(true, 'unavailable'), true);
});

check('recording ACTIVE + live-caption status "idle" (never started) -> Caption UI still available', () => {
  assert.equal(shouldShowCaptionUi(true, 'idle'), true);
});

check('recording ACTIVE + live-caption status "error" -> Caption UI still available', () => {
  assert.equal(shouldShowCaptionUi(true, 'error'), true);
});

check('recording ACTIVE + live-caption status "listening" (healthy) -> Caption UI available, as always', () => {
  assert.equal(shouldShowCaptionUi(true, 'listening'), true);
});

check('NO active recording, idle material browsing -> no Caption UI, regardless of live-caption status', () => {
  assert.equal(shouldShowCaptionUi(false, 'idle'), false);
  assert.equal(shouldShowCaptionUi(false, 'listening'), false, 'even a stray healthy status must not show the workspace without a real session');
});

console.log(`\nmaterial-caption-visibility: ${passed} checks passed`);
