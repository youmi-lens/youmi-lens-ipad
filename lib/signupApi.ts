import { API_BASE_URL } from './config';

/**
 * Backend calls for the verification-code-first Create Profile flow.
 *
 * The Supabase Auth account is created server-side only after the emailed
 * 8-digit code is verified — these helpers never call Supabase signUp.
 */

export type SignupApiResult =
  | { ok: true }
  | { ok: false; message: string; emailExists: boolean };

async function postSignupJson(path: string, body: object): Promise<SignupApiResult> {
  if (!API_BASE_URL) {
    return { ok: false, message: 'Account creation is temporarily unavailable.', emailExists: false };
  }
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string; message?: string }
      | null;

    if (response.ok && payload?.ok) return { ok: true };
    return {
      ok: false,
      message: payload?.message ?? `Request failed (HTTP ${response.status}).`,
      emailExists: payload?.error === 'email_exists',
    };
  } catch {
    return {
      ok: false,
      message: 'Network error. Please check your connection and try again.',
      emailExists: false,
    };
  }
}

/** Step 1: email an 8-digit verification code. Does not create an account. */
export function sendSignupCode(email: string, username: string): Promise<SignupApiResult> {
  return postSignupJson('/api/auth/send-signup-code', { email, username });
}

/** Step 2: verify the code; the backend then creates the account + profile. */
export function verifySignupCodeAndCreateUser(input: {
  username: string;
  email: string;
  password: string;
  code: string;
}): Promise<SignupApiResult> {
  return postSignupJson('/api/auth/verify-signup-code-and-create-user', input);
}
