import {
  ErrorCode,
  currentEntitlementIOS,
  endConnection,
  fetchProducts,
  finishTransaction,
  getAllTransactionsIOS,
  getAvailablePurchases,
  initConnection,
  latestTransactionIOS,
  purchaseErrorListener,
  purchaseUpdatedListener,
  requestPurchase,
  restorePurchases,
  type Product,
  type Purchase,
} from 'expo-iap';
import { Platform } from 'react-native';

import { API_BASE_URL } from './config';
import type { PlanStatus } from './planStatus';

export const STUDENT_PASS_PRODUCT_ID = 'com.aydenz.youmilensipad.studentpass30d';
export const STUDENT_PASS_PLAN_TYPE = 'student_pass';

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
  | 'product_unavailable'
  | 'sign_in_required'
  | 'backend_verification_failed'
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

type RestoreResponse = {
  ok?: boolean;
  alreadyLinked?: boolean;
  restoredCount?: number;
  activeRestoredCount?: number;
  entitlement?: BackendEntitlement | null;
  quotaStatus?: PlanStatus | null;
  error?: string | null;
  message?: string | null;
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
    'Student Pass - 30 Days';

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
  if (payload.error === 'iap_already_linked' || payload.error === 'iap_deleted_account_binding') return true;
  return false;
}

function mapBackendError(payload: VerifyResponse, status: number): PurchaseResult {
  const code =
    payload.error === 'iap_already_linked'
      ? 'already_linked'
      : payload.error === 'iap_deleted_account_binding'
        ? 'deleted_account_binding'
        : payload.reason === 'sales_closed' || status === 403
          ? 'sales_closed'
          : payload.reason === 'expired'
            ? 'expired'
            : 'backend_verification_failed';

  return {
    ok: false,
    code,
    message: purchaseMessageForCode(code, payload.message ?? undefined),
    entitlement: payload.entitlement ?? null,
    quotaStatus: payload.quotaStatus ?? null,
  };
}

function purchaseMessageForCode(code: PurchaseResultCode, backendMessage?: string): string {
  switch (code) {
    case 'success':
      return 'Student Pass is active.';
    case 'cancelled':
      return 'Purchase cancelled.';
    case 'pending':
      return 'Purchase is pending. Open Youmi Lens again after Apple finishes processing it.';
    case 'product_unavailable':
      return 'Student Pass is not available from the App Store right now.';
    case 'sign_in_required':
      return 'Sign in before purchasing Student Pass.';
    case 'already_linked':
    case 'apple_account_already_purchased':
      return APPLE_ACCOUNT_MISMATCH_MESSAGE;
    case 'deleted_account_binding':
      return 'This purchase is linked to another Youmi Lens account.';
    case 'expired':
      return 'This Student Pass purchase has expired.';
    case 'sales_closed':
      return 'Student Pass purchases are no longer available.';
    case 'offline':
      return 'Could not reach the backend. Check your connection and try again.';
    case 'storekit_error':
      return backendMessage ?? 'The App Store purchase could not be completed.';
    case 'backend_verification_failed':
    default:
      return backendMessage ?? 'The backend could not verify this purchase.';
  }
}

export function restoreMessageForCode(code: RestoreResultCode): string {
  switch (code) {
    case 'active_restored':
      return 'Active Student Pass restored.';
    case 'expired':
      return 'Your Student Pass has expired.';
    case 'revoked':
      return 'This purchase was refunded or revoked.';
    case 'already_linked':
      return APPLE_ACCOUNT_MISMATCH_MESSAGE;
    case 'no_eligible_purchase':
      return 'No eligible Student Pass was found.';
    case 'unverified_history_unavailable':
      return 'Restore could not recover the purchase.';
    case 'sign_in_required':
      return 'Sign in to restore purchases.';
    case 'failed':
    default:
      return 'Restore failed.';
  }
}

function entitlementRestoreResult(
  entitlement: BackendEntitlement | null | undefined,
  quotaStatus?: PlanStatus | null,
): RestoreResult | null {
  if (entitlement?.active && entitlement.productId === STUDENT_PASS_PRODUCT_ID) {
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
    return { ok: false, code: 'offline', message: 'Missing API base URL.' };
  }
  return null;
}

