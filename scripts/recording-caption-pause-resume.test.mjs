#!/usr/bin/env node
/**
 * Regression: Pause → Resume must reconnect live captions without clearing
 * accumulated caption history. Audio continuity is owned by the recorder;
 * this gates the caption-state mistake that wiped history on Resume.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'app/recording.tsx'), 'utf8');

assert.match(
  source,
  /startCaptionPipeline\s*=\s*async\s*\(\s*options\?\s*:\s*\{\s*preserveHistory\?\s*:\s*boolean\s*\}\s*\)/,
  'startCaptionPipeline must accept preserveHistory',
);
assert.match(
  source,
  /if\s*\(\s*!options\?\.preserveHistory\s*\)\s*\{\s*resetCaptions\(\);\s*\}/,
  'resetCaptions must be skipped when preserveHistory is set',
);
assert.match(
  source,
  /await resumeRecording\(\);\s*(?:\/\/[^\n]*\n\s*)*if\s*\(\s*!isGuest\s*\)\s*await startCaptionPipeline\(\s*\{\s*preserveHistory:\s*true\s*\}\s*\)/,
  'Resume path must preserve caption history',
);

console.log('Recording caption Pause→Resume continuity gate passed.');
