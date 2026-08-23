import {
  ErrorCode,
  deepLinkToSubscriptionsIOS,
  endConnection,
  fetchProducts,
  finishTransaction,
  getAvailablePurchases,
  initConnection,
  isEligibleForIntroOfferIOS,
  purchaseErrorListener,
  purchaseUpdatedListener,
  requestPurchase,
  syncIOS,
  type ProductSubscription,
  type Purchase,
} from 'expo-iap';
import { Platform } from 'react-native';

import { API_BASE_URL } from './config';
import { boundedFetch, isBoundedFetchTimeout } from './boundedFetch';
import { logIap } from './iapLog';
import type { BackendEntitlement, EntitlementResponse } from './purchases';
import {
  chooseAvailablePlan,
  normalizeSubscriptionCatalog,
  shouldFinishSubscriptionTransaction,
  isUuid,
  type SubscriptionCatalog,
} from './subscriptionCore';
import {
  LEGACY_STUDENT_ACCESS_PRODUCT_IDS,
  SUBSCRIPTION_GROUP_ID,
  SUBSCRIPTION_PRODUCTS,
  SUBSCRIPTION_PRODUCT_IDS,
  isSubscriptionProductId,
  productIdForPlan,
  type SubscriptionPlan,
} from './subscriptionProducts';

export type SubscriptionResultCode =
  | 'success'
  | 'cancelled'
  | 'pending'
  | 'purchase_in_progress'
  | 'product_unavailable'
  | 'sign_in_required'
  | 'backend_verification_failed'
  | 'already_linked'
  | 'expired'
  | 'revoked'
  | 'offline'
  | 'verify_timeout'
  | 'storekit_error';

export type SubscriptionResult = {
  ok: boolean;
  code: SubscriptionResultCode;
  message: string;
  entitlement?: BackendEntitlement | null;
};

export type SubscriptionRestoreResult = SubscriptionResult & {
  restoredCount?: number;
};

type VerifyResponse = {
  ok?: boolean;
  granted?: boolean;
  reason?: string | null;
  error?: string | null;
  entitlement?: BackendEntitlement | null;
  restoredCount?: number;
  activeRestoredCount?: number;
  alreadyLinked?: boolean;
  verifiedTransactionIds?: string[];
};

const PURCHASE_TIMEOUT_MS = 120_000;
const ALL_RESTORABLE_IDS = new Set<string>([
  ...SUBSCRIPTION_PRODUCT_IDS,
  ...LEGACY_STUDENT_ACCESS_PRODUCT_IDS,
]);

function purchaseToken(purchase: Purchase): string | null {
  return purchase.purchaseToken && purchase.purchaseToken.length > 0 ? purchase.purchaseToken : null;
}

function transactionId(purchase: Purchase): string | null {
  return typeof purchase.transactionId === 'string' ? purchase.transactionId : purchase.id || null;
}

function originalTransactionId(purchase: Purchase): string | null {
  return 'originalTransactionIdentifierIOS' in purchase && typeof purchase.originalTransactionIdentifierIOS === 'string'
    ? purchase.originalTransactionIdentifierIOS
    : null;
}

function result(code: SubscriptionResultCode, message?: string): SubscriptionResult {
  const defaults: Record<SubscriptionResultCode, string> = {
    success: 'Student Access is active.',
    cancelled: 'Purchase cancelled.',
    pending: 'Purchase is pending. Access will update after Apple completes it.',
    purchase_in_progress: 'A purchase is already in progress.',
    product_unavailable: 'This subscription is not available from the App Store right now.',
    sign_in_required: 'Sign in before subscribing.',
    backend_verification_failed: 'The purchase could not be verified. Restore Purchases before trying again.',
    already_linked: 'This Apple subscription is linked to another Youmi Lens account.',
    expired: 'The subscription has expired.',
    revoked: 'The subscription was refunded or revoked.',
    offline: 'Network unavailable. Check your connection and try again.',
    verify_timeout:
      'Purchase verification is taking longer than expected. You will not be charged again. Please refresh access or restore purchases.',
    storekit_error: 'The Apple purchase could not be completed. Please try again.',
  };
  return { ok: code === 'success', code, message: message ?? defaults[code] };
}

async function fetchJson<T>(url: string, accessToken: string, init?: RequestInit): Promise<{ status: number; payload: T }> {
  // Bounded: a hung backend can no longer leave the Subscribe spinner spinning
  // forever. On timeout boundedFetch rejects with BoundedFetchTimeoutError,
  // which callers map to a recoverable `verify_timeout` result.
  const response = await boundedFetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
  });
  return { status: response.status, payload: (await response.json().catch(() => ({}))) as T };
}

class SubscriptionService {
  private connected = false;
  private catalog: SubscriptionCatalog = { monthly: null, annual: null };
  private loadPromise: Promise<SubscriptionCatalog> | null = null;
  private purchaseInFlight = false;
  private updateSubscription: { remove: () => void } | null = null;
  private errorSubscription: { remove: () => void } | null = null;
  private pending: { resolve: (purchase: Purchase) => void; reject: (error: Error) => void } | null = null;

