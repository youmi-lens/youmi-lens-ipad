import { boundedFetch, isBoundedFetchTimeout } from './boundedFetch';
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
  studentPassActive?: boolean;
  studentPassExpiry?: string | null;
  effectivePlanType?: string;
  quota?: {
    monthly_minutes?: number | null;
    daily_minutes?: number | null;
    max_recording_minutes?: number;
    max_live_minutes?: number;
    recordings_per_day?: number;
    processing_jobs_per_day?: number;
  };
  entitlement?: {
    active: boolean;
    status?: 'active' | 'expired' | 'revoked' | 'refunded' | 'none' | string | null;
    productId: string | null;
    planType?: string | null;
    startsAt?: string | null;
    expiresAt: string | null;
    autoRenewStatus?: boolean | null;
    originalTransactionId?: string | null;
    latestTransactionId?: string | null;
    subscriptionGroupId?: string | null;
    revocationAt?: string | null;
    lastVerifiedAt?: string | null;
    source?: string | null;
    revoked?: boolean;
    currentEntitlement?: {
      productId: string;
      planType?: string | null;
      startsAt: string;
      expiresAt: string;
      status: string;
    } | null;
    latestEntitlement?: {
      productId: string;
      planType?: string | null;
      startsAt: string;
      expiresAt: string;
      status: string;
    } | null;
  };
  studentPass?: {
    productId: string;
    isPurchasable: boolean;
    salesEndAt: string | null;
  };
  maxRecordingsPerDay?: number;
  maxProcessingJobsPerDay?: number;
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

const STUDENT_PASS_PRODUCT_ID = 'com.aydenz.youmilensipad.studentbasic30d';

export function normalizePlanStatus(plan: PlanStatus, nowMs = Date.now()): PlanStatus {
  const expiry = plan.studentPassExpiry ?? plan.entitlement?.expiresAt ?? null;
  const expired = expiry !== null && Number.isFinite(Date.parse(expiry)) && Date.parse(expiry) <= nowMs;
  const revoked = plan.entitlement?.revoked || plan.entitlement?.revocationAt ||
    ['revoked', 'refunded'].includes(plan.entitlement?.status ?? '');
  if (expired || revoked) {
    const subscriptionTier = plan.planType === 'student_pass';
    return {
      ...plan, studentPassActive: false,
      ...(subscriptionTier ? { planType: 'public_trial', displayName: 'Student Access' } : {}),
      ...(plan.entitlement ? { entitlement: { ...plan.entitlement, active: false,
        status: revoked ? plan.entitlement.status || 'revoked' : 'expired' } } : {}),
    };
  }
  // The backend has already applied admin precedence. Never relabel that plan.
  if (plan.studentPassActive !== true || ['admin', 'developer'].includes(plan.planType)) return plan;

  const quota = plan.quota;

  return {
    ...plan,
    planType: plan.effectivePlanType || 'student_pass',
    displayName: 'Student Basic',
    entitlement: {
      ...plan.entitlement,
      active: true,
      status: plan.entitlement?.status || 'active',
      productId: plan.entitlement?.productId ?? STUDENT_PASS_PRODUCT_ID,
      planType: plan.entitlement?.planType ?? 'student_pass',
      expiresAt: expiry,
      revoked: false,
    },
    monthlyMinutesLimit: quota?.monthly_minutes ?? plan.monthlyMinutesLimit,
    minutesLimit: quota?.monthly_minutes ?? plan.minutesLimit,
    dailyMinutesLimit: quota?.daily_minutes ?? plan.dailyMinutesLimit,
    maxRecordingMinutes: quota?.max_recording_minutes ?? plan.maxRecordingMinutes,
    maxLiveSessionMinutes: quota?.max_live_minutes ?? plan.maxLiveSessionMinutes,
    maxRecordingsPerDay: quota?.recordings_per_day ?? plan.maxRecordingsPerDay,
    maxProcessingJobsPerDay:
      quota?.processing_jobs_per_day ?? plan.maxProcessingJobsPerDay,
  };
}

/**
 * Map a backend plan type / display name to a neutral, App-Store-safe access
 * label for the UI. The backend may still return historical labels such as
 * "Free Beta", "Student Beta", or tier names (Basic/Plus/Pro); none of those
 * price/beta/trial-flavored strings may ever reach a user-visible surface.
 * Every recognized account becomes one of three calm labels, and anything
 * unrecognized falls back to the safe default "Student Access".
 */
export function safeAccessLabel(
  planType?: string | null,
  displayName?: string | null,
): string {
  const type = (planType ?? '').toLowerCase();
  const name = (displayName ?? '').toLowerCase();

  if (type === 'admin' || type === 'developer' || name.includes('developer')) {
    return 'Developer';
  }
  if (type === 'core_tester' || name.includes('core tester') || name.includes('extended')) {
    return 'Extended Access';
  }
  if (type === 'student_pass' || name.includes('student pass') || name.includes('student basic')) {
    return 'Student Basic';
  }
  // public_trial, student_basic/plus/pro, any "Free"/"Beta"/"Trial" historical
  // label, or anything unrecognized → the neutral student-facing label.
  return 'Student Access';
}

/**
 * Fetch the signed-in user's live plan from the backend. Throws with a
 * user-safe message on any failure so the caller can show an error state.
 */
export async function fetchPlanStatus(accessToken: string | null | undefined): Promise<PlanStatus> {
  if (!API_BASE_URL) throw new Error('Account status is unavailable.');
  if (!accessToken) throw new Error('Sign in to view your account.');

  let response: Response;
  try {
    response = await boundedFetch(`${API_BASE_URL}/api/quota/status`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (error) {
    // A hung plan/status fetch must not keep a foreground refresh spinning;
    // it fails fast and the caller keeps the last-known (possibly active) plan.
    if (isBoundedFetchTimeout(error)) {
      throw new Error('Account status is taking longer than expected. Please try again.');
    }
    throw new Error('Network unavailable. Check your connection and try again.');
  }

  const payload = (await response.json().catch(() => null)) as QuotaStatusResponse | null;

  if (!response.ok || !payload?.ok || !payload.plan) {
    if (response.status === 401) throw new Error('Your session has expired. Sign in again.');
    throw new Error('Account status could not be refreshed. Please try again.');
  }

  return normalizePlanStatus(payload.plan);
}
