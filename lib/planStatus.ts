import { API_BASE_URL } from './config';

/**
 * Live plan + quota for the Settings screen, returned by GET /api/quota/status.
 * Mirrors the backend's normalized, secret-free shape. Usage fields are absent
 * for unlimited (Developer/admin) plans.
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
  totalTrialMinutesLimit?: number | null;
  monthlyMinutesLimit?: number | null;
  extraMinutesBalance?: number;
  minutesUsed?: number;
  minutesLimit?: number | null;
  minutesRemaining?: number | null;
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
