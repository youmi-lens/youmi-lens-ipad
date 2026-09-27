import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const ACCOUNT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const MONTHLY = 'com.aydenz.youmilensipad.student.monthly';
export const ANNUAL = 'com.aydenz.youmilensipad.student.annual';
export const never = () => new Promise(() => {});
export const transaction = (productId = MONTHLY, id = 'test-transaction') => ({
  productId, id, transactionId: id, purchaseToken: 'external-test-payload', purchaseState: 'purchased',
  appAccountToken: ACCOUNT, transactionDate: Date.now(),
});
export async function flush() {
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
}

/** Compile real production modules. Only native StoreKit, HTTP, storage/auth,
 * UI effects, and the clock are supplied by the harness; services are not mocked.
 * Handler functions are located by the TS AST and executed verbatim with their
 * closure dependencies, avoiding a second implementation of the UI workflow.
 */
export function paymentHarness() {
  const cache = new Map();
  const timers = new Map();
  const updates = new Set();
  const errors = new Set();
  let time = 0;
  const epoch = Date.now();
  class ClockDate extends Date { static now() { return epoch + time; } }
  let nextTimer = 0;
  const state = { requests: [], http: [], finishes: [], diagnostics: [], alerts: [], busy: null,
    restoring: false, refreshes: 0, active: false, initCalls: 0, purchases: [], statusLoading: false, planLoading: false };
  const clock = {
    setTimeout(fn, ms) { timers.set(++nextTimer, { fn, due: time + ms }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  };
  const appState = { currentState: 'active' };
  const iap = {
    initConnection: async () => { state.initCalls += 1; return true; },
    endConnection: async () => true,
    fetchProducts: async () => [MONTHLY, ANNUAL].map((id) => ({ id, displayPrice: 'StoreKit price',
      subscriptionPeriodUnitIOS: id === MONTHLY ? 'month' : 'year' })),
    purchaseUpdatedListener(fn) { updates.add(fn); return { remove: () => updates.delete(fn) }; },
    purchaseErrorListener(fn) { errors.add(fn); return { remove: () => errors.delete(fn) }; },
    requestPurchase: async (args) => { state.requests.push(args); return []; },
    finishTransaction: async (args) => { state.finishes.push(args); },
    getAvailablePurchases: async () => state.purchases,
    syncIOS: async () => true,
    isEligibleForIntroOfferIOS: async () => false,
    deepLinkToSubscriptionsIOS: async () => {},
  };
  const entitlement = () => ({ active: state.active, status: state.active ? 'active' : 'none',
    productId: state.active ? MONTHLY : null, expiresAt: state.active ? '2099-01-01T00:00:00Z' : null });
  const response = (payload, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => payload });
  state.fetch = async (url, init) => {
    if (url.endsWith('/verify')) { state.active = true; return response({ ok: true, granted: true, entitlement: entitlement() }); }
    if (url.endsWith('/restore')) {
      const purchases = JSON.parse(init.body).purchases;
      if (purchases.length) state.active = true;
      return response({ ok: true, entitlement: entitlement(), restoredCount: purchases.length,
        verifiedTransactionIds: purchases.map((p) => p.transactionId) });
    }
    if (url.endsWith('/quota/status')) return response({ ok: true, plan: { planType: state.active ? 'student_pass' : 'public_trial',
      displayName: 'Student Access', entitlement: entitlement(), monthlyMinutesLimit: 600,
      dailyMinutesLimit: 120, maxRecordingMinutes: 90, maxLiveSessionMinutes: 90,
      maxRecordingsPerDay: 6, maxProcessingJobsPerDay: 10 } });
    return response({ ok: true, entitlement: entitlement() });
  };
  const nativeErrorModule = resolve(root, 'node_modules/expo-iap/src/ExpoIapModule.ts');
  const auth = { getSession: async () => ({ data: { session: { access_token: 'external-test-token', user: { id: ACCOUNT } } } }) };
  const log = { log(...args) { if (args[0] === '[iap-diag]') state.diagnostics.push(args.slice(1)); }, warn() {} };
  const mocks = new Map([
    ['expo-iap', iap], ['react-native', { Platform: { OS: 'ios' }, AppState: appState }],
    [resolve(root, 'lib/config.ts'), { API_BASE_URL: 'https://payment-test.invalid' }],
    [nativeErrorModule, { NATIVE_ERROR_CODES: {} }],
    [resolve(root, 'lib/guestIapClient.ts'), { isGuestIapClientConfigured: true, guestIapSupabase: { auth } }],
  ]);
  function load(file) {
    const absolute = resolve(root, file);
    if (mocks.has(absolute)) return mocks.get(absolute);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} };
    cache.set(absolute, module);
    const js = ts.transpileModule(readFileSync(absolute, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    const requireModule = (name) => mocks.get(name) ?? load(resolve(dirname(absolute), `${name}.ts`));
    new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', 'fetch', 'process', 'console', '__DEV__', 'Date', js)(
      requireModule, module, module.exports, clock.setTimeout, clock.clearTimeout,
      async (url, init) => {
        state.http.push({ url, init });
        if (url.endsWith('/quota/status')) state.refreshes += 1;
        return state.fetch(url, init);
      },
      { env: { EXPO_PUBLIC_USE_REAL_IAP: 'true' } }, log, false, ClockDate,
    );
    return module.exports;
  }
  const errorHelpers = load('node_modules/expo-iap/src/utils/errorMapping.ts');
  Object.assign(iap, { ErrorCode: load('node_modules/expo-iap/src/types.ts').ErrorCode,
    ErrorCodeUtils: errorHelpers.ErrorCodeUtils, createPurchaseError: errorHelpers.createPurchaseError });
  const service = load('lib/subscriptions.ts').subscriptionService;
  function handler(file, name, scope) {
    const source = ts.createSourceFile(file, readFileSync(resolve(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let initializer;
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) initializer = node.initializer;
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) initializer = node;
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.ok(initializer, `Production handler ${name} exists`);
    if (ts.isCallExpression(initializer)) initializer = initializer.arguments[0]; // useCallback wrapper
    const js = ts.transpileModule(`const actualHandler = ${initializer.getText(source)};`, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    } }).outputText;
    return new Function(...Object.keys(scope), `${js}\nreturn actualHandler;`)(...Object.values(scope));
  }
  const common = { t: (key) => key, Alert: { alert: (...args) => state.alerts.push(args) }, console: log,
    logDiag: load('lib/iapDiag.ts').logDiag, subscriptionService: service,
    session: { access_token: 'external-test-token' }, isGuest: false, restoringPurchases: false,
    setRestoringPurchases: (value) => { state.restoring = value; },
    router: { push() {} }, fetchPlanStatus: load('lib/planStatus.ts').fetchPlanStatus,
    setPlanStatus() {}, setPlanLoading(value) { state.planLoading = value; }, setPlanError() {},
    setPlanStatusAccountId() {}, setStatusLoading(value) { state.statusLoading = value; }, setError() {},
    accessToken: 'external-test-token', accountId: ACCOUNT,
    activeAccountRef: { current: ACCOUNT }, statusRequestRef: { current: 0 },
    ensureGuestIapIdentity: load('lib/guestIap.ts').ensureGuestIapIdentity, setGuestAccountId() {},
    boundedPaymentTask: load('lib/boundedPaymentTask.ts').boundedPaymentTask,
    PAYMENT_UI_WAIT_TIMEOUT_MS: load('lib/boundedPaymentTask.ts').PAYMENT_UI_WAIT_TIMEOUT_MS,
    isSubscriptionProductId: load('lib/subscriptionProducts.ts').isSubscriptionProductId,
  };
  const refresh = handler('app/plans.tsx', 'loadStatus', common);
  common.getStudentBasicStatus = handler('app/plans.tsx', 'getStudentBasicStatus', common);
  const uiPurchaseLock = { current: false };
  function settingsRestore() {
    return handler('app/(tabs)/settings.tsx', 'handleRestorePurchases', { ...common,
      purchaseService: load('lib/purchases.ts').purchaseService,
      loadPlan: handler('app/(tabs)/settings.tsx', 'loadPlan', common),
    })();
  }
  function plansAction(name = 'handlePurchase', overrides = {}) {
    return handler('app/plans.tsx', name, { ...common, busy: null, purchaseVisible: true,
      selectedProduct: {}, selectedPlan: 'monthly', purchaseLockRef: uiPurchaseLock,
      setBusy: (value) => { state.busy = value; }, setAccessRefreshMessage() {},
      resolvePurchaseIdentity: handler('app/plans.tsx', 'resolvePurchaseIdentity', common),
      refreshCurrentStatus: refresh,
      refreshPaymentStatus: handler('app/plans.tsx', 'refreshPaymentStatus', { ...common, refreshCurrentStatus: refresh }),
      confirmsStudentBasicGrant: handler('app/plans.tsx', 'confirmsStudentBasicGrant', common),
      accessMessageForStatus: handler('app/plans.tsx', 'accessMessageForStatus', common), ...overrides,
    })();
  }
  return { service, iap, state, load, handler, response, settingsRestore, plansAction, appState, timers, auth,
    transaction: (product = MONTHLY, id = 'test-transaction') => ({ ...transaction(product, id), transactionDate: ClockDate.now() }),
    emit: (purchase) => [...updates].forEach((fn) => fn(purchase)),
    error: (error) => [...errors].forEach((fn) => fn(error)),
    listenerCounts: () => ({ updates: updates.size, errors: errors.size }),
    async advance(ms) {
      const end = time + ms;
      await flush();
      while (true) {
        const next = [...timers.entries()].filter(([, t]) => t.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        time = next[1].due; timers.delete(next[0]); next[1].fn(); await flush();
      }
      time = end; await flush();
    },
  };
}

export function track(promise) {
  const observed = { settled: false, value: undefined };
  promise.then((value) => { observed.settled = true; observed.value = value; });
  return observed;
}
