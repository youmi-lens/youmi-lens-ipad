import {
  ErrorCode,
  ErrorCodeUtils,
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
import { AppState, Platform } from 'react-native';

import { API_BASE_URL } from './config';
import { boundedFetch, BoundedFetchTimeoutError, isBoundedFetchTimeout, SUBSCRIPTION_FETCH_TIMEOUT_MS } from './boundedFetch';
import { boundedVoidTask } from './boundedTask';
import { boundedPaymentTask, PaymentTaskTimeoutError } from './boundedPaymentTask';
import { logDiag } from './iapDiag';
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
  | 'operation_timeout'
  | 'no_purchase'
  | 'storekit_error'
  | 'presentation_unavailable';

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
const STOREKIT_OPERATION_TIMEOUT_MS = 15_000;
const STOREKIT_SYNC_TIMEOUT_MS = 30_000;
// finishTransaction is a native StoreKit bridge call with no bound of its own
// (ExpoIapModule.finishTransaction). By the time it's called here the backend
// has ALREADY granted (or definitively rejected) the entitlement, so nothing
// about correctness depends on this call finishing promptly — it only tells
// StoreKit's local queue "done". If it hangs, awaiting it unbounded would keep
// `purchaseInFlight`/`busy` stuck forever on an otherwise-complete purchase.
// A transaction that doesn't finish in time stays unfinished in the StoreKit
// queue and replays on next launch (see expo-iap finishTransaction docs) or
// gets swept up by a later restore — it is never silently dropped.
const FINISH_TRANSACTION_TIMEOUT_MS = 10_000;
// A backend ownership rejection (`iap_already_linked` / `iap_deleted_account_binding`) is a permanent verdict for that
// Apple transaction lineage and THIS Youmi account. If StoreKit hands the same transaction back on a later attempt, the
// client already knows the outcome, so it must end that attempt with the remembered result instead of waiting for the
// 120 s purchase timeout. The memory is in-process only (no persistence), keyed per account, and small and short-lived.
const OWNERSHIP_REJECTION_TTL_MS = 15 * 60 * 1000;
const OWNERSHIP_REJECTION_MAX_ENTRIES = 32;

/** Carries the remembered rejection result out of the purchase listener into `purchase()`'s normal error mapping. */
class RememberedOwnershipRejection extends Error {
  constructor(readonly rejection: SubscriptionResult) {
    super('Remembered ownership rejection');
    this.name = 'ownership_rejection_reused';
  }
}

const ALL_RESTORABLE_IDS = new Set<string>([
  ...SUBSCRIPTION_PRODUCT_IDS,
  ...LEGACY_STUDENT_ACCESS_PRODUCT_IDS,
]);

/**
 * Calls finishTransaction but never lets the caller wait on it past
 * FINISH_TRANSACTION_TIMEOUT_MS. Never rejects: a slow/failed finish is
 * logged and left for StoreKit to redeliver/replay, not surfaced as a
 * purchase failure (the purchase itself already succeeded or failed via the
 * backend verify result before this is ever called).
 */
function finishTransactionBounded(purchase: Purchase, isConsumable: boolean): Promise<void> {
  logDiag('finish_started');
  return boundedVoidTask(
    () => finishTransaction({ purchase, isConsumable }).then(() => logDiag('finish_succeeded')),
    FINISH_TRANSACTION_TIMEOUT_MS,
    () => {
      logDiag('finish_timeout');
      logIap('finishTransaction timed out; transaction left unfinished for replay/restore');
    },
    () => logDiag('finish_failed'),
  );
}

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

function normalizeStoreKitError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (error && typeof error === 'object') {
    const source = error as { code?: unknown; message?: unknown };
    const normalized = new Error(typeof source.message === 'string' ? source.message : 'StoreKit purchase failed');
    normalized.name = typeof source.code === 'string' ? source.code : 'storekit_error';
    return Object.assign(normalized, { code: source.code });
  }
  return new Error('StoreKit purchase failed');
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
    operation_timeout: 'The App Store is taking longer than expected. Please try again.',
    no_purchase: 'No active purchase was found for this Apple Account.',
    storekit_error: 'The Apple purchase could not be completed. Please try again.',
    presentation_unavailable: 'Youmi Lens could not show the Apple purchase screen right now. Please try again.',
  };
  return { ok: code === 'success', code, message: message ?? defaults[code] };
}

