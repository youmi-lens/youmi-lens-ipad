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

/** Maps a classified reader failure to a stable, non-identifying reason code. */
const FAILURE_REASONS: Record<string, string> = {
  infrastructure_unavailable: 'rollout_infrastructure_unavailable',
  unauthorized: 'rollout_unauthorized',
  timed_out: 'rollout_timed_out',
  fetch_failed: 'rollout_fetch_failed',
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
    const reason = FAILURE_REASONS[error] ?? 'rollout_fetch_failed';
    // Never log the raw backend response — it can carry schema and request
    // details. Only the classified reason code leaves this boundary.
    logRecordingEvent(
      reason === 'rollout_infrastructure_unavailable'
        ? 'rollout_infrastructure_unavailable'
        : reason === 'rollout_timed_out'
          ? 'rollout_resolution_timed_out'
          : 'rollout_fetch_failed',
      { reason },
    );
    const result = evaluateRollout({
      killSwitch: false,
      fetch: { status: 'unavailable', reason, engine: 'legacy', cohort: null, revision: null },
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

/** Bounded so a slow or hanging request can never stall the recording screen. */
export const ROLLOUT_FETCH_TIMEOUT_MS = 4000;

/**
 * Classifies a backend failure into a stable reason code. The raw message is
 * inspected here and then discarded — it can carry schema and request details,
 * so it must never reach diagnostics or the UI.
 */
export function classifyRolloutError(message: string | null | undefined): string {
  const text = typeof message === 'string' ? message : '';
  // Table absent before the migration is deployed: expected, not an incident.
  if (/does not exist|undefined table|relation .* does not exist|schema cache|PGRST205|42P01/i.test(text)) {
    return 'infrastructure_unavailable';
  }
  if (/permission|denied|jwt|unauthor|RLS|42501/i.test(text)) return 'unauthorized';
  return 'fetch_failed';
}

function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, onTimeout: () => T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onTimeout());
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(onTimeout());
      },
    );
  });
}

async function defaultReader(userId: string): Promise<{ row: RolloutRow | null; error: string | null }> {
  const query = supabase
    .from(ROLLOUT_TABLE)
    .select('engine, enabled, cohort, expires_at, rollout_revision, kill_switch')
    .eq('user_id', userId)
    .maybeSingle()
    .then(({ data, error }) => {
      if (error) return { row: null, error: classifyRolloutError(error.message) };
      return { row: (data as RolloutRow | null) ?? null, error: null };
    });

  return withTimeout(query, ROLLOUT_FETCH_TIMEOUT_MS, () => ({ row: null, error: 'timed_out' }));
}
