import type { SubscriptionPlan } from './subscriptionProducts';

export type StoreSubscriptionLike = {
  id: string;
  displayName?: string | null;
  title?: string | null;
  displayPrice: string;
  subscriptionPeriodNumberIOS?: string | null;
  subscriptionPeriodUnitIOS?: string | null;
  /**
   * Apple's introductory-offer fields (StoreKit 2 via expo-iap). Purely
   * additive — carried through normalization unchanged so the Plans screen
   * can decide whether to advertise the offer. This layer does NOT interpret
   * eligibility; it only preserves what StoreKit reported for the product.
   */
  introductoryPriceIOS?: string | null;
  introductoryPricePaymentModeIOS?: string | null;
  introductoryPriceNumberOfPeriodsIOS?: string | null;
  introductoryPriceSubscriptionPeriodIOS?: unknown;
};

export type LoadedSubscriptionProduct = {
  plan: SubscriptionPlan;
  productId: string;
  displayName: string;
  displayPrice: string;
  periodCount: number;
  periodUnit: 'month' | 'year';
  available: true;
  /** Raw StoreKit introductory-offer fields — see StoreSubscriptionLike. */
  introductoryPriceIOS: string | null;
  introductoryPricePaymentModeIOS: string | null;
  introductoryPriceNumberOfPeriodsIOS: string | null;
  introductoryPriceSubscriptionPeriodIOS: unknown;
};

export type SubscriptionCatalog = Record<SubscriptionPlan, LoadedSubscriptionProduct | null>;

export function normalizeSubscriptionCatalog(
  products: StoreSubscriptionLike[],
  definitions: Record<SubscriptionPlan, {
    plan: SubscriptionPlan;
    productId: string;
    expectedPeriodUnitIOS: 'month' | 'year';
  }>,
): SubscriptionCatalog {
  const catalog: SubscriptionCatalog = { monthly: null, annual: null };
  for (const product of products) {
    const entry = Object.values(definitions).find((candidate) => candidate.productId === product.id);
    if (!entry) continue;
    const rawUnit = product.subscriptionPeriodUnitIOS?.toLowerCase();
    const unit = rawUnit === 'year' ? 'year' : rawUnit === 'month' ? 'month' : entry.expectedPeriodUnitIOS;
    const count = Number(product.subscriptionPeriodNumberIOS ?? '1');
    catalog[entry.plan] = {
      plan: entry.plan,
      productId: product.id,
      displayName: product.displayName || product.title || `Student Access ${entry.plan}`,
      displayPrice: product.displayPrice,
      periodCount: Number.isFinite(count) && count > 0 ? count : 1,
      periodUnit: unit,
      available: true,
      introductoryPriceIOS: product.introductoryPriceIOS ?? null,
      introductoryPricePaymentModeIOS: product.introductoryPricePaymentModeIOS ?? null,
      introductoryPriceNumberOfPeriodsIOS: product.introductoryPriceNumberOfPeriodsIOS ?? null,
      introductoryPriceSubscriptionPeriodIOS: product.introductoryPriceSubscriptionPeriodIOS ?? null,
    };
  }
  return catalog;
}

export type BackendVerificationLike = {
  ok?: boolean;
  granted?: boolean;
  reason?: string | null;
  error?: string | null;
};

export function shouldFinishSubscriptionTransaction(payload: BackendVerificationLike): boolean {
  if (payload.ok && payload.granted) return true;
  if (payload.ok && ['expired', 'revoked', 'refunded', 'duplicate'].includes(payload.reason ?? '')) return true;
  if (payload.reason === 'transaction_already_processed' || payload.error === 'iap_transaction_already_processed') return true;
  if (payload.error === 'iap_already_linked' || payload.error === 'iap_deleted_account_binding') return true;
  return false;
}

export function chooseAvailablePlan(
  selected: SubscriptionPlan,
  catalog: SubscriptionCatalog,
): SubscriptionPlan | null {
  if (catalog[selected]) return selected;
  if (catalog.annual) return 'annual';
  if (catalog.monthly) return 'monthly';
  return null;
}

/**
 * True when this product's OWN StoreKit fields describe a free-trial
 * introductory offer. This is necessary but NOT sufficient to advertise a
 * trial — it says nothing about whether the current Apple ID is eligible.
 * Eligibility is a live, per-subscription-group native query (see
 * `lib/subscriptions.ts`), not something this pure layer can determine.
 */
export function isFreeTrialPaymentMode(product: LoadedSubscriptionProduct | null): boolean {
  return product?.introductoryPricePaymentModeIOS === 'free-trial';
}

/**
 * The single, explicit rule for whether to advertise "1 month free" for a
 * product: BOTH the product's own offer mode is 'free-trial' AND the current
 * Apple ID is eligible for it. Never infer trial availability from price
 * text (e.g. "$0.00") or from the product name.
 */
export function isTrialAvailable(product: LoadedSubscriptionProduct | null, eligible: boolean): boolean {
  return eligible === true && isFreeTrialPaymentMode(product);
}

export function isUuid(value: string | null | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}