async function fetchJson<T>(url: string, accessToken: string, init?: RequestInit): Promise<{ status: number; payload: T }> {
  // Bounded: a hung backend can no longer leave the Subscribe spinner spinning
  // forever. On timeout boundedFetch rejects with BoundedFetchTimeoutError,
  // which callers map to a recoverable `verify_timeout` result.
  return boundedPaymentTask(async () => {
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
  }, SUBSCRIPTION_FETCH_TIMEOUT_MS, 'backend_response', () => new BoundedFetchTimeoutError('iap_backend'));
}

/** The one waiting purchase attempt (`SubscriptionService.pending`); also used as that attempt's identity. */
type PendingPurchase = {
  productId: string;
  accountId: string;
  startedAt: number;
  resolve: (purchase: Purchase) => void;
  reject: (error: Error) => void;
};

class SubscriptionService {
  private connected = false;
  private connectionPromise: Promise<void> | null = null;
  private connectionGeneration = 0;
  private catalog: SubscriptionCatalog = { monthly: null, annual: null };
  private loadPromise: Promise<SubscriptionCatalog> | null = null;
  private purchaseInFlight = false;
  private restoreInFlight = false;
  private verificationContext: { accessToken: string; accountId: string } | null = null;
  private seenTransactions = new Set<string>();
  private ownershipRejections = new Map<string, { result: SubscriptionResult; at: number }>();
  private deferredTransactions = new Map<string, Purchase>();
  private lateVerifications = new Map<string, Promise<void>>();
  private updateSubscription: { remove: () => void } | null = null;
  private errorSubscription: { remove: () => void } | null = null;
  private pending: PendingPurchase | null = null;

  private async connect() {
    if (Platform.OS !== 'ios') throw new Error('Subscriptions are available on iPad.');
    if (this.connected) return;
    if (this.connectionPromise) return this.connectionPromise;
    const generation = this.connectionGeneration;
    const connecting = (async () => {
      const initialized = await boundedPaymentTask(() => initConnection(), STOREKIT_OPERATION_TIMEOUT_MS, 'connection');
      if (!initialized || generation !== this.connectionGeneration) throw new Error('StoreKit connection unavailable');
      try {
        this.attachListeners();
        this.connected = true;
      } catch (error) {
        this.updateSubscription?.remove();
        this.errorSubscription?.remove();
        this.updateSubscription = null;
        this.errorSubscription = null;
        throw error;
      }
    })();
    this.connectionPromise = connecting;
    try {
      await connecting;
    } finally {
      if (this.connectionPromise === connecting) this.connectionPromise = null;
    }
  }

  private attachListeners() {
    this.updateSubscription = purchaseUpdatedListener((purchase) => {
      if (!isSubscriptionProductId(purchase.productId)) return;
      logDiag('purchase_update_received', { productId: purchase.productId });
      const id = transactionId(purchase);
      if (!id) return;
      if (this.seenTransactions.has(id)) {
        // Already processed once. Ignore it as a duplicate — unless it is the transaction (or lineage) this account was
        // definitively rejected for and an attempt is waiting on StoreKit: then end that attempt now with the same result.
        this.settleFromRememberedOwnershipRejection(purchase);
        return;
      }
      const pending = this.pending;
      const accountMatches = 'appAccountToken' in purchase &&
        purchase.appAccountToken?.toLowerCase() === pending?.accountId.toLowerCase();
      if (pending && purchase.productId === pending.productId && accountMatches &&
        Number.isFinite(purchase.transactionDate) && purchase.transactionDate >= pending.startedAt) {
        this.seenTransactions.add(id);
        pending?.resolve(purchase);
      } else {
        if (pending) logDiag('transaction_ignored_wrong_attempt');
        this.settleFromRememberedOwnershipRejection(purchase);
        // `pending` is the attempt that was waiting when StoreKit delivered this transaction. If its late verification
        // ends in a definitive ownership rejection, that same attempt is ended with it (see reconcileLateTransaction).
        this.reconcileLateTransaction(purchase, pending);
      }
    });
    this.errorSubscription = purchaseErrorListener((error) => {
      logDiag('purchase_error_received', { code: String(error?.code ?? 'unknown') });
      const pending = this.pending;
      if (error.productId && error.productId !== pending?.productId) return;
      this.pending = null;
      const normalized = normalizeStoreKitError(error);
      pending?.reject(normalized);
    });
  }

