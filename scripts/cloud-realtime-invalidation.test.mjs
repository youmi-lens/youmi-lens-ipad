import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createCloudRealtimeInvalidator } from '../lib/cloudRealtimeInvalidation.mjs';

let passed = 0;
const check = async (label, fn) => { await fn(); passed += 1; console.log(`  ok  ${label}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

await check('event burst is coalesced into one active and one trailing canonical refresh', async () => {
  let starts = 0;
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  const invalidator = createCloudRealtimeInvalidator(async () => {
    starts += 1;
    if (starts === 1) await first;
  });
  invalidator.invalidate();
  invalidator.invalidate();
  invalidator.invalidate();
  await flush();
  assert.equal(starts, 1);
  release();
  await flush();
  await flush();
  assert.equal(starts, 2);
});

await check('a failed refresh keeps the invalidator usable', async () => {
  let calls = 0;
  const invalidator = createCloudRealtimeInvalidator(async () => {
    calls += 1;
    if (calls === 1) throw new Error('offline');
  });
  invalidator.invalidate();
  await flush();
  invalidator.invalidate();
  await flush();
  assert.equal(calls, 2);
});

await check('dispose suppresses queued work and later invalidations', async () => {
  let calls = 0;
  const invalidator = createCloudRealtimeInvalidator(async () => { calls += 1; });
  invalidator.dispose();
  invalidator.invalidate();
  await flush();
  assert.equal(calls, 0);
});

const store = read('../lib/store.tsx');
await check('the store subscribes once per account to both tables and only invalidates', async () => {
  assert.match(store, /\.channel\(`cloud-library:\$\{currentUserId\}`\)/);
  assert.match(store, /table: 'courses', filter: userFilter/);
  assert.match(store, /table: 'recordings', filter: userFilter/);
  assert.match(store, /\(\) => invalidator\.invalidate\(\)/);
  assert.match(store, /status === 'SUBSCRIBED'\) invalidator\.invalidate\(\)/);
  assert.match(store, /supabase\.removeChannel\(channel\)/);
  const realtime = store.slice(store.indexOf('// Realtime is deliberately'), store.indexOf('// Hydrate only'));
  assert.doesNotMatch(realtime, /setCourses\(/);
  assert.doesNotMatch(realtime, /setLectures\(/);
});

console.log(`\ncloud realtime invalidation: ${passed} checks passed`);
