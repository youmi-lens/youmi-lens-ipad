import { API_BASE_URL } from './config';

/**
 * Live plan + quota for the Settings screen and Access page, returned by
 * GET /api/quota/status. Mirrors the backend's normalized, secret-free shape.
 * Usage fields are absent for unlimited (Developer/admin) plans.
 *
 * Quota is account-level (Supabase user_id) and shared across iPad and Mac —
 * usage on one platform reduces the values reported here on the other.
 */
export type PlanStatus = {
  planType: string;
  displayName: string;
  status: 'active' | 'suspended';
  unlimited: boolean;
  maxRecordingsPerDay?: number;
  recordingsUsedToday?: number;
  recordingsRemainingToday?: number;
  maxRecordingMinutes?: number;
  maxLiveSessionMinutes?: number;
  totalTrialMinutesLimit?: number | null;
  monthlyMinutesLimit?: number | null;
  extraMinutesBalance?: number;
  minutesUsed?: number;
  minutesLimit?: number | null;
  minutesRemaining?: number | null;
  /** Per-UTC-day billable-minute cap (null = no daily cap / unlimited). */
  dailyMinutesLimit?: number | null;
  /** Billable minutes used since UTC day start. */
  dailyMinutesUsed?: number;
  /** Daily minutes remaining (null when dailyMinutesLimit is null). */
  dailyMinutesRemaining?: number | null;
};

type QuotaStatusResponse = {
  ok?: boolean;
  plan?: PlanStatus;
  message?: string;
  error?: string;
};

/**
 * Fetch the signed-in user's live plan from the backend. Throws with a
 * user-safe message on any failure so the caller can show an error state.
 */
export async function fetchPlanStatus(accessToken: string | null | undefined): Promise<PlanStatus> {
  if (!API_BASE_URL) throw new Error('Missing API base URL.');
  if (!accessToken) throw new Error('Sign in to view your plan.');

  const response = await fetch(`${API_BASE_URL}/api/quota/status`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const payload = (await response.json().catch(() => null)) as QuotaStatusResponse | null;

  if (!response.ok || !payload?.ok || !payload.plan) {
    throw new Error(
      payload?.message ?? payload?.error ?? `Plan request failed (HTTP ${response.status}).`,
    );
  }

  return payload.plan;
}
