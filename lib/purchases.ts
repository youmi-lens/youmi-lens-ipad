/**
 * Plans + purchase service abstraction for Youmi Lens.
 *
 * Two implementations live here:
 *
 *  - `MockPurchaseService` — local-only, persists the "subscribed" tier in
 *    user-scoped AsyncStorage. Used so Xcode-installed development builds can
 *    exercise the Plans UI without going through the App Store.
 *
 *  - `RealPurchaseService` — backed by `expo-iap` (StoreKit 2). Used only when
 *    `EXPO_PUBLIC_USE_REAL_IAP=true`. Talks to Apple, surfaces localized prices,
 *    drives the system purchase sheet, and finishes transactions locally so the
 *    StoreKit queue never gets stuck. It does NOT change the user's effective
 *    plan in the app — that still flows from `/api/quota/status` (Settings card).
 *    Backend receipt verification is a separate phase.
 *
 * The Plans/Settings screens depend only on the `PurchaseService` interface and
 * never branch on which implementation is active.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ExpoIap from 'expo-iap';

export type PlanId = 'free' | 'basic' | 'plus' | 'pro';

export type Plan = {
  id: PlanId;
  /** App Store product id (omitted for the Free tier). */
  productId?: string;
  name: string;
  /** Display price string shown in the UI. The real price comes from the App Store. */
  priceLabel: string;
  /** Underlying USD amount, for sorting / future comparisons. */
  priceUsd: number;
  minutesPerMonth: number;
  /** Short marketing description shown under the plan name. */
  blurb: string;
  features: string[];
};

export const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    priceLabel: '$0',
    priceUsd: 0,
    minutesPerMonth: 20,
    blurb: '',
    features: [
      '20 minutes per month',
      'Live captions',
      'AI transcripts and summaries within free quota',
      'Cloud-backed lecture history',
    ],
  },
  {
    // App Store product id (not shown in UI): com.aydenz.youmilensipad.basic.monthly
    id: 'basic',
    productId: 'com.aydenz.youmilensipad.basic.monthly',
    name: 'Basic',
    priceLabel: '$4.99',
    priceUsd: 4.99,
    minutesPerMonth: 200,
    blurb: 'Good for occasional lectures and short courses.',
    features: [
      '200 minutes per month',
      'Live captions',
      'AI transcripts and summaries',
      'Cloud-backed lecture history',
    ],
  },
  {
    // App Store product id (not shown in UI): com.aydenz.youmilensipad.plus.monthly
    id: 'plus',
    productId: 'com.aydenz.youmilensipad.plus.monthly',
    name: 'Plus',
    priceLabel: '$9.99',
    priceUsd: 9.99,
    minutesPerMonth: 600,
    blurb: 'Best for regular students.',
    features: [
      '600 minutes per month',
      'Live captions',
      'AI transcripts and summaries',
      'Cloud-backed lecture history',
      'Priority AI processing',
    ],
  },
  {
    // App Store product id (not shown in UI): com.aydenz.youmilensipad.pro.monthly
    id: 'pro',
    productId: 'com.aydenz.youmilensipad.pro.monthly',
    name: 'Pro',
    priceLabel: '$19.99',
    priceUsd: 19.99,
    minutesPerMonth: 1500,
    blurb: 'Best for heavy lecture use and graduate-level workloads.',
    features: [
      '1,500 minutes per month',
      'Live captions',
      'AI transcripts and summaries',
      'Cloud-backed lecture history',
      'Priority AI processing',
    ],
  },
];

export function planById(id: PlanId): Plan {
  return PLANS.find((p) => p.id === id) ?? PLANS[0];
}

/**
 * Tier ordering for resolving "which plan is currently active" when StoreKit
 * reports multiple Youmi Lens subscriptions at once. This happens routinely
 * during upgrades within the same subscription group, and in local StoreKit
 * testing where stale transactions can linger across runs. We always show the
 * user the highest tier they own.
 */
