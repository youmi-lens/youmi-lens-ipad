import {
  ErrorCode,
  endConnection,
  fetchProducts,
  finishTransaction,
  getAvailablePurchases,
  initConnection,
  purchaseErrorListener,
  purchaseUpdatedListener,
  requestPurchase,
  type Product,
  type Purchase,
} from 'expo-iap';
import { Platform } from 'react-native';

import { API_BASE_URL } from './config';
import { logIap } from './iapLog';
import type { PlanStatus } from './planStatus';

export const STUDENT_PASS_PRODUCT_ID = 'com.aydenz.youmilensipad.studentbasic30d';
export const LEGACY_STUDENT_PASS_PRODUCT_ID = 'com.aydenz.youmilensipad.studentpass30d';
export const STUDENT_PASS_PLAN_TYPE = 'student_pass';
const STUDENT_ACCESS_PRODUCT_IDS = new Set([
  STUDENT_PASS_PRODUCT_ID,
  LEGACY_STUDENT_PASS_PRODUCT_ID,
]);

export type PlanId = 'free' | 'student_pass';

export type StudentPassProduct = {
  productId: string;
  displayName: string;
  displayPrice: string;
  available: boolean;
};

export type BackendEntitlement = {
  active: boolean;
  status?: 'active' | 'expired' | 'revoked' | 'refunded' | 'none' | string | null;
  productId: string | null;
  planType?: string | null;
  startsAt?: string | null;
  expiresAt: string | null;
  revoked?: boolean;
  currentEntitlement?: BackendEntitlementSnapshot | null;
  latestEntitlement?: BackendEntitlementSnapshot | null;
};

export type BackendEntitlementSnapshot = {
  productId: string;
  planType?: string | null;
  startsAt: string;
  expiresAt: string;
  status: string;
};

export type EntitlementResponse = {
  ok: boolean;
  entitlement: BackendEntitlement;
  quotaStatus?: PlanStatus | null;
  message?: string | null;
  error?: string | null;
};

export type PurchaseResultCode =
  | 'success'
  | 'cancelled'
  | 'pending'
  | 'purchase_in_progress'
  | 'product_unavailable'
  | 'sign_in_required'
  | 'session_expired'
  | 'backend_verification_failed'
  | 'transaction_already_processed'
  | 'already_linked'
  | 'deleted_account_binding'
  | 'expired'
  | 'sales_closed'
  | 'offline'
  | 'apple_account_already_purchased'
  | 'storekit_error';

export type PurchaseResult = {
  ok: boolean;
  code: PurchaseResultCode;
  message: string;
  entitlement?: BackendEntitlement | null;
  quotaStatus?: PlanStatus | null;
};

export type RestoreResultCode =
  | 'active_restored'
  | 'expired'
  | 'revoked'
  | 'already_linked'
  | 'no_eligible_purchase'
  | 'unverified_history_unavailable'
  | 'sign_in_required'
  | 'failed';

export type RestoreResult = {
  ok: boolean;
  code: RestoreResultCode;
  message: string;
  entitlement?: BackendEntitlement | null;
  quotaStatus?: PlanStatus | null;
  recoveredTransactionCount?: number;
  usedStoreKitRecovery?: boolean;
};

type VerifyResponse = {
  ok?: boolean;
  granted?: boolean;
  reason?: string | null;
  error?: string | null;
  message?: string | null;
  entitlement?: BackendEntitlement | null;
  quotaStatus?: PlanStatus | null;
};

export type PurchaseService = {
  getStudentPassProduct(): Promise<StudentPassProduct | null>;
  getBackendEntitlement(accessToken: string | null | undefined): Promise<EntitlementResponse>;
  purchaseStudentPass(accessToken: string | null | undefined): Promise<PurchaseResult>;
  restoreStudentPass(accessToken: string | null | undefined): Promise<RestoreResult>;
  cleanup(): void;
};

const USE_REAL_IAP =
  process.env.EXPO_PUBLIC_USE_REAL_IAP === '1' ||
  process.env.EXPO_PUBLIC_USE_REAL_IAP === 'true';
const PRODUCT_QUERY_TYPE = 'in-app' as const;
const APPLE_ACCOUNT_MISMATCH_MESSAGE =
  'This Apple ID has already purchased this pass for another Youmi Lens account. To use it, sign in to that Youmi Lens account, or use a different Apple ID/Sandbox tester for a separate account.';

