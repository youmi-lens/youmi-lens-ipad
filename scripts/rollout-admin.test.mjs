import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { buildRolloutUpdate, redactSubject } from './rollout-admin.mjs';

const USER = '0f9a1b2c-3d4e-5f60-7182-93a4b5c6d7e8';
const NOW = new Date('2026-07-19T12:00:00Z');

// --- Operator tool behaviour -------------------------------------------------

const enabled = buildRolloutUpdate('enable', { user: USER, cohort: 'internal' }, NOW);
assert.equal(enabled.row.engine, 'nativeDurable');
assert.equal(enabled.row.enabled, true);
assert.equal(enabled.row.kill_switch, false);
assert.equal(enabled.row.cohort, 'internal');

const disabled = buildRolloutUpdate('disable', { user: USER }, NOW);
assert.equal(disabled.row.enabled, false);
assert.equal(disabled.row.engine, 'legacy');

// Revoke keeps the row (auditable) but trips the kill switch.
const revoked = buildRolloutUpdate('revoke', { user: USER }, NOW);
assert.equal(revoked.row.kill_switch, true);
assert.equal(revoked.row.enabled, false);

// Validation fails closed.
assert.match(buildRolloutUpdate('enable', {}, NOW).error, /--user/);
assert.match(buildRolloutUpdate('enable', { user: 'not-a-uuid' }, NOW).error, /--user/);
assert.match(buildRolloutUpdate('enable', { user: USER, cohort: 'everyone' }, NOW).error, /Unknown cohort/);
assert.match(buildRolloutUpdate('enable', { user: USER, expires: 'nope' }, NOW).error, /--expires/);
assert.match(buildRolloutUpdate('enable', { user: USER, expires: '2020-01-01' }, NOW).error, /future/);

const expiring = buildRolloutUpdate('enable', { user: USER, expires: '2026-08-01T00:00:00Z' }, NOW);
assert.equal(expiring.row.expires_at, '2026-08-01T00:00:00.000Z');

// Operator output must not print a full identifier.
assert.equal(redactSubject(USER), '0f9a1b2c…');
assert.ok(!redactSubject(USER).includes(USER));
assert.equal(redactSubject(undefined), 'unknown');

// --- The tool must not leak secrets or identities ---------------------------

const tool = await readFile(new URL('./rollout-admin.mjs', import.meta.url), 'utf8');
assert.doesNotMatch(tool, /eyJ[A-Za-z0-9_-]{10,}/, 'no JWT/key literal is committed');
assert.doesNotMatch(tool, /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, 'no email is committed');
assert.doesNotMatch(tool, /EXPO_PUBLIC_[A-Z_]*SERVICE/, 'the service role is never a public env var');
assert.match(tool, /process\.env\.SUPABASE_SERVICE_ROLE_KEY/, 'credentials come from the environment');
assert.match(tool, /DRY RUN/, 'writes are dry-run by default');
assert.match(tool, /Rollback:/, 'operator output includes rollback instructions');

// --- Migration and RLS review ------------------------------------------------

const migration = await readFile(
  new URL('../supabase/migrations/20260719_recording_engine_rollout.sql', import.meta.url),
  'utf8',
);

assert.match(migration, /NOT DEPLOYED/, 'the migration is explicitly marked undeployed');
assert.match(migration, /enable row level security/i, 'RLS is enabled');
assert.match(migration, /force row level security/i, 'RLS applies even to the table owner');
assert.match(migration, /for select\s+to authenticated\s+using \(auth\.uid\(\) = user_id\)/i,
  'users may read only their own row');
assert.match(migration, /revoke all on public\.recording_engine_rollout from anon, authenticated/i,
  'least privilege: all rights revoked before granting');
assert.match(migration, /grant select on public\.recording_engine_rollout to authenticated/i,
  'only SELECT is granted to clients');

// There must be no client-writable policy: with RLS on, absent policies deny.
assert.doesNotMatch(migration, /for (insert|update|delete)/i,
  'no insert/update/delete policy may exist — users must not enroll themselves');
assert.doesNotMatch(migration, /grant (insert|update|delete|all)[^;]*to (authenticated|anon)/i,
  'no write privilege may be granted to client roles');

// Constraints keep malformed rows out of the table.
assert.match(migration, /check \(engine in \('legacy', 'nativeDurable'\)\)/, 'engine is constrained');
assert.match(migration, /check \(cohort in \('disabled', 'internal', 'limited_beta'\)\)/, 'cohort is constrained');
assert.match(migration, /on delete cascade/, 'rollout rows disappear with the user');

// The table must hold no sensitive data.
for (const forbidden of ['email', 'transcript', 'audio', 'purchase', 'entitlement', 'ip_address', 'device_id']) {
  assert.doesNotMatch(migration, new RegExp(`^\\s*${forbidden}\\b`, 'im'), `'${forbidden}' must not be a column`);
}

const rollback = await readFile(
  new URL('../supabase/migrations/20260719_recording_engine_rollout.rollback.sql', import.meta.url),
  'utf8',
);
assert.match(rollback, /drop table if exists public\.recording_engine_rollout/i, 'rollback removes the table');
assert.match(rollback, /recoverable/i, 'rollback documents that durable audio is unaffected');

console.log('Rollout admin, migration, and RLS tests passed.');
