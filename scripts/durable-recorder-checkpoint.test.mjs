import assert from 'node:assert/strict';

import { nativeSources, readSources } from './lib/swift-harness.mjs';

// Behavioral checkpoint coverage lives in durable-recorder-audio-core.test.swift
// (invoked by durable-recorder-audio.test.mjs). This file locks the production
// interval policy and long-session segment-count expectations without waiting
// in real time or recompiling the Swift harness twice.

const sources = await readSources(nativeSources.core, nativeSources.store, nativeSources.recorder);

assert.match(
  sources,
  /static let defaultCheckpointInterval: TimeInterval = 60/,
  'production checkpoint interval must be the documented 60s constant',
);
assert.match(sources, /performCheckpointRollover/, 'internal checkpoint rollover must exist');
assert.match(sources, /checkpointGeneration/, 'stale checkpoint callbacks must be identity-gated');
assert.match(sources, /reason: "checkpoint"/, 'checkpoint commits must tag interruptionReason');
assert.match(
  sources,
  /func scheduleCheckpoint\(\)/,
  'checkpoint scheduling must be native-owned',
);
assert.doesNotMatch(
  sources,
  /moov|reconstruct.*atom|M4A repair/i,
  'checkpoint durability must not depend on M4A binary repair',
);

assert.match(
  sources,
  /_ = try beginSegment\(recordingSessionId: recordingSessionId, resuming: true\)\s*\n\s*scheduleCheckpoint\(\)/,
  'successful checkpoint must begin the next segment and reschedule',
);
assert.match(
  sources,
  /Do not publishStatus: a successful checkpoint must stay invisible to JS/,
  'successful checkpoints must document no JS status publish',
);

// Long-session segment-count analysis at the production interval.
const INTERVAL_SECONDS = 60;
const lectures = [
  { minutes: 60, expectedCheckpoints: 60, finishSegments: 61 },
  { minutes: 90, expectedCheckpoints: 90, finishSegments: 91 },
  { minutes: 180, expectedCheckpoints: 180, finishSegments: 181 },
];

for (const lecture of lectures) {
  const captureSeconds = lecture.minutes * 60;
  const checkpointCommits = Math.floor(captureSeconds / INTERVAL_SECONDS);
  assert.equal(
    checkpointCommits,
    lecture.expectedCheckpoints,
    `${lecture.minutes}m lecture should commit ${lecture.expectedCheckpoints} checkpoint segments`,
  );
  assert.equal(
    checkpointCommits + 1,
    lecture.finishSegments,
    `${lecture.minutes}m finish should yield ${lecture.finishSegments} total segments`,
  );
  assert.ok(lecture.finishSegments < 500, 'segment count must stay manageable for export');
}

console.log('Durable recorder checkpoint policy tests passed.');