function productIdOf(product: Product): string {
  return product.id;
}

function normalizeProduct(product: Product): StudentPassProduct {
  const displayName =
    product.displayName ||
    ('displayNameIOS' in product && typeof product.displayNameIOS === 'string'
      ? product.displayNameIOS
      : null) ||
    product.title ||
    'Student Basic - 30 Days';

  return {
    productId: productIdOf(product),
    displayName,
    displayPrice: product.displayPrice,
    available: true,
  };
}

function isStudentPassPurchase(purchase: Purchase | null | undefined): purchase is Purchase {
  return purchase?.productId === STUDENT_PASS_PRODUCT_ID;
}

function signedPayloadFor(purchase: Purchase): string | null {
  return purchase.purchaseToken && purchase.purchaseToken.length > 0 ? purchase.purchaseToken : null;
}

function transactionIdFor(purchase: Purchase): string | null {
  return 'transactionId' in purchase && typeof purchase.transactionId === 'string'
    ? purchase.transactionId
    : purchase.id || null;
}

function originalTransactionIdFor(purchase: Purchase): string | null {
  return 'originalTransactionIdentifierIOS' in purchase &&
    typeof purchase.originalTransactionIdentifierIOS === 'string'
    ? purchase.originalTransactionIdentifierIOS
    : null;
}

function shouldFinishAfterBackend(payload: VerifyResponse): boolean {
  if (payload.ok && payload.granted) return true;
  if (payload.ok && (payload.reason === 'expired' || payload.reason === 'revoked')) return true;
  if (payload.reason === 'sales_closed') return true;
  if (payload.reason === 'transaction_already_processed' || payload.error === 'iap_transaction_already_processed') {
    return true;
  }
  if (payload.error === 'iap_already_linked' || payload.error === 'iap_deleted_account_binding') return true;
  return false;
}

function mapBackendError(payload: VerifyResponse, status: number): PurchaseResult {
  const backendCode = `${payload.error ?? ''} ${payload.reason ?? ''}`.toLowerCase();
  let code: PurchaseResultCode = 'backend_verification_failed';
  if (status === 401) code = 'session_expired';
  else if (backendCode.includes('already_processed') || backendCode.includes('already processed')) {
    code = 'transaction_already_processed';
  } else if (payload.error === 'iap_already_linked') code = 'already_linked';
  else if (payload.error === 'iap_deleted_account_binding') code = 'deleted_account_binding';
  else if (payload.reason === 'sales_closed' || status === 403) code = 'sales_closed';
  else if (payload.reason === 'expired') code = 'expired';

  return {
    ok: false,
    code,
    message: purchaseMessageForCode(code),
    entitlement: payload.entitlement ?? null,
    quotaStatus: payload.quotaStatus ?? null,
  };
}

function purchaseMessageForCode(code: PurchaseResultCode): string {
  switch (code) {
    case 'success':
      return 'Student Basic access is active.';
    case 'cancelled':
      return 'Purchase cancelled.';
    case 'pending':
      return 'Purchase is pending. Open Youmi Lens again after Apple finishes processing it.';
    case 'purchase_in_progress':
      return 'A Student Basic purchase is already in progress.';
    case 'product_unavailable':
      return 'Student Basic is not available from the App Store right now.';
    case 'sign_in_required':
      return 'Sign in before purchasing Student Basic.';
    case 'session_expired':
      return 'Your session has expired. Sign in again before purchasing.';
    case 'transaction_already_processed':
      return 'This transaction was already processed. Refresh Access to load the latest account status.';
    case 'already_linked':
    case 'apple_account_already_purchased':
      return APPLE_ACCOUNT_MISMATCH_MESSAGE;
    case 'deleted_account_binding':
      return 'This purchase is linked to another Youmi Lens account.';
    case 'expired':
      return 'This Student Basic purchase has expired.';
    case 'sales_closed':
      return 'New Student Basic purchases are currently unavailable.';
    case 'offline':
      return 'Network unavailable. Check your connection and try again.';
    case 'storekit_error':
      return 'The Apple purchase could not be completed. Please try again.';
    case 'backend_verification_failed':
    default:
      return 'The purchase could not be verified. Refresh Access before trying another purchase.';
  }
}

