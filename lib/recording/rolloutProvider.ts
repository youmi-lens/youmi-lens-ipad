/**
 * Phase 4 — rollout provider.
 *
 * Fetches the caller's own rollout record, caches it per user, and returns a
 * normalized eligibility result. The recording policy consumes that result and
 * never talks to Supabase itself.
 *
 * The client only ever uses the anon key and can only read its own row; writes
 * are an operator action performed with a service role outside the app. See
 * docs/verification/phase-4-rollout-control.md.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { supabase, isSupabaseConfigured } from '../supabase';
import { logRecordingEvent } from './diagnostics';
import {
  ROLLOUT_CACHE_TTL_MS,
  cacheAgeBucket,
  evaluateRollout,
  parseRolloutRecord,
  readCachedRollout,
} from './rolloutPolicy.mjs';

export const ROLLOUT_TABLE = 'recording_engine_rollout';

/** Cache key is scoped by user id so entries can never leak between accounts. */
export function rolloutCacheKey(userId: string): string {
  return `youmi.recordingRollout.v1.${userId}`;
}

export type RolloutEligibility = {
  eligible: boolean;
  resolved: boolean;
  reason: string | null;
  cohort: string | null;
  revision: number | null;
  source: 'remote' | 'cache' | 'kill_switch' | 'none';
};

type RolloutRow = {
  engine?: unknown;
  enabled?: unknown;
  cohort?: unknown;
  expires_at?: unknown;
  rollout_revision?: unknown;
  kill_switch?: unknown;
};

const LEGACY_RESULT: RolloutEligibility = {
  eligible: false,
  resolved: false,
  reason: 'rollout_record_missing',
  cohort: null,
  revision: null,
  source: 'none',
};

async function readCache(userId: string, now: number) {
  try {
    const raw = await AsyncStorage.getItem(rolloutCacheKey(userId));
    if (!raw) return null;
    return readCachedRollout(JSON.parse(raw), {
      now,
      ttlMs: ROLLOUT_CACHE_TTL_MS,
      subject: userId,
    });
  } catch {
    return null;
  }
}

async function writeCache(userId: string, record: unknown, now: number): Promise<void> {
  try {
    await AsyncStorage.setItem(
      rolloutCacheKey(userId),
      JSON.stringify({
        subject: userId,
        fetchedAt: new Date(now).toISOString(),
        record,
      }),
    );
  } catch {
    // A cache write failure is never fatal: the next launch simply refetches.
  }
}

/** Clears the cached decision for one user. Call on sign-out. */
export async function clearRolloutCache(userId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(rolloutCacheKey(userId));
  } catch {
    // Best effort; an orphaned entry is rejected by its subject check anyway.
  }
}

/**
 * Resolves rollout eligibility for the signed-in user.
 *
 * Fails closed: a missing config, malformed row, network error, unauthorized
 * response or expired cache all resolve to legacy.
 */
export async function fetchRolloutEligibility(options: {
  userId: string | null;
  now?: number;
  /** Injectable for tests; defaults to the Supabase-backed reader. */
  reader?: (userId: string) => Promise<{ row: RolloutRow | null; error: string | null }>;
}): Promise<RolloutEligibility> {
  const now = options.now ?? Date.now();
  const userId = options.userId;

  // Signed out or unconfigured backend: no per-user rollout is possible.
  if (!userId || !isSupabaseConfigured) return LEGACY_RESULT;

  const cached = await readCache(userId, now);
  const reader = options.reader ?? defaultReader;

  logRecordingEvent('rollout_fetch_started', {});

  let row: RolloutRow | null = null;
  let error: string | null = null;
  try {
    const outcome = await reader(userId);
    row = outcome.row;
    error = outcome.error;
  } catch {
    error = 'unreachable';
  }

  if (error) {
    // Never log the raw backend response — it can carry request details.
    logRecordingEvent('rollout_fetch_failed', {
      reason: error === 'unauthorized' ? 'rollout_unauthorized' : 'rollout_fetch_failed',
    });
    const result = evaluateRollout({
      killSwitch: false,
      fetch: { status: 'unavailable', reason: error === 'unauthorized' ? 'rollout_unauthorized' : 'rollout_fetch_failed', engine: 'legacy', cohort: null, revision: null },
      cache: cached,
    }) as RolloutEligibility;
    if (cached) {
      logRecordingEvent(cached.status === 'expired' ? 'rollout_cache_expired' : 'rollout_cache_used', {
        cacheAgeBucket: cacheAgeBucket(cached.ageMs ?? undefined),
        expiryStatus: cached.status,
      });
    }
    return result;
  }

  const killSwitch = row?.kill_switch === true;
  const parsed = parseRolloutRecord(row, { now });

  if (row) await writeCache(userId, row, now);

  if (parsed.status === 'invalid') logRecordingEvent('rollout_invalid_config', { reason: parsed.reason ?? undefined });
  if (killSwitch) logRecordingEvent('rollout_kill_switch_applied', {});

  const result = evaluateRollout({ killSwitch, fetch: parsed, cache: cached }) as RolloutEligibility;

  logRecordingEvent('rollout_fetch_succeeded', {
    engine: result.eligible ? 'nativeDurable' : 'legacy',
    cohort: result.cohort ?? undefined,
    configRevision: result.revision ?? undefined,
    reason: result.reason ?? undefined,
  });

  return result;
}

async function defaultReader(userId: string): Promise<{ row: RolloutRow | null; error: string | null }> {
  const { data, error } = await supabase
    .from(ROLLOUT_TABLE)
    .select('engine, enabled, cohort, expires_at, rollout_revision, kill_switch')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    const unauthorized = /permission|denied|jwt|unauthor/i.test(error.message ?? '');
    return { row: null, error: unauthorized ? 'unauthorized' : 'fetch_failed' };
  }
  return { row: (data as RolloutRow | null) ?? null, error: null };
}
