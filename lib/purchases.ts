/**
 * Plans + purchase service abstraction for Youmi Lens.
 *
 * The current implementation is a LOCAL MOCK so Xcode-installed development
 * builds can exercise the upgrade UI without uploading anything to App Store
 * Connect. It persists the "subscribed" tier in user-scoped AsyncStorage.
 *
 * To switch to real App Store purchases later, write a second class that
 * satisfies the PurchaseService interface (backed by StoreKit / react-native-iap)
 * and replace `purchaseService` with that instance. No screen needs to change.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

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

export type PurchaseResult =
  | { ok: true; planId: PlanId }
  | { ok: false; reason: string };

export type RestoreResult =
  | { ok: true; planId: PlanId }
  | { ok: false; reason: string };

/**
 * Purchase / subscription service contract. A real StoreKit implementation
 * must satisfy the same shape so screens never need to branch on mode.
 */
export interface PurchaseService {
  /** 'mock' while no real StoreKit is wired in. UIs show a "test mode" notice. */
  readonly mode: 'mock' | 'real';
  getPlans(): Plan[];
  getActivePlan(userId: string | null): Promise<PlanId>;
  purchase(userId: string | null, planId: PlanId): Promise<PurchaseResult>;
  restore(userId: string | null): Promise<RestoreResult>;
}

const scopedActivePlanKey = (userId: string) => `youmi.plans.activePlan.v1.${userId}`;

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

/** Active service singleton — swap to a real StoreKit-backed impl when ready. */
export const purchaseService: PurchaseService = new MockPurchaseService();