export function restoreMessageForCode(code: RestoreResultCode): string {
  switch (code) {
    case 'active_restored':
      return 'Student Basic access refreshed from your Youmi Lens account.';
    case 'expired':
      return 'Your Student Basic access has expired.';
    case 'revoked':
      return 'This purchase was refunded or revoked.';
    case 'already_linked':
      return APPLE_ACCOUNT_MISMATCH_MESSAGE;
    case 'no_eligible_purchase':
      return 'No Student Basic access is linked to this Youmi Lens account.';
    case 'unverified_history_unavailable':
      return 'Consumable purchases are not restored from App Store history. Sign in to the Youmi Lens account used for purchase.';
    case 'sign_in_required':
      return 'Sign in to refresh your purchase status.';
    case 'failed':
    default:
      return 'Purchase status refresh failed.';
  }
}

function entitlementRestoreResult(
  entitlement: BackendEntitlement | null | undefined,
  quotaStatus?: PlanStatus | null,
): RestoreResult | null {
  if (
    entitlement?.active &&
    entitlement.productId &&
    STUDENT_ACCESS_PRODUCT_IDS.has(entitlement.productId)
  ) {
    return {
      ok: true,
      code: 'active_restored',
      message: restoreMessageForCode('active_restored'),
      entitlement,
      quotaStatus,
      usedStoreKitRecovery: false,
    };
  }

  if (entitlement?.status === 'expired') {
    return {
      ok: true,
      code: 'expired',
      message: restoreMessageForCode('expired'),
      entitlement,
      quotaStatus,
      usedStoreKitRecovery: false,
    };
  }

  if (entitlement?.status === 'revoked' || entitlement?.status === 'refunded' || entitlement?.revoked) {
    return {
      ok: true,
      code: 'revoked',
      message: restoreMessageForCode('revoked'),
      entitlement,
      quotaStatus,
      usedStoreKitRecovery: false,
    };
  }

  return null;
}

async function fetchJson<T>(url: string, accessToken: string, init?: RequestInit): Promise<{ status: number; payload: T }> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json().catch(() => null)) as T;
  return { status: response.status, payload };
}

function hasConnectionPrereqs(accessToken: string | null | undefined): PurchaseResult | null {
  if (!accessToken) {
    return { ok: false, code: 'sign_in_required', message: purchaseMessageForCode('sign_in_required') };
  }
  if (!API_BASE_URL) {
    return { ok: false, code: 'offline', message: 'The purchase service is unavailable. Please try again later.' };
  }
  return null;
}

// StoreKit may never present the sheet or emit a purchase/error event (e.g. a
// prior unfinished consumable transaction blocking the queue). Without a bound,
// the purchase promise hangs forever and the UI spins. Generous enough for the
// Apple sheet + Face ID + processing, short enough to recover the UI.
const PURCHASE_EVENT_TIMEOUT_MS = 120_000;

class RealPurchaseService implements PurchaseService {
  private connected = false;
  private productCache: StudentPassProduct | null = null;
  private purchaseInFlight = false;
  private purchaseSubscription: { remove: () => void } | null = null;
  private errorSubscription: { remove: () => void } | null = null;
  private pendingPurchase:
    | {
        resolve: (purchase: Purchase) => void;
        reject: (error: Error) => void;
      }
    | null = null;

  private async ensureConnection() {
    if (Platform.OS !== 'ios') throw new Error('Student Basic purchases are available on iPad.');
    if (this.connected) return;
    await initConnection();
    this.connected = true;
    this.purchaseSubscription = purchaseUpdatedListener((purchase) => {
      if (!isStudentPassPurchase(purchase)) return;
      logIap('purchaseUpdatedListener fired');
      const pending = this.pendingPurchase;
      this.pendingPurchase = null;
      // A transaction can arrive with no purchase in flight (e.g. an unfinished
      // transaction re-delivered on launch). It is left in the queue and
      // recovered on the next purchase attempt via recoverPendingPurchase().
      pending?.resolve(purchase);
    });
    this.errorSubscription = purchaseErrorListener((error) => {
      logIap('purchaseErrorListener fired', String(error?.code ?? ''));
      const pending = this.pendingPurchase;
      this.pendingPurchase = null;
      const message = error?.message || 'The App Store purchase could not be completed.';
      const normalized = new Error(message);
      normalized.name = String(error?.code ?? 'storekit_error');
      pending?.reject(normalized);
    });
  }

