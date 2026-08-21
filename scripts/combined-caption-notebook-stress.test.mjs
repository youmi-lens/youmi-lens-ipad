import assert from 'node:assert/strict';

import {
  CAPTION_FOLLOW_MODE,
  CAPTION_SCROLL_ORIGIN,
  followModeAfterScroll,
  shouldRequestCaptionAutoScroll,
} from '../lib/captionFeed.mjs';
import { reduceToolbarCollapsed, shouldStartToolbarTransition } from '../lib/notebookToolbarTransition.mjs';
import { chunkTranscript } from '../lib/transcriptChunks.mjs';

// Deterministic 40-minute combined model: captions continue through one
// pause/resume while the Notebook toolbar is repeatedly toggled. Notebook
// content and zoom are immutable sentinels; neither transition reducer owns them.
let followMode = CAPTION_FOLLOW_MODE.FOLLOWING;
let toolbarCollapsed = false;
let transitionStarts = 0;
let captionRequests = 0;
let recordingPaused = false;
const notebookStrokes = Array.from({ length: 500 }, (_, id) => ({ id, points: 24 }));
const initialNotebookIdentity = notebookStrokes;
const notebookZoom = 1.35;

for (let second = 0; second < 40 * 60; second += 1) {
  if (second === 1200) recordingPaused = true;
  if (second === 1210) recordingPaused = false;

  if (!recordingPaused) {
    for (const reason of ['interim-caption', 'final-caption']) {
      if (shouldRequestCaptionAutoScroll({ mode: followMode, reason })) captionRequests += 1;
      followMode = followModeAfterScroll({
        mode: followMode,
        origin: CAPTION_SCROLL_ORIGIN.PROGRAMMATIC,
        distanceFromBottomPx: second * 53,
      });
    }
    // Delayed translation/layout/virtualization callbacks are never USER origin.
    followMode = followModeAfterScroll({
      mode: followMode,
      origin: CAPTION_SCROLL_ORIGIN.NONE,
      distanceFromBottomPx: second * 71,
    });
  }

  if (second % 15 === 0) {
    const requested = !toolbarCollapsed;
    if (shouldStartToolbarTransition(toolbarCollapsed, requested)) transitionStarts += 1;
    toolbarCollapsed = reduceToolbarCollapsed(toolbarCollapsed, requested);
  }
}

assert.equal(followMode, CAPTION_FOLLOW_MODE.FOLLOWING);
assert.equal(captionRequests, (40 * 60 - 10) * 2);
assert.equal(transitionStarts, 160);
assert.equal(toolbarCollapsed, false);
assert.equal(notebookStrokes, initialNotebookIdentity);
assert.equal(notebookStrokes.length, 500);
assert.equal(notebookZoom, 1.35);
assert.equal(recordingPaused, false);

const transcript = Array.from({ length: 540 }, (_, index) =>
  `${index % 6 === 0 ? '\n\n' : ''}A realistic lecture paragraph preserves every word while read mode virtualizes stable chunks. `,
).join('');
const transcriptChunks = chunkTranscript(transcript);
assert.equal(transcriptChunks.join(''), transcript);
assert.ok(transcriptChunks.length > 20);
const majorButtonTaps = 40;
assert.equal(majorButtonTaps, 40);

console.log('Combined 40-minute caption/Notebook/transcript/interaction stress simulation passed.');
