import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// diagnostics.ts is TypeScript, so the privacy boundary is verified by reading
// the allowlist and re-implementing the sanitizer contract against it. The
// allowlist is the single source of truth in both places.
const source = await readFile(new URL('../lib/recording/diagnostics.ts', import.meta.url), 'utf8');

const allowlistBlock = source.match(/const ALLOWED_FIELDS = Object\.freeze\(\[([\s\S]*?)\]\)/);
assert.ok(allowlistBlock, 'the diagnostics allowlist must be present');
const allowed = [...allowlistBlock[1].matchAll(/'([a-zA-Z]+)'/g)].map((match) => match[1]);
assert.ok(allowed.length > 0);

// --- Forbidden fields must not be in the allowlist ---------------------------

const FORBIDDEN = [
  'audio', 'waveform', 'transcript', 'caption', 'translation', 'text',
  'title', 'course', 'email', 'userId', 'user', 'sessionId', 'lectureId',
  'segmentId', 'recordingSessionId', 'path', 'filePath', 'uri', 'url',
  'token', 'accessToken', 'purchase', 'entitlement', 'plan', 'subscription',
  'timestamp', 'createdAt',
];
for (const field of FORBIDDEN) {
  assert.ok(
    !allowed.includes(field),
    `forbidden field '${field}' must never be emittable`,
  );
}

// Nothing in the allowlist may look like an identifier or free text.
for (const field of allowed) {
  assert.doesNotMatch(field, /id$|Id$|email|token|path|uri|url|text|title/i, `'${field}' looks unsafe`);
}

// --- Sanitizer contract ------------------------------------------------------

const ALLOWED = new Set(allowed);
const isEmittable = (value) =>
  typeof value === 'boolean' ||
  typeof value === 'number' ||
  (typeof value === 'string' && value.length <= 64);

function sanitize(detail) {
  const safe = {};
  if (!detail) return safe;
  for (const key of Object.keys(detail).sort()) {
    if (!ALLOWED.has(key)) continue;
    const value = detail[key];
    if (value === null || value === undefined) continue;
    if (!isEmittable(value)) continue;
    safe[key] = value;
  }
  return safe;
}

// A careless call site cannot leak content.
const hostile = {
  engine: 'nativeDurable',
  transcript: 'the mitochondria is the powerhouse of the cell',
  captionText: 'hello world',
  lectureId: 'lecture_mrrsngbrl9a61',
  recordingSessionId: '73a4f0ee-08f4-4563-8fb9-5b0354c4a756',
  email: 'someone@example.com',
  filePath: '/var/mobile/Containers/.../lecture.m4a',
  title: 'Organic Chemistry Week 4',
  entitlement: 'student_basic',
  segmentCount: 2,
};
const sanitized = sanitize(hostile);
assert.deepEqual(sanitized, { engine: 'nativeDurable', segmentCount: 2 }, 'only allowlisted fields survive');
const serialized = JSON.stringify(sanitized);
for (const secret of ['mitochondria', 'hello world', 'lecture_mrr', '73a4f0ee', 'example.com', '/var/mobile', 'Organic', 'student_basic']) {
  assert.ok(!serialized.includes(secret), `'${secret}' must not be emitted`);
}

// Oversized strings are dropped even on an allowlisted key.
assert.deepEqual(sanitize({ reason: 'x'.repeat(200) }), {}, 'long values are rejected');
assert.deepEqual(sanitize({ engine: { nested: 'object' } }), {}, 'non-scalars are rejected');
assert.deepEqual(sanitize({ segmentCount: null }), {}, 'null is dropped');
assert.deepEqual(sanitize(undefined), {});

// Deterministic output: key order is stable regardless of input order.
assert.equal(
  JSON.stringify(sanitize({ segmentCount: 1, engine: 'legacy' })),
  JSON.stringify(sanitize({ engine: 'legacy', segmentCount: 1 })),
);

// --- Duration bucketing is coarse -------------------------------------------

const bucketBlock = source.match(/export function durationBucket[\s\S]*?\n}/);
assert.ok(bucketBlock, 'durationBucket must exist');
assert.match(bucketBlock[0], /'unknown'/, 'invalid durations bucket to unknown');
assert.doesNotMatch(bucketBlock[0], /durationMillis\s*\)?\s*;?\s*$/m, 'raw duration must not be returned');
for (const bucket of ['<10s', '10-60s', '1-5m', '5-30m', '30-90m', '>90m']) {
  assert.ok(bucketBlock[0].includes(bucket), `bucket ${bucket} is defined`);
}

// --- No analytics SDK and no network ----------------------------------------

assert.doesNotMatch(source, /fetch\(|axios|XMLHttpRequest|supabase|amplitude|mixpanel|firebase|segment\.io/i,
  'diagnostics must stay local — no network, no third-party analytics');

// --- Release builds expose no developer control ------------------------------

const featureGate = await readFile(new URL('../lib/recording/featureGate.ts', import.meta.url), 'utf8');
assert.match(featureGate, /export function setDeveloperRecordingEngineOverride[\s\S]{0,160}if \(!__DEV__\) return;/,
  'the developer override setter is a no-op outside development');
assert.match(featureGate, /__DEV__ \? developerOverride : null/,
  'the developer override is never read in release');

const screen = await readFile(new URL('../app/recording.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(screen, /setDeveloperRecordingEngineOverride/,
  'no user-facing screen may toggle the recording engine');

console.log('Recording diagnostics privacy tests passed.');