  async getStudentPassProduct(): Promise<StudentPassProduct | null> {
    await this.ensureConnection();
    const products = await fetchProducts({
      skus: [STUDENT_PASS_PRODUCT_ID],
      type: PRODUCT_QUERY_TYPE,
    });
    const product = (products ?? []).find((item) => productIdOf(item as Product) === STUDENT_PASS_PRODUCT_ID) as
      | Product
      | undefined;
    this.productCache = product ? normalizeProduct(product) : null;
    return this.productCache;
  }

  async getBackendEntitlement(accessToken: string | null | undefined): Promise<EntitlementResponse> {
    if (!accessToken) {
      return {
        ok: false,
        entitlement: { active: false, productId: null, expiresAt: null },
        error: 'auth_required',
        message: 'Sign in required.',
      };
    }
    if (!API_BASE_URL) {
      return {
        ok: false,
        entitlement: { active: false, productId: null, expiresAt: null },
        error: 'missing_api_base_url',
        message: 'Missing API base URL.',
      };
    }

    const { status, payload } = await fetchJson<EntitlementResponse>(
      `${API_BASE_URL}/api/iap/entitlement`,
      accessToken,
      { method: 'GET' },
    );
    if (status >= 200 && status < 300 && payload?.ok) {
      return payload;
    }
    return {
      ok: false,
      entitlement: { active: false, productId: null, expiresAt: null },
      error: status === 401 ? 'auth_required' : payload?.error ?? 'entitlement_failed',
      message: status === 401 ? 'Your session has expired.' : 'Entitlement status is unavailable.',
    };
  }

  async purchaseStudentPass(accessToken: string | null | undefined): Promise<PurchaseResult> {
    const prereq = hasConnectionPrereqs(accessToken);
    if (prereq) return prereq;
    // In-memory only (singleton lives for the JS runtime). Never persisted, so a
    // relaunch always starts clean and can never be permanently "in progress".
    if (this.purchaseInFlight) {
      logIap('purchaseInProgress before request: true — rejecting duplicate tap');
      return {
        ok: false,
        code: 'purchase_in_progress',
        message: purchaseMessageForCode('purchase_in_progress'),
      };
    }

    logIap('button pressed; user id present:', Boolean(accessToken));
    this.purchaseInFlight = true;
    try {
      await this.ensureConnection();

      // Recover any unfinished Student Basic transaction left in the StoreKit
      // queue before starting a new one. A stuck transaction (e.g. from a prior
      // failed verify) can stop StoreKit from presenting a fresh purchase sheet.
      const recovered = await this.recoverPendingPurchase(accessToken!);
      if (recovered) {
        logIap('recovered a pending transaction before requesting a new purchase');
        return recovered;
      }

      const product = this.productCache ?? (await this.getStudentPassProduct());
      logIap('product loaded:', Boolean(product?.available), product?.productId ?? null);
      if (!product?.available) {
        return {
          ok: false,
          code: 'product_unavailable',
          message: purchaseMessageForCode('product_unavailable'),
        };
      }

      logIap('calling requestPurchase');
      const purchase = await this.requestPurchaseWithTimeout();
      logIap('requestPurchase resolved with a purchase');

      if (purchase.purchaseState === 'pending') {
        return { ok: false, code: 'pending', message: purchaseMessageForCode('pending') };
      }

      return await this.verifyPurchaseWithBackend(purchase, accessToken!);
    } catch (error) {
      return this.mapPurchaseError(error);
    } finally {
      // Always clear loading/guards, even if StoreKit never presented a sheet or
      // requestPurchase hung — the timeout guarantees this finally runs.
      this.pendingPurchase = null;
      this.purchaseInFlight = false;
      logIap('clearing loading');
    }
  }

