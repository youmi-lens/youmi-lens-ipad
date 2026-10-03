import { useEffect, useReducer } from 'react';
import { normalizePlanStatus, type PlanStatus } from './planStatus';

/** Cached access is display-only; never keep showing an expired subscription during an outage. */
export function usePaymentStatusExpiry(plan: PlanStatus | null, refresh: () => unknown) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const expiry = plan?.studentPassExpiry ?? plan?.entitlement?.expiresAt;
  useEffect(() => {
    if (!expiry || !plan?.entitlement?.active) return;
    const target = Date.parse(expiry);
    if (!Number.isFinite(target)) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const remaining = target - Date.now();
      if (remaining <= 0) { tick(); void refresh(); return; }
      timer = setTimeout(schedule, Math.min(remaining + 1, 2_147_483_647));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [expiry, plan?.entitlement?.active, refresh]);
  return plan ? normalizePlanStatus(plan) : null;
}