  private async connect() {
    if (Platform.OS !== 'ios') throw new Error('Subscriptions are available on iPad.');
    if (this.connected) return;
    await initConnection();
    this.connected = true;
    this.updateSubscription = purchaseUpdatedListener((purchase) => {
      if (!isSubscriptionProductId(purchase.productId)) return;
      const pending = this.pending;
      this.pending = null;
      pending?.resolve(purchase);
    });
    this.errorSubscription = purchaseErrorListener((error) => {
      const pending = this.pending;
      this.pending = null;
      const normalized = new Error(error?.message || 'StoreKit purchase failed');
      normalized.name = String(error?.code ?? 'storekit_error');
      pending?.reject(normalized);
    });
  }

  /**
   * Whether the current Apple ID is eligible for the subscription group's
   * introductory offer. FAILS CLOSED: any throw, rejection, or unexpected
   * value resolves to `false` — the Plans UI must never advertise a trial it
   * isn't sure about. This is purely a UI-advisory signal; it is never on
   * the purchase path (see `purchase()` below, unchanged) and its failure
   * can never block or alter a purchase — Apple's own purchase sheet is the
   * actual source of truth and re-validates eligibility independently.
   */
  async getIntroOfferEligibility(): Promise<boolean> {
    if (Platform.OS !== 'ios') return false;
    try {
      await this.connect();
      const eligible = await isEligibleForIntroOfferIOS(SUBSCRIPTION_GROUP_ID);
      return eligible === true;
    } catch (error) {
      logIap('IAP_INTRO_ELIGIBILITY_FAILED', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async loadProducts(force = false): Promise<SubscriptionCatalog> {
    if (!force && (this.catalog.monthly || this.catalog.annual)) return this.catalog;
    if (!force && this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      await this.connect();
      const products = await fetchProducts({ skus: [...SUBSCRIPTION_PRODUCT_IDS], type: 'subs' });
      this.catalog = normalizeSubscriptionCatalog((products ?? []) as ProductSubscription[], SUBSCRIPTION_PRODUCTS);
      return this.catalog;
    })();
    try {
      return await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  async purchase(plan: SubscriptionPlan, accessToken: string | null, accountId: string | null): Promise<SubscriptionResult> {
    if (!accessToken || !isUuid(accountId)) return result('sign_in_required');
    if (!API_BASE_URL) return result('offline');
    if (this.purchaseInFlight) return result('purchase_in_progress');
    this.purchaseInFlight = true;
    logIap('IAP_PURCHASE_START', productIdForPlan(plan));
    try {
      const catalog = await this.loadProducts();
      const availablePlan = chooseAvailablePlan(plan, catalog);
      if (availablePlan !== plan || !catalog[plan]) return result('product_unavailable');
      const purchase = await this.requestWithTimeout(plan, accountId);
      if (purchase.purchaseState === 'pending') return result('pending');
      logIap('IAP_VERIFY_START');
      return await this.verify(purchase, accessToken);
    } catch (error) {
      return this.mapError(error);
    } finally {
      this.pending = null;
      this.purchaseInFlight = false;
      logIap('IAP_PURCHASE_FINISH');
    }
  }

  private requestWithTimeout(plan: SubscriptionPlan, appAccountToken: string): Promise<Purchase> {
    const requestedProductId = productIdForPlan(plan);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (kind: 'resolve' | 'reject', value: Purchase | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending = null;
        if (kind === 'resolve') resolve(value as Purchase);
        else reject(value as Error);
      };
      const timer = setTimeout(() => {
        const error = new Error('StoreKit timed out');
        error.name = 'storekit_timeout';
        finish('reject', error);
      }, PURCHASE_TIMEOUT_MS);
      this.pending = {
        resolve: (purchase) => finish('resolve', purchase),
        reject: (error) => finish('reject', error),
      };
      // expo-iap delivers the purchase outcome through purchaseUpdatedListener /
      // purchaseErrorListener — NOT requestPurchase's return value. Keeping a
      // single authoritative completion path (the listeners + the 120s bound)
      // prevents the "dispatched payload" from double-resolving and short-
      // circuiting the real transaction.
      requestPurchase({
        type: 'subs',
        request: {
          apple: {
            sku: requestedProductId,
            appAccountToken,
            andDangerouslyFinishTransactionAutomatically: false,
          },
        },
      }).catch((error) => finish('reject', error instanceof Error ? error : new Error(String(error))));
    });
  }

  private async verify(purchase: Purchase, accessToken: string): Promise<SubscriptionResult> {
    const signedTransactionInfo = purchaseToken(purchase);
    if (!signedTransactionInfo) return result('backend_verification_failed');
    let response: { status: number; payload: VerifyResponse };
    try {
      response = await fetchJson<VerifyResponse>(`${API_BASE_URL}/api/iap/apple/verify`, accessToken, {
        method: 'POST',
        body: JSON.stringify({
          platform: 'ios',
          signedTransactionInfo,
          transactionId: transactionId(purchase),
          originalTransactionId: originalTransactionId(purchase),
        }),
      });
    } catch (error) {
      logIap('IAP_VERIFY_RESULT', isBoundedFetchTimeout(error) ? 'timeout' : 'network');
      return isBoundedFetchTimeout(error) ? result('verify_timeout') : result('offline');
    }
    const payload = response.payload ?? {};
    if (shouldFinishSubscriptionTransaction(payload)) {
      await finishTransaction({ purchase, isConsumable: false });
    }
    if (response.status >= 200 && response.status < 300 && payload.ok && payload.granted) {
      return { ...result('success'), entitlement: payload.entitlement ?? null };
    }
    if (payload.error === 'iap_already_linked') return result('already_linked');
    if (payload.reason === 'expired') return result('expired');
    if (payload.reason === 'revoked' || payload.reason === 'refunded') return result('revoked');
    return result('backend_verification_failed');
  }

  async restore(accessToken: string | null): Promise<SubscriptionRestoreResult> {
    if (!accessToken) return result('sign_in_required');
    if (!API_BASE_URL) return result('offline');
    try {
      await this.connect();
      await syncIOS();
      const purchases = ((await getAvailablePurchases({ onlyIncludeActiveItemsIOS: false })) as Purchase[] | null) ?? [];
      const eligible = purchases.filter((purchase) => ALL_RESTORABLE_IDS.has(purchase.productId) && purchaseToken(purchase));
      const response = await fetchJson<VerifyResponse>(`${API_BASE_URL}/api/iap/restore`, accessToken, {
        method: 'POST',
        body: JSON.stringify({
          platform: 'ios',
          purchases: eligible.map((purchase) => ({
            signedTransactionInfo: purchaseToken(purchase),
            transactionId: transactionId(purchase),
            originalTransactionId: originalTransactionId(purchase),
          })),
        }),
      });
      const payload = response.payload ?? {};
      const verifiedIds = new Set(payload.verifiedTransactionIds ?? []);
      for (const purchase of eligible) {
        const id = transactionId(purchase);
        if (id && verifiedIds.has(id)) {
          await finishTransaction({
            purchase,
            isConsumable: purchase.productId === LEGACY_STUDENT_ACCESS_PRODUCT_IDS[0],
          });
        }
      }
      if (payload.alreadyLinked) return { ...result('already_linked'), restoredCount: payload.restoredCount ?? 0 };
      if (payload.entitlement?.active) {
        return { ...result('success'), entitlement: payload.entitlement, restoredCount: payload.restoredCount ?? 0 };
      }
      if (payload.entitlement?.status === 'expired') return { ...result('expired'), restoredCount: payload.restoredCount ?? 0 };
      if (payload.entitlement?.status === 'revoked' || payload.entitlement?.status === 'refunded') {
        return { ...result('revoked'), restoredCount: payload.restoredCount ?? 0 };
      }
      return { ...result('backend_verification_failed', 'No active purchase was found for this Apple Account.'), restoredCount: payload.restoredCount ?? 0 };
    } catch (error) {
      return this.mapError(error);
    }
  }

  async getEntitlement(accessToken: string | null): Promise<EntitlementResponse | null> {
    if (!accessToken || !API_BASE_URL) return null;
    try {
      const response = await fetchJson<EntitlementResponse>(`${API_BASE_URL}/api/iap/entitlement`, accessToken, { method: 'GET' });
      return response.status >= 200 && response.status < 300 ? response.payload : null;
    } catch (error) {
      logIap('IAP_ENTITLEMENT_REFRESH', isBoundedFetchTimeout(error) ? 'timeout' : 'error');
      return null;
    }
  }

  async manageSubscriptions(): Promise<void> {
    await this.connect();
    await deepLinkToSubscriptionsIOS();
  }

  private mapError(error: unknown): SubscriptionResult {
    if (isBoundedFetchTimeout(error)) return result('verify_timeout');
    const name = error instanceof Error ? error.name.toLowerCase() : '';
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (name === ErrorCode.UserCancelled || name.includes('cancel') || message.includes('cancel')) return result('cancelled');
    if (name === ErrorCode.Pending || name === ErrorCode.DeferredPayment) return result('pending');
    if ([ErrorCode.NetworkError, ErrorCode.RemoteError, ErrorCode.ServiceError, ErrorCode.ServiceDisconnected, ErrorCode.ServiceTimeout].includes(name as ErrorCode)) return result('offline');
    logIap('subscription purchase error', name || 'unknown');
    return result('storekit_error');
  }

  cleanup() {
    this.updateSubscription?.remove();
    this.errorSubscription?.remove();
    this.updateSubscription = null;
    this.errorSubscription = null;
    if (this.connected) void endConnection().catch(() => {});
    this.connected = false;
    this.catalog = { monthly: null, annual: null };
  }
}

export const subscriptionService = new SubscriptionService();