  /**
   * Await the StoreKit purchase event with a hard timeout. The purchase resolves
   * from the listeners (set in ensureConnection) or directly from requestPurchase;
   * if neither fires within PURCHASE_EVENT_TIMEOUT_MS, reject so the UI recovers.
   */
  private requestPurchaseWithTimeout(): Promise<Purchase> {
    return new Promise<Purchase>((resolve, reject) => {
      let settled = false;
      const finish = (action: 'resolve' | 'reject', value: Purchase | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingPurchase = null;
        if (action === 'resolve') resolve(value as Purchase);
        else reject(value as Error);
      };

      const timer = setTimeout(() => {
        logIap('timeout clearing stale pending — no StoreKit event');
        const timeoutError = new Error('The App Store did not respond. Please try again.');
        timeoutError.name = 'storekit_timeout';
        finish('reject', timeoutError);
      }, PURCHASE_EVENT_TIMEOUT_MS);

      this.pendingPurchase = {
        resolve: (purchase) => finish('resolve', purchase),
        reject: (error) => finish('reject', error),
      };

      requestPurchase({
        type: PRODUCT_QUERY_TYPE,
        request: { apple: { sku: STUDENT_PASS_PRODUCT_ID } },
      })
        .then((maybe) => {
          // Some expo-iap paths resolve the purchase directly instead of (or in
          // addition to) the event listener. Resolve from whichever arrives first.
          const list = Array.isArray(maybe) ? maybe : maybe ? [maybe] : [];
          const direct = list.find((item) => isStudentPassPurchase(item as Purchase));
          if (direct) finish('resolve', direct as Purchase);
        })
        .catch((error) => finish('reject', error instanceof Error ? error : new Error(String(error))));
    });
  }

  /**
   * Unfinished Student Basic transactions still held by StoreKit — e.g. a
   * payment that succeeded but whose first backend verify failed, so it was
   * never finished. For a consumable these remain available until finished.
   */
  private async getUnfinishedStudentPassPurchases(): Promise<Purchase[]> {
    try {
      await this.ensureConnection();
      const available = ((await getAvailablePurchases()) as Purchase[] | null) ?? [];
      return available.filter((p) => isStudentPassPurchase(p) && Boolean(signedPayloadFor(p)));
    } catch {
      // Best-effort: never block purchase/restore because the lookup failed.
      return [];
    }
  }

  /**
   * Re-verify every unfinished Student Basic transaction through the backend.
   * Verification is idempotent by transactionId, so a re-send of an already
   * paid (but unverified) transaction grants the entitlement and finishes the
   * transaction (verifyPurchaseWithBackend finishes on any definitive outcome).
   */
  private async recoverUnfinishedPurchases(accessToken: string): Promise<{
    granted: PurchaseResult | null;
    processedCount: number;
  }> {
    const pending = await this.getUnfinishedStudentPassPurchases();
    let granted: PurchaseResult | null = null;
    for (const purchase of pending) {
      logIap('recovering unfinished transaction', transactionIdFor(purchase) ? 'txn-id:yes' : 'txn-id:no');
      const result = await this.verifyPurchaseWithBackend(purchase, accessToken);
      // ok covers a fresh grant and an idempotent re-grant of the same txn.
      if (result.ok && !granted) granted = result;
    }
    return { granted, processedCount: pending.length };
  }

  /**
   * Purchase-flow recovery: clear/recover any stuck transaction before
   * requesting a new sheet. Returns a granted result when an already-paid
   * purchase is recovered; otherwise null so the caller proceeds with a fresh
   * purchase (verifyPurchaseWithBackend already finished non-grantable ones).
   */
  private async recoverPendingPurchase(accessToken: string): Promise<PurchaseResult | null> {
    const { granted } = await this.recoverUnfinishedPurchases(accessToken);
    return granted;
  }

  private mapPurchaseError(error: unknown): PurchaseResult {
    const name = error instanceof Error ? error.name.toLowerCase() : '';
    const message = error instanceof Error ? error.message : undefined;
    if (name === 'storekit_timeout') {
      logIap('requestPurchase timed out');
      return { ok: false, code: 'storekit_error', message: purchaseMessageForCode('storekit_error') };
    }
    if (
      name === ErrorCode.UserCancelled ||
      name.includes('cancel') ||
      message?.toLowerCase().includes('cancel')
    ) {
      return { ok: false, code: 'cancelled', message: purchaseMessageForCode('cancelled') };
    }
    if (
      name === ErrorCode.NetworkError ||
      name === ErrorCode.RemoteError ||
      name === ErrorCode.ServiceError ||
      name === ErrorCode.ServiceDisconnected ||
      name === ErrorCode.ServiceTimeout
    ) {
      return { ok: false, code: 'offline', message: purchaseMessageForCode('offline') };
    }
    if (
      name === ErrorCode.AlreadyOwned ||
      name === ErrorCode.DuplicatePurchase ||
      /already (purchased|owned)|duplicate purchase/i.test(message ?? '')
    ) {
      return {
        ok: false,
        code: 'apple_account_already_purchased',
        message: purchaseMessageForCode('apple_account_already_purchased'),
      };
    }
    return { ok: false, code: 'storekit_error', message: purchaseMessageForCode('storekit_error') };
  }

