import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  lectureRecordingEngine,
  recoverableSessionsForLecture,
} from '../lib/recording/policy.mjs';
import { REMOTE_RECORDING_COLUMNS } from '../lib/remoteRecordingColumns.mjs';

// --- C. Provenance -----------------------------------------------------------

assert.equal(lectureRecordingEngine({ recordingEngine: 'nativeDurable' }), 'nativeDurable');
assert.equal(lectureRecordingEngine({ recordingEngine: 'legacy' }), 'legacy');
assert.equal(lectureRecordingEngine({}), 'legacy', 'lectures without provenance read as legacy');
assert.equal(lectureRecordingEngine(undefined), 'legacy', 'a missing lecture is safe');
assert.equal(lectureRecordingEngine({ recordingEngine: 'somethingElse' }), 'legacy', 'unknown values fail safe');

// Provenance is local-only: it must never reach the backend column allowlist.
assert.ok(
  !/recording_engine|recordingEngine/.test(REMOTE_RECORDING_COLUMNS),
  'provenance must not be added to remote recording columns',
);

const models = await readFile(new URL('../lib/models.ts', import.meta.url), 'utf8');
assert.match(models, /recordingEngine\?: 'legacy' \| 'nativeDurable';/, 'provenance is optional on Lecture');

// Every place the recording screen writes a lecture must stamp provenance, so
// provenance survives autosave, an app kill, and the final save alike.
const screen = await readFile(new URL('../app/recording.tsx', import.meta.url), 'utf8');
const writeCalls = [...screen.matchAll(/(saveInProgressLecture|createLecture|updateLecture)\(\s*(?:[A-Za-z]+,\s*)?\{[\s\S]{0,900}?\n\s{4,6}\}\)/g)];
assert.ok(writeCalls.length >= 5, `expected the known lecture write sites, found ${writeCalls.length}`);
for (const [call] of writeCalls.map((match) => [match[0]])) {
  assert.match(call, /recordingEngine,/, `a lecture write site is missing provenance:\n${call.slice(0, 160)}`);
}

// Accepting provenance is not enough — the store builds Lecture objects field
// by field, so every construction path must actually carry it through.
const storeSource = await readFile(new URL('../lib/store.tsx', import.meta.url), 'utf8');
assert.match(storeSource, /recordingEngine\?: 'legacy' \| 'nativeDurable';/, 'NewLectureInput accepts provenance');
/** Extracts each `: Lecture = { ... }` object literal by brace counting. */
function lectureLiterals(source) {
  const blocks = [];
  const marker = /: Lecture = \{/g;
  let match;
  while ((match = marker.exec(source)) !== null) {
    let depth = 0;
    const start = match.index + match[0].length - 1;
    for (let index = start; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      else if (source[index] === '}') {
        depth -= 1;
        if (depth === 0) {
          blocks.push(source.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return blocks;
}

const constructionPaths = lectureLiterals(storeSource);
assert.equal(constructionPaths.length, 3, 'expected createLecture plus both saveInProgressLecture paths');
for (const block of constructionPaths) {
  assert.match(block, /recordingEngine/, `a Lecture construction path drops provenance:\n${block.slice(0, 160)}`);
}
// An autosave must never downgrade provenance set when capture started.
assert.match(
  storeSource,
  /recordingEngine: existing\.recordingEngine \?\? input\.recordingEngine/,
  'existing provenance wins over a later autosave',
);

// --- E. Recovery routing -----------------------------------------------------

const segment = (sequence, id) => ({ sequence, segmentId: id, durationMs: 1000 });
const sessionFor = (lectureId, id, updatedAt, extra = {}) => ({
  recordingSessionId: id,
  lectureId,
  updatedAt,
  recoverable: true,
  segments: [segment(1, `${id}-s1`)],
  ...extra,
});

const mine = sessionFor('lecture-mine', 'a', '2026-01-02T00:00:00Z');
const alsoMine = sessionFor('lecture-mine', 'b', '2026-01-01T00:00:00Z');
const other = sessionFor('lecture-other', 'c', '2026-01-03T00:00:00Z');

// Reopening an in-progress lecture resolves that lecture's own session.
assert.deepEqual(recoverableSessionsForLecture([mine, other], 'lecture-mine'), [mine]);

// A brand-new lecture id has nothing to attach to, so a new recording cannot
// pick up an older session.
assert.deepEqual(recoverableSessionsForLecture([mine, other], 'lecture-brand-new'), []);

// Multiple candidates resolve deterministically: newest first, then by id.
assert.deepEqual(recoverableSessionsForLecture([alsoMine, mine], 'lecture-mine'), [mine, alsoMine]);
const tie = [
  sessionFor('lecture-mine', 'z', '2026-01-05T00:00:00Z'),
  sessionFor('lecture-mine', 'y', '2026-01-05T00:00:00Z'),
];
assert.deepEqual(
  recoverableSessionsForLecture(tie, 'lecture-mine').map((s) => s.recordingSessionId),
  ['y', 'z'],
  'identical timestamps break ties deterministically by session id',
);

// Acknowledged handoff is never re-offered; a discarded session is simply absent.
assert.deepEqual(
  recoverableSessionsForLecture(
    [{ ...mine, recoverable: false, state: 'finalized', handoffCompletedAt: '2026-01-04T00:00:00Z' }],
    'lecture-mine',
  ),
  [],
);
assert.deepEqual(recoverableSessionsForLecture([], 'lecture-mine'), []);

// User boundary: lectures are stored per user, so a session is only reachable
// through a lecture id the signed-in user can see.
const store = await readFile(new URL('../lib/store.tsx', import.meta.url), 'utf8');
assert.match(store, /scopedLecturesKey = \(userId: string\)/, 'lectures are scoped per user id');
assert.ok(
  recoverableSessionsForLecture([other], 'lecture-mine').length === 0,
  "another lecture's session is never offered",
);

// Signing out must not delete durable audio.
assert.doesNotMatch(
  store,
  /deleteSession|DurableRecorder/,
  'the account store must never delete durable recording state',
);

console.log('Recording provenance and routing tests passed.');