const PLAN_PRIORITY: Record<PlanId, number> = {
  free: 0,
  basic: 1,
  plus: 2,
  pro: 3,
};

/** Pick the highest-priority Youmi plan whose productId is in `activeProductIds`. */
function highestActivePlan(activeProductIds: Set<string>): PlanId {
  let best: PlanId = 'free';
  for (const plan of PLANS) {
    if (!plan.productId) continue;
    if (!activeProductIds.has(plan.productId)) continue;
    if (PLAN_PRIORITY[plan.id] > PLAN_PRIORITY[best]) best = plan.id;
  }
  return best;
}

export type PurchaseResult =
  | {
      ok: true;
      planId: PlanId;
      /**
       * True when the purchase succeeded (the StoreKit sheet completed) but
       * Apple's active-subscription query did not report the new product
       * within our poll window. Surfaces a softer success message in the UI.
       * Phase 1 / __DEV__ only — backend verification (Phase 2) will replace
       * this whole code path.
       */
      pendingAppleSync?: boolean;
    }
  | { ok: false; reason: string; canceled?: boolean };

export type RestoreResult =
  | { ok: true; planId: PlanId }
  | { ok: false; reason: string };

/** Map of plan id → localized App Store display price (e.g. "$4.99"). */
export type LocalizedPrices = Partial<Record<PlanId, string>>;

/**
 * Purchase / subscription service contract. The mock and the real StoreKit
 * implementation both satisfy this shape so screens never need to branch on mode.
 */
export interface PurchaseService {
  /**
   * 'mock' for the local AsyncStorage stub, 'real' for the StoreKit-backed
   * implementation. The Plans UI uses this to decide whether to show a
   * "test mode" notice; nothing else should branch on it.
   */
  readonly mode: 'mock' | 'real';
  getPlans(): Plan[];
  getActivePlan(userId: string | null): Promise<PlanId>;
  purchase(userId: string | null, planId: PlanId): Promise<PurchaseResult>;
  restore(userId: string | null): Promise<RestoreResult>;
  /**
   * Optional. Real implementations fetch the localized App Store price for each
   * configured product id. Returns an empty object when no real prices are
   * available — callers should fall back to the hardcoded `priceLabel`.
   */
  getLocalizedPrices?(): Promise<LocalizedPrices>;
}

const scopedActivePlanKey = (userId: string) => `youmi.plans.activePlan.v1.${userId}`;
const scopedRealIapLatestPlanKey = (userId: string) =>
  `youmi.plans.realIap.latestPurchasedPlan.v1.${userId}`;

function isPlanId(value: unknown): value is PlanId {
  return value === 'free' || value === 'basic' || value === 'plus' || value === 'pro';
}

class MockPurchaseService implements PurchaseService {
  readonly mode = 'mock' as const;

  getPlans(): Plan[] {
    return PLANS;
  }

  async getActivePlan(userId: string | null): Promise<PlanId> {
    if (!userId) return 'free';
    try {
      const raw = await AsyncStorage.getItem(scopedActivePlanKey(userId));
      if (raw && isPlanId(raw)) return raw;
      return 'free';
    } catch {
      return 'free';
    }
  }

  async purchase(userId: string | null, planId: PlanId): Promise<PurchaseResult> {
    if (!userId) return { ok: false, reason: 'Sign in to subscribe.' };
    if (!isPlanId(planId)) return { ok: false, reason: 'Unknown plan.' };
    try {
      await AsyncStorage.setItem(scopedActivePlanKey(userId), planId);
      return { ok: true, planId };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'Could not save the selected plan.',
      };
    }
  }

  async restore(userId: string | null): Promise<RestoreResult> {
    if (!userId) return { ok: false, reason: 'Sign in to restore purchases.' };
    const planId = await this.getActivePlan(userId);
    return { ok: true, planId };
  }
}