class RealPurchaseService implements PurchaseService {
  private connected = false;
  private productCache: StudentPassProduct | null = null;
  private purchaseSubscription: { remove: () => void } | null = null;
  private errorSubscription: { remove: () => void } | null = null;
  private pendingPurchase:
    | {
        resolve: (purchase: Purchase) => void;
        reject: (error: Error) => void;
      }
    | null = null;

  private async ensureConnection() {
    if (Platform.OS !== 'ios') throw new Error('Student Pass purchases are available on iPad.');
    if (this.connected) return;
    await initConnection();
    this.connected = true;
    this.purchaseSubscription = purchaseUpdatedListener((purchase) => {
      if (!isStudentPassPurchase(purchase)) return;
      const pending = this.pendingPurchase;
      this.pendingPurchase = null;
      pending?.resolve(purchase);
    });
    this.errorSubscription = purchaseErrorListener((error) => {
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
      error: payload?.error ?? 'entitlement_failed',
      message: payload?.message ?? 'Entitlement status is unavailable.',
    };
  }

  async purchaseStudentPass(accessToken: string | null | undefined): Promise<PurchaseResult> {
    const prereq = hasConnectionPrereqs(accessToken);
    if (prereq) return prereq;

    try {
      await this.ensureConnection();
      const product = this.productCache ?? (await this.getStudentPassProduct());
      if (!product?.available) {
        return {
          ok: false,
          code: 'product_unavailable',
          message: purchaseMessageForCode('product_unavailable'),
        };
      }

      const purchase = await new Promise<Purchase>(async (resolve, reject) => {
        this.pendingPurchase = { resolve, reject };
        try {
          await requestPurchase({
            type: PRODUCT_QUERY_TYPE,
            request: { apple: { sku: STUDENT_PASS_PRODUCT_ID } },
          });
        } catch (error) {
          this.pendingPurchase = null;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });

      if (purchase.purchaseState === 'pending') {
        return { ok: false, code: 'pending', message: purchaseMessageForCode('pending') };
      }

      return await this.verifyPurchaseWithBackend(purchase, accessToken!);
    } catch (error) {
      const name = error instanceof Error ? error.name.toLowerCase() : '';
      const message = error instanceof Error ? error.message : undefined;
      if (name.includes('cancel') || message?.toLowerCase().includes('cancel')) {
        return { ok: false, code: 'cancelled', message: purchaseMessageForCode('cancelled') };
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
      return { ok: false, code: 'storekit_error', message: purchaseMessageForCode('storekit_error', message) };
    }
  }

  async restoreStudentPass(accessToken: string | null | undefined): Promise<RestoreResult> {
    if (!accessToken) {
      return { ok: false, code: 'sign_in_required', message: restoreMessageForCode('sign_in_required') };
    }
    if (!API_BASE_URL) {
      return { ok: false, code: 'failed', message: 'Missing API base URL.' };
    }

    const initial = await this.getBackendEntitlement(accessToken);
    const initialResult = entitlementRestoreResult(initial.entitlement, initial.quotaStatus ?? null);
    if (initialResult) return initialResult;

    const recoveryPurchases = await this.discoverStudentPassTransactions();
    if (recoveryPurchases.length === 0) {
      const finalEntitlement = await this.getBackendEntitlement(accessToken);
      const finalResult = entitlementRestoreResult(finalEntitlement.entitlement, finalEntitlement.quotaStatus ?? null);
      if (finalResult) return finalResult;
      const code: RestoreResultCode =
        finalEntitlement.entitlement.status === 'none' || !finalEntitlement.entitlement.status
          ? 'no_eligible_purchase'
          : 'unverified_history_unavailable';
      return {
        ok: false,
        code,
        message: restoreMessageForCode(code),
        entitlement: finalEntitlement.entitlement,
        usedStoreKitRecovery: true,
      };
    }

    const restorePayload = recoveryPurchases.map((purchase) => ({
      productId: purchase.productId,
      transactionId: transactionIdFor(purchase),
      originalTransactionId: originalTransactionIdFor(purchase),
      purchaseToken: signedPayloadFor(purchase),
    }));

    const { payload } = await fetchJson<RestoreResponse>(`${API_BASE_URL}/api/iap/restore`, accessToken, {
      method: 'POST',
      body: JSON.stringify({ platform: 'ios', purchases: restorePayload }),
    });

    const finalEntitlement = await this.getBackendEntitlement(accessToken);
    const finalResult = entitlementRestoreResult(finalEntitlement.entitlement, payload?.quotaStatus ?? null);
    if (finalResult) {
      return {
        ...finalResult,
        recoveredTransactionCount: recoveryPurchases.length,
        usedStoreKitRecovery: true,
      };
    }

    if (payload?.alreadyLinked) {
      return {
        ok: false,
        code: 'already_linked',
        message: restoreMessageForCode('already_linked'),
        entitlement: finalEntitlement.entitlement,
        quotaStatus: payload.quotaStatus ?? finalEntitlement.quotaStatus ?? null,
        recoveredTransactionCount: recoveryPurchases.length,
        usedStoreKitRecovery: true,
      };
    }

    const code: RestoreResultCode =
      (payload?.restoredCount ?? 0) > 0 ? 'expired' : 'no_eligible_purchase';
    return {
      ok: code === 'expired',
      code,
      message: restoreMessageForCode(code),
      entitlement: finalEntitlement.entitlement,
      quotaStatus: payload?.quotaStatus ?? finalEntitlement.quotaStatus ?? null,
      recoveredTransactionCount: recoveryPurchases.length,
      usedStoreKitRecovery: true,
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
        message: 'Apple did not provide signed transaction data for backend verification.',
      };
    }

    const { status, payload } = await fetchJson<VerifyResponse>(
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

    if (shouldFinishAfterBackend(payload)) {
      await finishTransaction({ purchase, isConsumable: false });
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

  private async discoverStudentPassTransactions(): Promise<Purchase[]> {
    await this.ensureConnection();
    const byId = new Map<string, Purchase>();
    const add = (purchase: Purchase | null | undefined) => {
      if (!isStudentPassPurchase(purchase)) return;
      if (!signedPayloadFor(purchase)) return;
      byId.set(transactionIdFor(purchase) ?? purchase.id, purchase);
    };

    const attempts: (() => Promise<Purchase | Purchase[] | null | undefined>)[] = [
      () => currentEntitlementIOS(STUDENT_PASS_PRODUCT_ID),
      () => latestTransactionIOS(STUDENT_PASS_PRODUCT_ID),
      () => getAllTransactionsIOS(),
      async () => {
        await restorePurchases().catch(() => undefined);
        return getAvailablePurchases({
          alsoPublishToEventListenerIOS: false,
          onlyIncludeActiveItemsIOS: false,
        });
      },
    ];

    for (const attempt of attempts) {
      try {
        const result = await attempt();
        if (Array.isArray(result)) result.forEach(add);
        else add(result);
      } catch {
        // StoreKit discovery is recovery-only; backend-known restore must not
        // depend on every discovery API succeeding.
      }
    }

    return [...byId.values()].sort((a, b) => (b.transactionDate ?? 0) - (a.transactionDate ?? 0));
  }
}

class MockPurchaseService implements PurchaseService {
  private state = process.env.EXPO_PUBLIC_IAP_MOCK_STATE ?? 'available';

  async getStudentPassProduct(): Promise<StudentPassProduct | null> {
    if (this.state === 'product_unavailable') return null;
    return {
      productId: STUDENT_PASS_PRODUCT_ID,
      displayName: 'Student Pass - 30 Days',
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
  return status?.studentPass?.isPurchasable !== false;
}

export const STUDENT_PASS_REQUIRED_COPY = [
  '30 days of premium access',
  'One-time payment. Does not renew automatically.',
];

export const STUDENT_PASS_FORBIDDEN_COPY = [
  'lifetime',
  'forever',
  'unlimited',
  'auto-renew',
  'monthly subscription',
  'cancel anytime',
];

export const purchaseService: PurchaseService = USE_REAL_IAP
  ? new RealPurchaseService()
  : new MockPurchaseService();
