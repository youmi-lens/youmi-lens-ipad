import { guestIapSupabase, isGuestIapClientConfigured } from './guestIapClient';

export type GuestIapIdentity = { accessToken: string; accountId: string };

export type GuestIapUpgradeInitiateResult =
  | { ok: true }
  | { ok: false; reason: 'not_signed_in' | 'unavailable' | 'failed'; message: string };

export type GuestIapUpgradeVerifyResult =
  | { ok: true; accountId: string }
  | { ok: false; reason: 'invalid_code' | 'unavailable' | 'failed'; message: string };

/**
 * Ensure a guest-IAP anonymous identity exists on the ISOLATED client (see
 * lib/guestIapClient.ts) and return its access token + UUID — the exact shape
 * `subscriptionService.purchase`/`.restore` already accept, so those functions
 * are reused completely unchanged.
 *
 * Reuses a persisted anonymous session if one already exists (so a relaunch
 * preserves the SAME identity, and therefore the same entitlement binding);
 * only creates a new one on first use. Returns `null` — never a fabricated
 * token — when anonymous sign-in is unavailable (env not configured, or the
 * project has Anonymous Sign-Ins disabled), so a caller must show a real
 * "purchase unavailable" state rather than silently proceeding.
 */
export async function ensureGuestIapIdentity(): Promise<GuestIapIdentity | null> {
  if (!isGuestIapClientConfigured) return null;

  const { data: existing } = await guestIapSupabase.auth.getSession();
  if (existing.session?.access_token && existing.session.user?.id) {
    return { accessToken: existing.session.access_token, accountId: existing.session.user.id };
  }

  const { data, error } = await guestIapSupabase.auth.signInAnonymously();
  if (error || !data.session?.access_token || !data.session.user?.id) {
    console.warn('[guestIap] anonymous sign-in unavailable', error?.message ?? 'no session returned');
    return null;
  }
  return { accessToken: data.session.access_token, accountId: data.session.user.id };
}

/** True only when a guest-IAP identity has already been created on this device. */
export async function hasGuestIapIdentity(): Promise<boolean> {
  if (!isGuestIapClientConfigured) return false;
  const { data } = await guestIapSupabase.auth.getSession();
  return Boolean(data.session?.user?.id);
}

/**
 * Step 1 of the optional later account-link flow (App Review 5.1.1(v) §5):
 * upgrade the CURRENT guest-IAP anonymous session into a permanent one, IN
 * PLACE. This is Supabase's own anonymous-user-upgrade mechanism
 * (`auth.updateUser({ email })` on an anonymous session) — it keeps the exact
 * same `auth.users.id`, which is the only reason the already-bound entitlement
 * (backend requires `appAccountToken === the verifying user's id`, see
 * `assertSubscriptionIdentity` in server/iapSubscriptions.mjs) keeps working
 * with ZERO backend change. The project requires email confirmation
 * (mailer_autoconfirm: false on both staging and production), so this sends a
 * verification code exactly like the app's existing signup flow; the upgrade
 * only completes once `verifyGuestIapUpgrade` confirms it.
 *
 * Deliberately NOT the app's normal Sign Up screen — that creates a brand-new,
 * unrelated MAIN-client account with a different UUID, which the backend's
 * appAccountToken binding would then reject for this transaction (see
 * `detectGuestIapAccountConflict` below for that case).
 */
export async function initiateGuestIapUpgrade(email: string, password: string): Promise<GuestIapUpgradeInitiateResult> {
  if (!isGuestIapClientConfigured) return { ok: false, reason: 'unavailable', message: 'Guest purchase identity is not available.' };

  const { data: session } = await guestIapSupabase.auth.getSession();
  if (!session.session?.user?.id) {
    return { ok: false, reason: 'not_signed_in', message: 'No guest purchase to link yet.' };
  }

  const { error } = await guestIapSupabase.auth.updateUser({ email, password });
  if (error) return { ok: false, reason: 'failed', message: error.message };
  return { ok: true };
}

/** Step 2: confirm the upgrade with the emailed code. Same UUID throughout. */
export async function verifyGuestIapUpgrade(email: string, code: string): Promise<GuestIapUpgradeVerifyResult> {
  if (!isGuestIapClientConfigured) return { ok: false, reason: 'unavailable', message: 'Guest purchase identity is not available.' };

  const { data, error } = await guestIapSupabase.auth.verifyOtp({ email, token: code, type: 'email_change' });
  if (error) return { ok: false, reason: 'invalid_code', message: error.message };
  const accountId = data.session?.user?.id ?? data.user?.id;
  if (!accountId) return { ok: false, reason: 'failed', message: 'Could not confirm the linked account.' };
  return { ok: true, accountId };
}

export type GuestIapAccountConflict = {
  /** True when the signed-in MAIN account's UUID differs from the entitlement's guest-IAP UUID. */
  conflict: boolean;
  guestAccountId: string | null;
  mainAccountId: string | null;
};

/**
 * §5 requirement: "If sign-in with an already-existing permanent account
 * creates an ownership conflict, stop and surface a deliberate link/migration
 * flow instead of bypassing security." This is that check — pure, so the UI
 * can call it before ever attempting to reuse a guest entitlement under a
 * different, pre-existing account. It never transfers anything; it only
 * detects whether the two identities differ.
 */
export function detectGuestIapAccountConflict(guestAccountId: string | null, mainAccountId: string | null): GuestIapAccountConflict {
  return {
    conflict: Boolean(guestAccountId && mainAccountId && guestAccountId !== mainAccountId),
    guestAccountId,
    mainAccountId,
  };
}