  private ownershipRejectionKeys(accountId: string, purchase: Purchase): string[] {
    const account = accountId.toLowerCase();
    const keys: string[] = [];
    const id = transactionId(purchase);
    const original = originalTransactionId(purchase);
    if (id) keys.push(`${account}|tx|${id}`);
    if (original) keys.push(`${account}|otx|${original}`);
    return keys;
  }

  private rememberOwnershipRejection(purchase: Purchase, accountId: string, rejection: SubscriptionResult) {
    const now = Date.now();
    for (const [key, entry] of this.ownershipRejections) {
      if (now - entry.at > OWNERSHIP_REJECTION_TTL_MS) this.ownershipRejections.delete(key);
    }
    for (const key of this.ownershipRejectionKeys(accountId, purchase)) {
      this.ownershipRejections.delete(key);
      this.ownershipRejections.set(key, { result: rejection, at: now });
    }
    while (this.ownershipRejections.size > OWNERSHIP_REJECTION_MAX_ENTRIES) {
      this.ownershipRejections.delete(this.ownershipRejections.keys().next().value!);
    }
    logDiag('ownership_rejection_remembered');
  }

  /**
   * Ends the waiting purchase attempt with a previously remembered ownership rejection. Applies only when an attempt
   * for the SAME product is pending and this exact transaction (or its original-transaction lineage) was definitively
   * rejected for the SAME account inside the TTL. It never grants anything and never touches any other duplicate.
   * When `onlyAttempt` is given, only that exact attempt may be settled (a newer attempt, or none, is left alone).
   */
  private settleFromRememberedOwnershipRejection(purchase: Purchase, onlyAttempt?: PendingPurchase | null): boolean {
    const pending = this.pending;
    if (!pending || purchase.productId !== pending.productId) return false;
    if (onlyAttempt !== undefined && pending !== onlyAttempt) return false;
    const now = Date.now();
    for (const key of this.ownershipRejectionKeys(pending.accountId, purchase)) {
      const entry = this.ownershipRejections.get(key);
      if (!entry) continue;
      if (now - entry.at > OWNERSHIP_REJECTION_TTL_MS) { this.ownershipRejections.delete(key); continue; }
      logDiag('ownership_rejection_reused');
      pending.reject(new RememberedOwnershipRejection(entry.result));
      return true;
    }
    return false;
  }