/**
 * StoreKit-backed implementation (Phase 1). Talks to Apple via expo-iap.
 *
 * Lifecycle: a single connection is opened lazily on first use and reused for
 * the rest of the app session — `endConnection()` is intentionally not called
 * (the OS reclaims resources when the process dies, and tearing down would kill
 * the purchase listeners that resolve in-flight purchases).
 *
 * The purchase flow is event-based on iOS: `requestPurchase` only kicks off the
 * system sheet; the actual result arrives through `purchaseUpdatedListener`
 * (success) or `purchaseErrorListener` (failure/cancel). This class wraps that
 * into a single promise per call by tracking one in-flight purchase at a time.
 *
 * Phase 1 boundary: we finish the StoreKit transaction locally so the queue
 * does not keep re-delivering it. We do NOT yet POST the JWS to the backend or
 * mark the user as entitled — Settings/Home continue to read the effective
 * plan from `/api/quota/status`. Backend verification is Phase 2.
 */
class RealPurchaseService implements PurchaseService {
  readonly mode = 'real' as const;

  private connectPromise: Promise<boolean> | null = null;
  private listenersAttached = false;
  private updateSub: { remove: () => void } | null = null;
  private errorSub: { remove: () => void } | null = null;
  private pending:
    | {
        productId: string;
        planId: PlanId;
        userId: string;
        resolve: (result: PurchaseResult) => void;
        /** True once `requestPurchase` resolves without throwing — i.e. Apple
         *  accepted the request and (in practice) the StoreKit sheet was
         *  confirmed. Used by the poll's fallback path. */
        requestPurchaseResolved: boolean;
        /** True once any `purchaseUpdatedListener` event has arrived for this
         *  pending purchase, even if it referenced a different productId
         *  (e.g. the OLD subscription being revoked during an upgrade). */
        receivedAnyUpdate: boolean;
      }
    | null = null;

  // Polling fallback. During a same-group subscription upgrade, expo-iap's
  // `purchaseUpdatedListener` can deliver the OLD/current subscription's
  // transaction (e.g. Basic) before — or instead of — a transaction for the
  // new product (Plus). The active set returned by `getActiveSubscriptions`
  // also takes a short moment to include the new SKU. The poll re-queries the
  // active set every POLL_INTERVAL_MS until the pending product appears, at
  // which point we resolve the purchase with the highest active tier.
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private pollAttempts = 0;
  private readonly POLL_INTERVAL_MS = 1500;
  /** ~30 seconds of polling. The global 90s `purchase` timeout still owns
   *  the absolute upper bound; the poll just gives the active set a fair
   *  window to update before we give up via the slow path. */
  private readonly POLL_MAX_ATTEMPTS = 20;

  getPlans(): Plan[] {
    return PLANS;
  }

  /**
   * Reflect what Apple thinks the user has bought, normalized to the highest
   * tier when multiple Youmi subscriptions show as active (typical during an
   * upgrade or in local StoreKit testing). The in-app effective plan still
   * comes from the backend `/api/quota/status`; this is purely the Plans-screen
   * "which card is CURRENT" signal. Returns 'free' on any error.
   */
  async getActivePlan(userId: string | null): Promise<PlanId> {
    if (!userId) return 'free';
    try {
      await this.ensureConnection();
      const activeIds = await this.fetchActiveProductIds();
      const applePlan = highestActivePlan(activeIds);
      const localPlan = __DEV__ ? await this.readLocalPurchasedPlan(userId) : null;
      const resolved =
        localPlan && PLAN_PRIORITY[localPlan] > PLAN_PRIORITY[applePlan]
          ? localPlan
          : applePlan;
      if (__DEV__) {
        console.log('[IAP] getActivePlan resolved', {
          activeIds: [...activeIds],
          applePlan,
          localPlan,
          resolved,
        });
      }
      return resolved;
    } catch (err) {
      if (__DEV__) console.warn('[IAP] getActivePlan failed', err);
      return 'free';
    }
  }

