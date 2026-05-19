import { API_BASE_URL } from './config';

/**
 * Checks whether an email already has a Youmi Lens account via the backend
 * /api/auth/check-email endpoint (a server-side, service-role Supabase Auth
 * lookup).
 *
 * Create Profile must run this BEFORE supabase.auth.signUp: with email
 * enumeration protection on, signUp returns a fake success for an existing
 * email, so the pre-check is what reliably blocks duplicate accounts.
 */
export type CheckEmailResult =
  | { ok: true; exists: boolean }
  | { ok: false; message: string };

const CHECK_FAILED_MESSAGE =
  'Could not verify whether this email is available. Please try again.';

export async function checkEmailExists(email: string): Promise<CheckEmailResult> {
  if (!API_BASE_URL) {
    return { ok: false, message: 'Account creation is temporarily unavailable.' };
  }
  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/check-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const payload = (await response.json().catch(() => null)) as { exists?: boolean } | null;
    if (response.ok && payload && typeof payload.exists === 'boolean') {
      return { ok: true, exists: payload.exists };
    }
    return { ok: false, message: CHECK_FAILED_MESSAGE };
  } catch {
    return { ok: false, message: CHECK_FAILED_MESSAGE };
  }
}