  async restoreStudentPass(accessToken: string | null | undefined): Promise<RestoreResult> {
    if (!accessToken) {
      return { ok: false, code: 'sign_in_required', message: restoreMessageForCode('sign_in_required') };
    }
    if (!API_BASE_URL) {
      return { ok: false, code: 'failed', message: 'The access service is unavailable. Please try again later.' };
    }

    let initial: EntitlementResponse;
    try {
      initial = await this.getBackendEntitlement(accessToken);
    } catch {
      return { ok: false, code: 'failed', message: 'Network unavailable. Check your connection and try again.' };
    }
    if (!initial.ok) {
      return {
        ok: false,
        code: 'failed',
        message:
          initial.error === 'auth_required'
            ? 'Your session has expired. Sign in again to refresh access.'
            : 'Access status could not be refreshed. Check your connection and try again.',
      };
    }
    const initialResult = entitlementRestoreResult(initial.entitlement, initial.quotaStatus ?? null);
    if (initialResult) return initialResult;

    // No active entitlement on the backend. Before giving up, recover any
    // unfinished Apple transaction (e.g. a successful payment whose first
    // verify failed) by re-verifying it, then re-read the backend entitlement.
    const recovery = await this.recoverUnfinishedPurchases(accessToken);
    if (recovery.processedCount > 0) {
      logIap('refresh access recovered transactions:', recovery.processedCount);
      let refreshed: EntitlementResponse;
      try {
        refreshed = await this.getBackendEntitlement(accessToken);
      } catch {
        refreshed = initial;
      }
      const recoveredResult = entitlementRestoreResult(refreshed.entitlement, refreshed.quotaStatus ?? null);
      if (recoveredResult) {
        return { ...recoveredResult, recoveredTransactionCount: recovery.processedCount, usedStoreKitRecovery: true };
      }
      // Recovery ran but the entitlement is still not active (e.g. backend
      // temporarily rejected). Fall through to a clear, retryable result below.
    }

    const code: RestoreResultCode =
      initial.entitlement.status === 'none' || !initial.entitlement.status
        ? 'no_eligible_purchase'
        : 'unverified_history_unavailable';
    return {
      ok: false,
      code,
      message: restoreMessageForCode(code),
      entitlement: initial.entitlement,
      quotaStatus: initial.quotaStatus ?? null,
      recoveredTransactionCount: recovery.processedCount,
      usedStoreKitRecovery: recovery.processedCount > 0,
    };
  }

  cleanup() {
    this.purchaseSubscription?.remove();
    this.errorSubscription?.remove();
    this.purchaseSubscription = null;
    this.errorSubscription = null;
    if (this.connected) {
      void endConnection().catch(() => {});
    }
    this.connected = false;
  }

  private async verifyPurchaseWithBackend(purchase: Purchase, accessToken: string): Promise<PurchaseResult> {
    const purchaseToken = signedPayloadFor(purchase);
    if (!purchaseToken) {
      return {
        ok: false,
        code: 'backend_verification_failed',
        message: purchaseMessageForCode('backend_verification_failed'),
      };
    }

    let verification: { status: number; payload: VerifyResponse };
    try {
      verification = await fetchJson<VerifyResponse>(
        `${API_BASE_URL}/api/iap/apple/verify`,
        accessToken,
        {
          method: 'POST',
          body: JSON.stringify({
            platform: 'ios',
            productId: STUDENT_PASS_PRODUCT_ID,
            transactionId: transactionIdFor(purchase),
            originalTransactionId: originalTransactionIdFor(purchase),
            purchaseToken,
          }),
        },
      );
    } catch {
      return { ok: false, code: 'offline', message: purchaseMessageForCode('offline') };
    }
    const status = verification.status;
    const payload = verification.payload ?? {};

    if (shouldFinishAfterBackend(payload)) {
      await finishTransaction({ purchase, isConsumable: true });
    }

    if (status >= 200 && status < 300 && payload?.ok && payload.granted) {
      return {
        ok: true,
        code: 'success',
        message: purchaseMessageForCode('success'),
        entitlement: payload.entitlement ?? payload.quotaStatus?.entitlement ?? null,
        quotaStatus: payload.quotaStatus ?? null,
      };
    }

    return mapBackendError(payload ?? {}, status);
  }

}