  async getLocalizedPrices(): Promise<LocalizedPrices> {
    try {
      await this.ensureConnection();
      const productIds = PLANS.map((p) => p.productId).filter(Boolean) as string[];
      if (productIds.length === 0) return {};
      const fetched = await ExpoIap.fetchProducts({ skus: productIds, type: 'subs' });
      const list = Array.isArray(fetched) ? fetched : [];
      const out: LocalizedPrices = {};
      for (const plan of PLANS) {
        if (!plan.productId) continue;
        const match = list.find((p) => p && (p as { id?: string }).id === plan.productId);
        const price = (match as { displayPrice?: string } | undefined)?.displayPrice;
        if (price) out[plan.id] = price;
      }
      if (__DEV__) {
        console.log('[IAP] fetched products', list.map((p) => (p as { id?: string }).id));
      }
      return out;
    } catch (err) {
      if (__DEV__) console.warn('[IAP] getLocalizedPrices failed', err);
      return {};
    }
  }

  async purchase(userId: string | null, planId: PlanId): Promise<PurchaseResult> {
    if (__DEV__) console.log('[IAP] purchase start', { planId, productId: planById(planId).productId });
    if (!userId) return { ok: false, reason: 'Sign in to subscribe.' };
    if (planId === 'free') {
      return { ok: false, reason: 'The Free plan does not require a purchase.' };
    }
    const plan = planById(planId);
    if (!plan.productId) {
      return { ok: false, reason: 'No App Store product is configured for this plan.' };
    }
    if (this.pending) {
      return { ok: false, reason: 'Another purchase is already in progress.' };
    }

    try {
      await this.ensureConnection();
    } catch (err) {
      return { ok: false, reason: errorMessage(err, 'Could not connect to the App Store.') };
    }

    return new Promise<PurchaseResult>((resolve) => {
      // Wrap resolve so every code path below is safe to call repeatedly: only
      // the first call wins, and we always clear the timeout + pending slot +
      // any in-flight poll.
      let settled = false;
      const settle = (result: PurchaseResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        this.stopPendingPoll('settled');
        if (this.pending === entry) this.pending = null;
        if (__DEV__) console.log('[IAP] purchase settled', { planId, result });
        resolve(result);
      };

      const entry = {
        productId: plan.productId!,
        planId,
        userId,
        resolve: settle,
        requestPurchaseResolved: false,
        receivedAnyUpdate: false,
      };
      this.pending = entry;
      if (__DEV__) console.log('[IAP] pending set', { productId: entry.productId, planId });

      // Hard timeout. Without this, a missing/malformed listener event would
      // leave the Plans screen stuck on "Processing…" indefinitely. Apple's
      // own sheet usually resolves within a couple of seconds; 90s is the
      // safety net.
      const timeoutHandle = setTimeout(() => {
        if (__DEV__) console.warn('[IAP] purchase timeout', { planId, productId: entry.productId });
        settle({
          ok: false,
          reason:
            'The purchase is taking longer than expected. Tap Restore Purchases or check Settings to verify the subscription.',
        });
      }, 90_000);

      if (__DEV__) {
        console.log('[IAP] requestPurchase called', { productId: plan.productId, planId });
      }
      try {
        void ExpoIap.requestPurchase({
          type: 'subs',
          request: { ios: { sku: plan.productId! } },
        })
          .then(() => {
            // `requestPurchase` resolving means Apple accepted the request and
            // the StoreKit sheet completed. Per expo-iap, entitlement still
            // belongs to listener/active-subscription APIs; however local
            // StoreKit upgrades can keep reporting the old tier. In __DEV__
            // Phase 1 we therefore remember the requested plan for Plans'
            // CURRENT chip only. Settings/quota remain backend truth.
            if (this.pending === entry) entry.requestPurchaseResolved = true;
            if (__DEV__) console.log('[IAP] requestPurchase resolved');
            if (__DEV__ && this.pending === entry) {
              void this.rememberLocalPurchasedPlan(userId, planId).finally(() => {
                entry.resolve({ ok: true, planId, pendingAppleSync: true });
              });
            }
          })
          .catch((err) => {
            settle({ ok: false, reason: errorMessage(err, 'Could not start the purchase.') });
          });
      } catch (err) {
        settle({ ok: false, reason: errorMessage(err, 'Could not start the purchase.') });
        return;
      }

      // Kick off the active-set poll immediately. It is idempotent — a second
      // call from `maybeResolvePending` (when a non-matching event arrives)
      // will be a no-op.
      this.startPendingPoll();
    });
  }