  /**
   * `attempt` is the purchase attempt that was waiting when StoreKit delivered `purchase` (null when it was delivered
   * with no attempt waiting, or replayed from the deferred set). It is used for exactly one thing: if the backend answers
   * this transaction with a definitive ownership rejection, that same attempt — same product, same account, still
   * waiting — is ended with the existing remembered result instead of waiting for StoreKit to say something else.
   * Reconciliation otherwise stays independent of the UI attempt.
   */
  private reconcileLateTransaction(purchase: Purchase, attempt: PendingPurchase | null = null) {
    logDiag('late_transaction_received');
    const id = transactionId(purchase);
    const context = this.verificationContext;
    const accountMatches = context && 'appAccountToken' in purchase &&
      purchase.appAccountToken?.toLowerCase() === context.accountId.toLowerCase();
    if (!id || !purchaseToken(purchase) || purchase.purchaseState !== 'purchased') return;
    if (!context || !accountMatches || this.restoreInFlight) {
      // Never guess an account for a paid transaction. Preserve it unfinished
      // in StoreKit for explicit restore; also retry when a matching identity
      // next becomes available in this connection.
      this.deferredTransactions.set(id, purchase);
      if (this.deferredTransactions.size > 256) {
        this.deferredTransactions.delete(this.deferredTransactions.keys().next().value!);
      }
      return;
    }
    if (this.seenTransactions.has(id)) return;
    this.seenTransactions.add(id);
    this.deferredTransactions.delete(id);
    const verification = (async () => {
      const verified = await this.verify(purchase, context.accessToken);
      // Reconcile account state independently. This never resolves, rejects,
      // or shows success for an unrelated active UI purchase attempt.
      if (verified.ok) await this.getEntitlement(context.accessToken);
      else if (attempt) this.settleFromRememberedOwnershipRejection(purchase, attempt);
    })().catch(() => {
      logDiag('verify_failed', { reason: 'late_reconciliation' });
    }).finally(() => {
      this.lateVerifications.delete(id);
    });
    this.lateVerifications.set(id, verification);
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
      const eligible = await boundedPaymentTask(() => isEligibleForIntroOfferIOS(SUBSCRIPTION_GROUP_ID), STOREKIT_OPERATION_TIMEOUT_MS, 'intro_eligibility');
      logDiag('intro_eligibility_result', { eligible: eligible === true });
      return eligible === true;
    } catch (error) {
      logIap('IAP_INTRO_ELIGIBILITY_FAILED', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async loadProducts(force = false): Promise<SubscriptionCatalog> {
    if (this.loadPromise) return this.loadPromise;
    if (!force && (this.catalog.monthly || this.catalog.annual)) return this.catalog;
    logDiag('products_load_start', {});
    const generation = this.connectionGeneration;
    const loading = (async () => {
      await this.connect();
      const products = await boundedPaymentTask(
        () => fetchProducts({ skus: [...SUBSCRIPTION_PRODUCT_IDS], type: 'subs' }),
        STOREKIT_OPERATION_TIMEOUT_MS, 'products',
      );
      if (generation !== this.connectionGeneration) throw new Error('StoreKit connection changed');
      this.catalog = normalizeSubscriptionCatalog((products ?? []) as ProductSubscription[], SUBSCRIPTION_PRODUCTS);
      for (const plan of ['monthly', 'annual'] as const) {
        const product = this.catalog[plan];
        logDiag('intro_product_fields', {
          plan,
          available: product != null,
          paymentMode: product?.introductoryPricePaymentModeIOS ?? null,
          hasIntroPrice: product?.introductoryPriceIOS != null,
          periodUnit: typeof product?.introductoryPriceSubscriptionPeriodIOS === 'string' ? product.introductoryPriceSubscriptionPeriodIOS : null,
          periodCount: product?.introductoryPriceNumberOfPeriodsIOS ?? null,
        });
      }
      logDiag('products_load_done', {});
      return this.catalog;
    })();
    this.loadPromise = loading;
    try {
      return await loading;
    } finally {
      if (this.loadPromise === loading) this.loadPromise = null;
    }
  }

  async purchase(plan: SubscriptionPlan, accessToken: string | null, accountId: string | null): Promise<SubscriptionResult> {
    if (!accessToken || !isUuid(accountId)) return result('sign_in_required');
    if (!API_BASE_URL) return result('offline');
    if (this.purchaseInFlight) return result('purchase_in_progress');
    if (this.restoreInFlight) return result('purchase_in_progress');
    this.purchaseInFlight = true;
    this.verificationContext = { accessToken, accountId };
    for (const purchase of this.deferredTransactions.values()) this.reconcileLateTransaction(purchase);
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (kind: 'resolve' | 'reject', value: Purchase | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending = null;
        if (kind === 'resolve') resolve(value as Purchase);
        else reject(value as Error);
      };

      // A purchase sheet can only ever be presented against a foreground-
      // active app. Attempting it otherwise is a known StoreKit 2 hang class:
      // the native purchase call can be left awaiting a sheet iOS never
      // actually shows, with no error and no bound on how long that takes.
      // Failing fast here — before requestPurchase is ever invoked — means
      // there is nothing native left pending to hang, and the busy state
      // clears immediately through the normal error path below.
      const appState = AppState.currentState;
      const sceneActive = appState === 'active';
      logDiag('active_scene_check', { plan, state: String(appState), allowed: sceneActive });
      if (!sceneActive) {
        const error = new Error('Youmi Lens was not in the foreground; the Apple purchase sheet was not requested.');
        error.name = 'presentation_not_active';
        finish('reject', error);
        return;
      }

      timer = setTimeout(() => {
        logDiag('purchase_timeout_fired', { plan });
        const error = new Error('StoreKit timed out');
        error.name = 'storekit_timeout';
        finish('reject', error);
      }, PURCHASE_TIMEOUT_MS);
      this.pending = {
        productId: requestedProductId,
        accountId: appAccountToken,
        startedAt: Date.now(),
        resolve: (purchase) => finish('resolve', purchase),
        reject: (error) => finish('reject', error),
      };
      logDiag('purchase_request_start', { plan });
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
      }).catch((error) => finish('reject', normalizeStoreKitError(error)));
    });
  }

  private async verify(purchase: Purchase, accessToken: string): Promise<SubscriptionResult> {
    logDiag('verify_started');
    const signedTransactionInfo = purchaseToken(purchase);
    if (!signedTransactionInfo) {
      logDiag('verify_failed', { reason: 'missing_payload' });
      return result('backend_verification_failed');
    }
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
      logDiag('verify_failed', { reason: isBoundedFetchTimeout(error) ? 'timeout' : 'network' });
      logIap('IAP_VERIFY_RESULT', isBoundedFetchTimeout(error) ? 'timeout' : 'network');
      return isBoundedFetchTimeout(error) ? result('verify_timeout') : result('offline');
    }
    const payload = response.payload ?? {};
    const httpOk = response.status >= 200 && response.status < 300;
    logDiag(httpOk && payload.ok && payload.granted ? 'verify_succeeded' : 'verify_failed');
    if ((httpOk || response.status === 403 || response.status === 409) && shouldFinishSubscriptionTransaction(payload)) {
      await finishTransactionBounded(purchase, false);
    }
    if (response.status >= 200 && response.status < 300 && payload.ok && payload.granted) {
      return { ...result('success'), entitlement: payload.entitlement ?? null };
    }
    // The account this verification belongs to (set when the purchase attempt started, or captured for late reconciliation).
    const verifyingAccountId = this.verificationContext?.accountId ?? null;
    if (payload.error === 'iap_already_linked') {
      const rejection = result('already_linked');
      if (verifyingAccountId) this.rememberOwnershipRejection(purchase, verifyingAccountId, rejection);
      return rejection;
    }
    if (payload.reason === 'expired') return result('expired');
    if (payload.reason === 'revoked' || payload.reason === 'refunded') return result('revoked');
    if (payload.error === 'iap_deleted_account_binding') {
      // Same permanent-ownership class. The result the user gets is unchanged; it is only remembered.
      const rejection = result('backend_verification_failed');
      if (verifyingAccountId) this.rememberOwnershipRejection(purchase, verifyingAccountId, rejection);
      return rejection;
    }
    return result('backend_verification_failed');
  }

  async restore(accessToken: string | null): Promise<SubscriptionRestoreResult> {
    if (!accessToken) return result('sign_in_required');
    if (!API_BASE_URL) return result('offline');
    if (this.purchaseInFlight || this.restoreInFlight) return result('purchase_in_progress');
    this.restoreInFlight = true;
    logDiag('restore_started');
    let querying = true;
    try {
      // Do not verify the same callback concurrently with an explicit restore.
      await Promise.all(this.lateVerifications.values());
      await this.connect();
      await boundedPaymentTask(() => syncIOS(), STOREKIT_SYNC_TIMEOUT_MS, 'restore_sync');
      const purchases = ((await boundedPaymentTask(
        () => getAvailablePurchases({ onlyIncludeActiveItemsIOS: false }),
        STOREKIT_OPERATION_TIMEOUT_MS, 'restore_query',
      )) as Purchase[] | null) ?? [];
      const eligible = purchases.filter((purchase) => ALL_RESTORABLE_IDS.has(purchase.productId) && purchaseToken(purchase));
      querying = false;
      logDiag('verify_started', { source: 'restore' });
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
      if (response.status < 200 || response.status >= 300 || !payload.ok) {
        logDiag('verify_failed', { source: 'restore' });
        return result('backend_verification_failed');
      }
      logDiag('restore_verified');
      const verifiedIds = new Set(payload.verifiedTransactionIds ?? []);
      for (const purchase of eligible) {
        const id = transactionId(purchase);
        if (id && verifiedIds.has(id)) {
          this.deferredTransactions.delete(id);
          await finishTransactionBounded(purchase, purchase.productId === LEGACY_STUDENT_ACCESS_PRODUCT_IDS[0]);
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
      logDiag('restore_no_purchase');
      return { ...result('no_purchase'), restoredCount: payload.restoredCount ?? 0 };
    } catch (error) {
      logDiag(querying ? 'restore_query_failed' : 'verify_failed', {
        reason: error instanceof PaymentTaskTimeoutError || isBoundedFetchTimeout(error) ? 'timeout' : 'error',
      });
      return this.mapError(error);
    } finally {
      this.restoreInFlight = false;
    }
  }

  async getEntitlement(accessToken: string | null): Promise<EntitlementResponse | null> {
    if (!accessToken || !API_BASE_URL) return null;
    logDiag('entitlement_refresh_started');
    try {
      const response = await fetchJson<EntitlementResponse>(`${API_BASE_URL}/api/iap/entitlement`, accessToken, { method: 'GET' });
      const succeeded = response.status >= 200 && response.status < 300 && response.payload?.ok;
      logDiag(succeeded ? 'entitlement_refresh_succeeded' : 'entitlement_refresh_failed');
      return succeeded ? response.payload : null;
    } catch (error) {
      logDiag('entitlement_refresh_failed');
      logIap('IAP_ENTITLEMENT_REFRESH', isBoundedFetchTimeout(error) ? 'timeout' : 'error');
      return null;
    }
  }

  async manageSubscriptions(): Promise<void> {
    await this.connect();
    await deepLinkToSubscriptionsIOS();
  }

  private mapError(error: unknown): SubscriptionResult {
    if (error instanceof RememberedOwnershipRejection) return error.rejection;
    if (error instanceof PaymentTaskTimeoutError) return result('operation_timeout');
    if (isBoundedFetchTimeout(error)) return result('verify_timeout');
    const name = error instanceof Error ? error.name.toLowerCase() : '';
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    // 4.3.1's internal cancellation helper accepts E_USER_CANCELLED, but its
    // public fromPlatformCode only maps it reliably after stripping E_.
    const platformCode = typeof code === 'string' && code.startsWith('E_') ? code.slice(2) : code;
    const nativeCode = typeof platformCode === 'string' || typeof platformCode === 'number'
      ? ErrorCodeUtils.fromPlatformCode(platformCode, 'ios') : null;
    if (nativeCode === ErrorCode.UserCancelled || name === ErrorCode.UserCancelled || name.includes('cancel') || message.includes('cancel')) {
      logDiag('purchase_cancelled');
      return result('cancelled');
    }
    if (name === 'presentation_not_active') return result('presentation_unavailable');
    if ([name, nativeCode].some((code) => code === ErrorCode.Pending || code === ErrorCode.DeferredPayment)) return result('pending');
    if ([ErrorCode.NetworkError, ErrorCode.RemoteError, ErrorCode.ServiceError, ErrorCode.ServiceDisconnected, ErrorCode.ServiceTimeout].includes((nativeCode ?? name) as ErrorCode)) return result('offline');
    logIap('subscription purchase error', name || 'unknown');
    return result('storekit_error');
  }

  cleanup() {
    this.connectionGeneration += 1;
    this.pending?.reject(new Error('StoreKit connection closed'));
    this.updateSubscription?.remove();
    this.errorSubscription?.remove();
    this.updateSubscription = null;
    this.errorSubscription = null;
    if (this.connected) void endConnection().catch(() => {});
    this.connected = false;
    this.connectionPromise = null;
    this.loadPromise = null;
    this.catalog = { monthly: null, annual: null };
    this.verificationContext = null;
    this.deferredTransactions.clear();
    this.seenTransactions.clear();
    this.ownershipRejections.clear();
  }
}

export const subscriptionService = new SubscriptionService();
