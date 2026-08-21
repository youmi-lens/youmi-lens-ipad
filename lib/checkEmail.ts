import { API_BASE_URL } from './config';
import { normalizeEmail } from './authSignup';

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
  | { ok: true; exists: boolean; status?: 'registered' | 'pending' }
  | { ok: false; message: string };

const CHECK_FAILED_MESSAGE =
  'Could not verify whether this email is available. Please try again.';
const NETWORK_FAILED_MESSAGE =
  'Could not connect. Please check your network and try again.';
const RETRY_DELAY_MS = 900;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof Error) {
    return /network request failed|networkerror|failed to fetch|load failed/i.test(error.message);
  }
  return false;
}

async function requestEmailCheck(email: string): Promise<CheckEmailResult> {
  const response = await fetch(`${API_BASE_URL}/api/auth/check-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: normalizeEmail(email) }),
  });
  const payload = (await response.json().catch(() => null)) as {
    exists?: boolean;
    status?: string;
  } | null;
  if (response.ok && payload && typeof payload.exists === 'boolean') {
    const status = payload.status === 'registered' || payload.status === 'pending' ? payload.status : undefined;
    return { ok: true, exists: payload.exists, status };
  }
  return { ok: false, message: CHECK_FAILED_MESSAGE };
}

export async function checkEmailExists(email: string): Promise<CheckEmailResult> {
  if (!API_BASE_URL) {
    return { ok: false, message: 'Account creation is temporarily unavailable.' };
  }

  try {
    return await requestEmailCheck(email);
  } catch (error) {
    if (!isTransientNetworkError(error)) {
      return { ok: false, message: CHECK_FAILED_MESSAGE };
    }
  }

  await sleep(RETRY_DELAY_MS);

  try {
    return await requestEmailCheck(email);
  } catch {
    return { ok: false, message: NETWORK_FAILED_MESSAGE };
  }
}