  async restore(userId: string | null): Promise<RestoreResult> {
    if (!userId) return { ok: false, reason: 'Sign in to restore purchases.' };
    try {
      await this.ensureConnection();
      await ExpoIap.restorePurchases();
      const activeIds = await this.fetchActiveProductIds();
      const planId = highestActivePlan(activeIds);
      if (__DEV__) {
        await this.replaceLocalPurchasedPlanFromRestore(userId, planId);
        console.log('[IAP] restore result', { activeIds: [...activeIds], planId });
      }
      return { ok: true, planId };
    } catch (err) {
      if (__DEV__) console.warn('[IAP] restore failed', err);
      return { ok: false, reason: errorMessage(err, 'Could not restore purchases.') };
    }
  }

  // ---- internals --------------------------------------------------------

  private ensureConnection(): Promise<boolean> {
    if (!this.connectPromise) {
      this.connectPromise = ExpoIap.initConnection().then((ok) => {
        // Listeners are attached only after a successful connection so we don't
        // race a not-yet-initialized native module.
        if (ok && !this.listenersAttached) this.attachListeners();
        return ok;
      });
      // If initConnection rejects, drop the cached promise so the next call retries.
      this.connectPromise.catch(() => {
        this.connectPromise = null;
      });
    }
    return this.connectPromise;
  }

  private async fetchActiveProductIds(): Promise<Set<string>> {
    const active = await ExpoIap.getActiveSubscriptions();
    return new Set((active ?? []).map((s) => s.productId));
  }

  private async readLocalPurchasedPlan(userId: string): Promise<PlanId | null> {
    try {
      const raw = await AsyncStorage.getItem(scopedRealIapLatestPlanKey(userId));
      return isPlanId(raw) && raw !== 'free' ? raw : null;
    } catch (err) {
      if (__DEV__) console.warn('[IAP] readLocalPurchasedPlan failed', err);
      return null;
    }
  }

  private async rememberLocalPurchasedPlan(userId: string, planId: PlanId): Promise<void> {
    if (planId === 'free') return;
    try {
      await AsyncStorage.setItem(scopedRealIapLatestPlanKey(userId), planId);
      if (__DEV__) console.log('[IAP] remembered local StoreKit plan', { planId });
    } catch (err) {
      if (__DEV__) console.warn('[IAP] rememberLocalPurchasedPlan failed', err);
    }
  }

  private async replaceLocalPurchasedPlanFromRestore(
    userId: string,
    planId: PlanId,
  ): Promise<void> {
    try {
      if (planId === 'free') {
        await AsyncStorage.removeItem(scopedRealIapLatestPlanKey(userId));
      } else {
        await AsyncStorage.setItem(scopedRealIapLatestPlanKey(userId), planId);
      }
      if (__DEV__) console.log('[IAP] restore synced local StoreKit plan', { planId });
    } catch (err) {
      if (__DEV__) console.warn('[IAP] replaceLocalPurchasedPlanFromRestore failed', err);
    }
  }