class MockPurchaseService implements PurchaseService {
  private state = process.env.EXPO_PUBLIC_IAP_MOCK_STATE ?? 'available';

  async getStudentPassProduct(): Promise<StudentPassProduct | null> {
    if (this.state === 'product_unavailable') return null;
    return {
      productId: STUDENT_PASS_PRODUCT_ID,
      displayName: 'Student Basic - 30 Days',
      displayPrice: '$4.99',
      available: true,
    };
  }

  async getBackendEntitlement(): Promise<EntitlementResponse> {
    const active = this.state === 'active_entitlement';
    const expired = this.state === 'expired_entitlement';
    const revoked = this.state === 'revoked_entitlement' || this.state === 'refunded_entitlement';
    return {
      ok: true,
      entitlement: active
        ? {
            active: true,
            status: 'active',
            productId: STUDENT_PASS_PRODUCT_ID,
            planType: STUDENT_PASS_PLAN_TYPE,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          }
        : {
            active: false,
            status: expired ? 'expired' : revoked ? (this.state === 'refunded_entitlement' ? 'refunded' : 'revoked') : 'none',
            productId: expired || revoked ? STUDENT_PASS_PRODUCT_ID : null,
            planType: expired || revoked ? STUDENT_PASS_PLAN_TYPE : null,
            expiresAt: expired || revoked ? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() : null,
          },
    };
  }

  async purchaseStudentPass(): Promise<PurchaseResult> {
    if (this.state === 'cancelled') {
      return { ok: false, code: 'cancelled', message: purchaseMessageForCode('cancelled') };
    }
    if (this.state === 'storekit_error') {
      return { ok: false, code: 'storekit_error', message: purchaseMessageForCode('storekit_error') };
    }
    if (this.state === 'backend_error') {
      return {
        ok: false,
        code: 'backend_verification_failed',
        message: purchaseMessageForCode('backend_verification_failed'),
      };
    }
    const entitlement = (await this.getBackendEntitlement()).entitlement;
    if (entitlement.active) {
      return {
        ok: true,
        code: 'success',
        message: purchaseMessageForCode('success'),
        entitlement,
      };
    }
    return {
      ok: false,
      code: 'backend_verification_failed',
      message: 'Mock backend entitlement is inactive.',
      entitlement,
    };
  }

  async restoreStudentPass(): Promise<RestoreResult> {
    const entitlement = (await this.getBackendEntitlement()).entitlement;
    if (entitlement.active) {
      return {
        ok: true,
        code: 'active_restored',
        message: restoreMessageForCode('active_restored'),
        entitlement,
      };
    }
    if (this.state === 'expired_entitlement') {
      return { ok: true, code: 'expired', message: restoreMessageForCode('expired'), entitlement };
    }
    if (this.state === 'revoked_entitlement' || this.state === 'refunded_entitlement') {
      return { ok: true, code: 'revoked', message: restoreMessageForCode('revoked'), entitlement };
    }
    if (this.state === 'already_linked') {
      return { ok: false, code: 'already_linked', message: restoreMessageForCode('already_linked') };
    }
    if (this.state === 'restore_failed') {
      return { ok: false, code: 'failed', message: restoreMessageForCode('failed') };
    }
    return {
      ok: false,
      code: 'unverified_history_unavailable',
      message: restoreMessageForCode('unverified_history_unavailable'),
      entitlement,
    };
  }

  cleanup() {}
}

export function planIdFromPlanType(planType?: string | null): PlanId {
  return planType === STUDENT_PASS_PLAN_TYPE ? 'student_pass' : 'free';
}

export function shouldShowPurchaseEntry(status: PlanStatus | null | undefined): boolean {
  return status?.studentPass?.isPurchasable === true;
}

export const STUDENT_PASS_REQUIRED_COPY = [
  'Student Basic includes the same entitlements on every plan.',
  'Auto-renewing subscription. Cancel anytime in your Apple Account settings.',
];

export const STUDENT_PASS_FORBIDDEN_COPY = [
  'lifetime',
  'forever',
  'unlimited',
  'one-time payment',
];

export const purchaseService: PurchaseService = USE_REAL_IAP
  ? new RealPurchaseService()
  : new MockPurchaseService();
