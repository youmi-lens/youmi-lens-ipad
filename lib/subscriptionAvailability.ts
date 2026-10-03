import { boundedFetch, SUBSCRIPTION_FETCH_TIMEOUT_MS } from './boundedFetch';
import { boundedPaymentTask } from './boundedPaymentTask';
import { API_BASE_URL } from './config';
import { SUBSCRIPTION_PRODUCTS, type SubscriptionPlan } from './subscriptionProducts';
import type { SubscriptionCatalog } from './subscriptionCore';

export type SubscriptionAvailability = {
  productId: string;
  purchasable: boolean;
  tier: string;
  environment: string;
  reason?: string | null;
};

export async function fetchSubscriptionAvailability(): Promise<SubscriptionAvailability[]> {
  if (!API_BASE_URL) throw new Error('Subscription availability is unavailable');
  return boundedPaymentTask(async () => {
    const response = await boundedFetch(`${API_BASE_URL}/api/iap/subscriptions/availability`, { method: 'GET' });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true || !Array.isArray(payload.products)) {
      throw new Error('Subscription availability is unavailable');
    }
    return payload.products;
  }, SUBSCRIPTION_FETCH_TIMEOUT_MS, 'subscription_availability');
}

export function canPurchaseSubscription(plan: SubscriptionPlan, catalog: SubscriptionCatalog,
  availability: SubscriptionAvailability[] | null, masterEnabled = true): boolean {
  return masterEnabled && Boolean(catalog[plan]) && availability?.some((item) =>
    item.productId === SUBSCRIPTION_PRODUCTS[plan].productId && item.environment === 'Production' && item.purchasable === true) === true;
}