  /**
   * Polls Apple's active subscription set on a fixed interval. Only one poll
   * runs per pending purchase; subsequent calls are no-ops. Stops when the
   * pending product appears in the active set (resolves the purchase with the
   * highest active tier), when the pending slot clears, or when POLL_MAX_ATTEMPTS
   * is reached (the global 90s timeout in `purchase()` is still in charge of
   * surfacing the final user-facing failure message).
   */
  private startPendingPoll(): void {
    const current = this.pending;
    if (!current) return;
    if (this.pollHandle) return; // already polling

    if (__DEV__) {
      console.log('[IAP] start pending poll', {
        planId: current.planId,
        productId: current.productId,
      });
    }
    this.pollAttempts = 0;

    const tick = async () => {
      this.pollAttempts += 1;
      const c = this.pending;
      // The pending slot was cleared by some other path (success via listener,
      // user cancel, etc.). Stop quietly.
      if (!c) {
        this.stopPendingPoll('pending-cleared');
        return;
      }

      let activeIds: Set<string> = new Set();
      try {
        activeIds = await this.fetchActiveProductIds();
      } catch (err) {
        if (__DEV__) console.warn('[IAP] poll fetchActiveProductIds failed', err);
      }
      if (__DEV__) console.log('[IAP] poll active subscription ids', [...activeIds]);

      // Re-read pending in case it was cleared during the async fetch.
      if (this.pending !== c) {
        this.stopPendingPoll('pending-cleared');
        return;
      }

      if (activeIds.has(c.productId)) {
        const finalPlan = highestActivePlan(activeIds);
        if (__DEV__) console.log('[IAP] poll resolved active plan', finalPlan);
        this.stopPendingPoll('resolved');
        // `resolve` is the settle wrapper from purchase(); calling it again
        // would be a no-op, but stopPendingPoll already cleared our interval.
        c.resolve({ ok: true, planId: finalPlan });
        return;
      }

      if (this.pollAttempts >= this.POLL_MAX_ATTEMPTS) {
        if (__DEV__) console.log('[IAP] poll exhausted');
        this.stopPendingPoll('exhausted');

        // Local-fallback resolve (DEV only). In local StoreKit testing the
        // active subscription set sometimes never includes the upgraded SKU,
        // even though the user genuinely completed the sheet — verified
        // because either `requestPurchase` resolved without throwing or a
        // `purchaseUpdated` event arrived (even for the OLD product). In
        // that case it's safe to acknowledge the user's purchase locally and
        // set the `pendingAppleSync` flag so the UI can move on. In a
        // production build we keep the conservative path: do nothing here and
        // let the global 90s timeout surface "tap Restore Purchases".
        // Phase 2 backend receipt verification will make this whole branch
        // obsolete.
        if (
          __DEV__ &&
          this.pending === c &&
          (c.requestPurchaseResolved || c.receivedAnyUpdate)
        ) {
          console.log('[IAP] resolving pending by local fallback', { planId: c.planId });
          void this.rememberLocalPurchasedPlan(c.userId, c.planId).finally(() => {
            c.resolve({ ok: true, planId: c.planId, pendingAppleSync: true });
          });
        }
      }
    };

    this.pollHandle = setInterval(() => {
      void tick();
    }, this.POLL_INTERVAL_MS);
  }

  private stopPendingPoll(reason: string): void {
    if (!this.pollHandle) return;
    if (__DEV__) console.log('[IAP] stop pending poll', { reason });
    clearInterval(this.pollHandle);
    this.pollHandle = null;
    this.pollAttempts = 0;
  }

