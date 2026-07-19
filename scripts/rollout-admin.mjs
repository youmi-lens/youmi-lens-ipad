#!/usr/bin/env node
/**
 * Operator tool for per-user native recorder rollout.
 *
 * Dry-run by default: nothing is written unless --commit is passed. Requires a
 * service-role credential supplied through the environment; no secret and no
 * user identifier is ever committed to this repository.
 *
 *   export SUPABASE_URL=...            # project URL
 *   export SUPABASE_SERVICE_ROLE_KEY=...  # service role, operator machine only
 *
 *   node scripts/rollout-admin.mjs inspect --user <uuid>
 *   node scripts/rollout-admin.mjs enable  --user <uuid> --cohort internal --expires 2026-08-01
 *   node scripts/rollout-admin.mjs disable --user <uuid>
 *   node scripts/rollout-admin.mjs revoke  --user <uuid>     # kill switch, keeps the row
 *   ... add --commit to actually write.
 *
 * The service-role key bypasses RLS. Never place it in .env, the app bundle, or
 * any EXPO_PUBLIC_* variable.
 */
const COHORTS = ['disabled', 'internal', 'limited_beta'];
const ACTIONS = ['inspect', 'enable', 'disable', 'revoke'];
const TABLE = 'recording_engine_rollout';

function parseArgs(argv) {
  const [action, ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { action, flags };
}

/** Never print a full user id in operator output; it is an identifier. */
export function redactSubject(userId) {
  if (typeof userId !== 'string' || userId.length < 8) return 'unknown';
  return `${userId.slice(0, 8)}…`;
}

/** Builds the row for a write, or an error string. Pure, so it is testable. */
export function buildRolloutUpdate(action, flags, now = new Date()) {
  const userId = typeof flags.user === 'string' ? flags.user.trim() : '';
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return { error: 'A --user <uuid> is required.' };

  const cohort = flags.cohort ?? (action === 'enable' ? 'internal' : 'disabled');
  if (!COHORTS.includes(cohort)) {
    return { error: `Unknown cohort '${cohort}'. Expected one of: ${COHORTS.join(', ')}` };
  }

  let expiresAt = null;
  if (typeof flags.expires === 'string') {
    const parsed = Date.parse(flags.expires);
    if (!Number.isFinite(parsed)) return { error: `Could not parse --expires '${flags.expires}'.` };
    if (parsed <= now.getTime()) return { error: '--expires must be in the future.' };
    expiresAt = new Date(parsed).toISOString();
  }

  if (action === 'enable') {
    return {
      row: {
        user_id: userId,
        engine: 'nativeDurable',
        enabled: true,
        cohort,
        kill_switch: false,
        expires_at: expiresAt,
        updated_at: now.toISOString(),
      },
    };
  }
  if (action === 'disable') {
    return {
      row: {
        user_id: userId,
        engine: 'legacy',
        enabled: false,
        cohort: 'disabled',
        kill_switch: false,
        expires_at: null,
        updated_at: now.toISOString(),
      },
    };
  }
  if (action === 'revoke') {
    return {
      row: {
        user_id: userId,
        engine: 'legacy',
        enabled: false,
        cohort: 'disabled',
        kill_switch: true,
        expires_at: null,
        updated_at: now.toISOString(),
      },
    };
  }
  return { error: `Unsupported action '${action}'.` };
}

async function main() {
  const { action, flags } = parseArgs(process.argv.slice(2));

  if (!action || !ACTIONS.includes(action)) {
    console.error(`Usage: node scripts/rollout-admin.mjs <${ACTIONS.join('|')}> --user <uuid> [--cohort internal] [--expires ISO] [--commit]`);
    process.exit(1);
  }

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const commit = flags.commit === true;

  if (action === 'inspect' || !commit) {
    const preview = action === 'inspect' ? null : buildRolloutUpdate(action, flags);
    if (preview?.error) {
      console.error(`error: ${preview.error}`);
      process.exit(1);
    }
    console.log(`action:  ${action}`);
    console.log(`subject: ${redactSubject(flags.user)}`);
    if (preview?.row) {
      const { user_id: _omitted, ...safe } = preview.row;
      console.log(`change:  ${JSON.stringify(safe)}`);
    }
    if (!commit && action !== 'inspect') {
      console.log('\nDRY RUN — nothing was written. Re-run with --commit to apply.');
      console.log('Rollback: node scripts/rollout-admin.mjs disable --user <uuid> --commit');
      console.log(`Effective within the client cache TTL (15 minutes); no rebuild required.`);
      return;
    }
  }

  if (!url || !serviceRoleKey) {
    console.error('\nerror: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for remote access.');
    console.error('These are operator credentials. Never commit them or expose them via EXPO_PUBLIC_*.');
    process.exit(1);
  }

  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

  if (action === 'inspect') {
    const { data, error } = await admin
      .from(TABLE)
      .select('engine, enabled, cohort, kill_switch, rollout_revision, expires_at, updated_at')
      .eq('user_id', flags.user)
      .maybeSingle();
    if (error) {
      console.error(`error: ${error.message}`);
      process.exit(1);
    }
    console.log(data ? JSON.stringify(data, null, 2) : 'no rollout record — this user is on legacy');
    return;
  }

  const built = buildRolloutUpdate(action, flags);
  if (built.error) {
    console.error(`error: ${built.error}`);
    process.exit(1);
  }

  const { error } = await admin.from(TABLE).upsert(built.row, { onConflict: 'user_id' });
  if (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
  console.log(`applied ${action} for ${redactSubject(flags.user)}`);
  console.log('Takes effect within 15 minutes (client cache TTL), or on next app launch.');
  console.log(`Rollback: node scripts/rollout-admin.mjs disable --user <uuid> --commit`);
}

// Only run when invoked directly, so the pure helpers stay importable by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
