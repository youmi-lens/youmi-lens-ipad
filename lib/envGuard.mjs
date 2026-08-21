/**
 * Development environment isolation guard.
 *
 * A paused staging project once caused the Development Client to be pointed at
 * PRODUCTION Supabase, risking destructive dev writes against real user data.
 * This guard makes that impossible to do silently: a `__DEV__` build that
 * resolves to the production project fails loudly at startup instead of
 * quietly reading and writing production.
 *
 * It is `__DEV__`-only by contract — release / TestFlight / App Store builds
 * (`isDev === false`) are never affected, so production ships unchanged.
 */

/** The production project ref. A dev build must never resolve to this. */
export const PRODUCTION_SUPABASE_REF = 'lbwsrnjbiayepshrdult';

/** Extract the project ref from a Supabase URL (`https://<ref>.supabase.co`). */
export function supabaseRefFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/https?:\/\/([a-z0-9]{16,})\.supabase\.co/i);
  return m ? m[1] : null;
}

/**
 * Extract the ref from a LEGACY anon/service JWT key (`eyJ...`) by decoding its
 * payload `.ref`. New publishable/secret keys (`sb_publishable_…`, `sb_secret_…`)
 * do not embed the ref, so this returns null for them — that is fine; the URL
 * check below is the primary guard.
 */
export function refFromLegacyJwtKey(key) {
  if (typeof key !== 'string' || !key.startsWith('eyJ')) return null;
  const parts = key.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const ref = JSON.parse(json).ref;
    return typeof ref === 'string' ? ref : null;
  } catch {
    return null;
  }
}

/**
 * Throw (only in dev) if the resolved Supabase environment is production, or if
 * a legacy key's project ref contradicts the URL (a config mix-up).
 *
 * @param {{ url?: string|null, key?: string|null, isDev?: boolean }} input
 */
export function assertDevNotProduction({ url, key, isDev } = {}) {
  if (!isDev) return; // never affect release/TestFlight/App Store builds

  const urlRef = supabaseRefFromUrl(url);
  const keyRef = refFromLegacyJwtKey(key);

  if (urlRef === PRODUCTION_SUPABASE_REF) {
    throw new Error(
      '[env-guard] Development build is pointed at PRODUCTION Supabase ' +
        `(${PRODUCTION_SUPABASE_REF}). Refusing to start. Set EXPO_PUBLIC_SUPABASE_URL ` +
        'to the staging project in .env.development.local.',
    );
  }
  if (keyRef === PRODUCTION_SUPABASE_REF) {
    throw new Error(
      '[env-guard] Development build is using a PRODUCTION Supabase key. ' +
        'Refusing to start. Use the staging publishable key.',
    );
  }
  if (urlRef && keyRef && urlRef !== keyRef) {
    throw new Error(
      `[env-guard] Supabase URL project (${urlRef}) does not match the key project ` +
        `(${keyRef}). Refusing to start on a mixed configuration.`,
    );
  }
}