  /**
   * Called whenever a `purchaseUpdated` event arrives. Resolves the in-flight
   * purchase if either (a) the incoming productId matches what we're waiting
   * for, or (b) the pending product now shows up in Apple's active set — which
   * is how we cover the upgrade case where StoreKit may deliver the OLD
   * (revoked) subscription's transaction first instead of the new one.
   *
   * The resolved planId is computed from the highest-priority active tier so
   * the Plans screen flips CURRENT to the upgraded plan even when the listener
   * event itself referenced the old product.
   */
  private async maybeResolvePending(incomingProductId: string | undefined): Promise<void> {
    const current = this.pending;
    if (!current) return;

    let directMatch = incomingProductId === current.productId;
    let activeIds: Set<string> = new Set();
    try {
      activeIds = await this.fetchActiveProductIds();
    } catch (err) {
      if (__DEV__) console.warn('[IAP] fetchActiveProductIds failed', err);
    }
    if (__DEV__) {
      console.log('[IAP] active subscription ids after update:', [...activeIds]);
      console.log('[IAP] maybeResolvePending', {
        pendingProductId: current.productId,
        incomingProductId,
        directMatch,
        inActiveSet: activeIds.has(current.productId),
      });
    }

    if (!directMatch && !activeIds.has(current.productId)) {
      // Event was for some other product (most commonly the OLD subscription
      // during a same-group upgrade), and our target hasn't appeared in the
      // active set yet. Don't resolve — but make sure the polling fallback is
      // running so we don't depend on a future listener event that may never
      // come for our target product.
      this.startPendingPoll();
      return;
    }

    const finalPlan: PlanId = activeIds.size > 0
      ? highestActivePlan(activeIds)
      : current.planId;
    if (__DEV__) console.log('[IAP] resolved active plan:', finalPlan);

    // Guard against a race where another listener call already resolved.
    if (this.pending !== current) return;
    if (__DEV__ && finalPlan !== 'free') {
      await this.rememberLocalPurchasedPlan(current.userId, finalPlan);
    }
    current.resolve({ ok: true, planId: finalPlan });
  }

  private attachListeners() {
    if (this.listenersAttached) return;
    this.listenersAttached = true;

    this.updateSub = ExpoIap.purchaseUpdatedListener(async (purchase) => {
      const productId = (purchase as { productId?: string })?.productId;
      const transactionId = (purchase as { transactionId?: string })?.transactionId;
      if (__DEV__) console.log('[IAP] purchaseUpdated', { productId, transactionId });

      // Mark that something arrived from StoreKit for the in-flight purchase
      // — even if the productId doesn't match, this is positive evidence that
      // the sheet completed and Apple is processing the request.
      if (this.pending) this.pending.receivedAnyUpdate = true;

      // Finish the transaction locally so it is not redelivered. Phase 2 will
      // POST the JWS to the backend BEFORE finishing for receipt verification.
      try {
        await ExpoIap.finishTransaction({
          purchase: purchase as Parameters<typeof ExpoIap.finishTransaction>[0]['purchase'],
          isConsumable: false,
        });
      } catch (err) {
        if (__DEV__) console.warn('[IAP] finishTransaction failed', err);
      }

      await this.maybeResolvePending(productId);
    });

    this.errorSub = ExpoIap.purchaseErrorListener((err) => {
      const current = this.pending;
      if (!current) return;
      const canceled = err?.code === ExpoIap.ErrorCode.UserCancelled;
      if (__DEV__) console.log('[IAP] purchaseError', { code: err?.code, canceled, message: err?.message });
      current.resolve({
        ok: false,
        canceled,
        reason: canceled
          ? 'Purchase canceled.'
          : err?.message || 'The purchase could not be completed.',
      });
    });
  }
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return fallback;
}

/**
 * Pick the implementation based on the feature flag. When unset or anything
 * other than the literal string "true", the mock service is used so the app
 * stays usable in development builds without the App Store.
 */
const USE_REAL_IAP = process.env.EXPO_PUBLIC_USE_REAL_IAP === 'true';

/**
 * Bump this string whenever the IAP code changes meaningfully. It is logged at
 * module load so we can instantly tell from a device's Metro log whether the
 * running JS bundle includes the latest fix.
 */
const IAP_BUILD_VERSION = 'phase1-local-storekit-v5';

if (__DEV__) {
  console.log('[IAP] RealPurchaseService loaded version', IAP_BUILD_VERSION);
  console.log('[IAP] USE_REAL_IAP', USE_REAL_IAP);
}

export const purchaseService: PurchaseService = USE_REAL_IAP
  ? new RealPurchaseService()
  : new MockPurchaseService();
