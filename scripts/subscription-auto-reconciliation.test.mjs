import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { paymentHarness, ACCOUNT, MONTHLY, flush, never, track } from './helpers/payment-harness.mjs';

const TOKEN = 'external-test-token';
const B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const posts = h => h.state.http.filter(x => x.url.endsWith('/restore'));
const coordinator = h => h.load('lib/subscriptionReconciliation.ts').subscriptionReconciliation;
function ready(h) {
  h.state.purchases = [h.transaction()];
  const c = coordinator(h); c.setSession(TOKEN, ACCOUNT);
  return c;
}
const activeReply = h => h.response({ ok: true, restoredCount: 1, entitlement: { active: true },
  outcomes: [{ transactionId: 'test-transaction', code: 'active', granted: true, safeToFinish: true, retryable: false }] });

for (const mode of ['offline', 'timeout', '5xx']) {
  test(`Apple success then verify ${mode}: activation pending, no finish; later lifecycle recovers`, async () => {
    const h = paymentHarness(); const normal = h.state.fetch;
    h.state.fetch = async (url, init) => url.endsWith('/verify')
      ? mode === 'offline' ? Promise.reject(new TypeError('offline'))
        : mode === 'timeout' ? never() : h.response({ error: 'iap_temporarily_unavailable' }, 503)
      : normal(url, init);
    const paid = h.transaction();
    const purchase = track(h.service.purchase('monthly', TOKEN, ACCOUNT));
    await flush(); h.emit(paid);
    if (mode === 'timeout') await h.advance(30_000); else await flush();
    assert.equal(purchase.settled, true);
    assert.equal(purchase.value.ok, false);
    assert.equal(purchase.value.activationPending, true);
    assert.match(purchase.value.message, /received.*activated.*automatically/);
    assert.doesNotMatch(purchase.value.message, /try again|try purchasing/i);
    assert.equal(h.state.active, false); assert.equal(h.state.finishes.length, 0);
    h.state.purchases = [paid]; h.state.fetch = normal;
    const c = coordinator(h); c.setSession(TOKEN, ACCOUNT);
    assert.equal((await c.request('foreground')).ok, true);
    assert.equal(h.state.active, true); assert.equal(h.state.finishes.length, 1);
    assert.equal(h.state.requests.length, 1, 'no second purchase');
  });
}

test('fresh process recovers from StoreKit history and persisted admission, without in-memory context', async () => {
  const storage = new Map(); const before = paymentHarness({ storage });
  const normal = before.state.fetch;
  before.state.fetch = async (url, init) => url.endsWith('/verify') ? Promise.reject(new TypeError('offline')) : normal(url, init);
  const paid = before.transaction(); const p = before.service.purchase('monthly', TOKEN, ACCOUNT);
  await flush(); before.emit(paid); await p;
  before.service.cleanup();
  assert.equal(before.service.verificationContext, null);
  assert.equal(before.service.deferredTransactions.size, 0);
  const after = paymentHarness({ storage }); after.state.purchases = [paid];
  const c = coordinator(after); c.setSession(TOKEN, ACCOUNT);
  assert.equal((await c.request('auth_session')).ok, true);
  assert.equal(after.state.requests.length, 0);
  assert.equal(after.state.finishes.length, 1);
  assert.equal(JSON.parse(posts(after)[0].init.body).purchases[0].purchaseAuthorizationId, 'test-admission');
});

test('actual root hook reconciles when the authenticated session becomes available', async () => {
  const h = paymentHarness(); h.state.purchases = [h.transaction()];
  h.state.authValue = { loading: true, session: null, user: null, isGuest: false };
  const hook = h.load('lib/useSubscriptionReconciliation.ts').useSubscriptionReconciliation;
  h.renderHook(hook); await flush(); assert.equal(posts(h).length, 0);
  h.state.authValue = { loading: false, session: { access_token: TOKEN }, user: { id: ACCOUNT }, isGuest: false };
  h.renderHook(hook); await flush();
  assert.equal(posts(h).length, 1); assert.equal(h.state.active, true); h.unmountHook();
});

test('actual foreground listener retries after a temporary backend failure without alerts', async () => {
  const h = paymentHarness(); h.state.purchases = [h.transaction()]; const normal = h.state.fetch;
  h.state.fetch = async (url, init) => url.endsWith('/restore') ? h.response({}, 503) : normal(url, init);
  const hook = h.load('lib/useSubscriptionReconciliation.ts').useSubscriptionReconciliation;
  h.renderHook(hook); await flush(); assert.equal(h.state.finishes.length, 0);
  h.state.fetch = normal; h.appState.setState('background'); h.appState.setState('active'); await flush();
  assert.equal(posts(h).length, 2); assert.equal(h.state.active, true);
  assert.equal(h.state.alerts.length, 0); h.unmountHook(); assert.equal(h.appState.listenerCount(), 0);
});

test('actual Plans mount effect requests recovery and refreshes its guarded status', async () => {
  const h = paymentHarness(); const c = ready(h); let refreshes = 0;
  const cleanup = h.effect('app/plans.tsx', "request('plans_mount')", {
    subscriptionReconciliation: c, screenIdentity: ACCOUNT, isGuest: false, SUBSCRIPTIONS_LIVE: true,
    loadStatus: async () => { refreshes++; }, loadGuestStatus: async () => { throw Error('wrong identity'); },
  })();
  await flush(); assert.equal(posts(h).length, 1); assert.equal(refreshes, 1); cleanup();
});

test('simultaneous auth, foreground and Plans triggers share exactly one promise and POST', async () => {
  const h = paymentHarness(); const c = ready(h);
  const a = c.request('auth_session'), b = c.request('foreground'), p = c.request('plans_mount');
  assert.equal(a, b); assert.equal(b, p);
  await Promise.all([a, b, p]); assert.equal(posts(h).length, 1); assert.equal(h.state.finishes.length, 1);
});

test('correct owner is verified before finish and fresh access notification', async () => {
  const h = paymentHarness(); const c = ready(h); let reply; let notifications = 0;
  const normal = h.state.fetch;
  h.state.fetch = (url, init) => url.endsWith('/restore') ? new Promise(r => { reply = r; }) : normal(url, init);
  c.subscribe(() => { notifications++; });
  const p = c.request('auth_session'); await flush();
  assert.equal(h.state.finishes.length, 0); assert.equal(notifications, 0);
  assert.equal(posts(h)[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  reply(activeReply(h)); await p;
  assert.equal(h.state.finishes.length, 1); assert.equal(notifications, 1);
  assert.ok(h.state.http.some(x => x.url.endsWith('/entitlement')));
});

test('foreign history is sent for backend ownership verification, never finished or optimistically granted', async () => {
  const h = paymentHarness(); const c = ready(h); h.state.purchases[0].appAccountToken = B;
  h.state.fetch = async () => h.response({ ok: true, alreadyLinked: true, entitlement: { active: false },
    outcomes: [{ transactionId: 'test-transaction', code: 'iap_already_linked', granted: false, safeToFinish: false, retryable: false }] });
  let notifications = 0; c.subscribe(() => { notifications++; });
  assert.equal((await c.request('auth_session')).code, 'already_linked');
  assert.equal(posts(h).length, 1); assert.equal(h.state.finishes.length, 0);
  assert.equal(h.state.active, false); assert.equal(notifications, 0); assert.equal(h.state.alerts.length, 0);
});

test('mixed history finishes only the explicitly authorized transaction', async () => {
  const h = paymentHarness(); const c = ready(h);
  h.state.purchases.push({ ...h.transaction(MONTHLY, 'foreign'), appAccountToken: B });
  h.state.fetch = async () => h.response({ ok: true, entitlement: { active: true }, outcomes: [
    { transactionId: 'test-transaction', code: 'active', granted: true, safeToFinish: true, retryable: false },
    { transactionId: 'foreign', code: 'iap_already_linked', granted: false, safeToFinish: false, retryable: false },
  ] });
  await c.request('foreground');
  assert.deepEqual(h.state.finishes.map(x => x.purchase.transactionId), ['test-transaction']);
});

for (const payload of [
  { ok: true, entitlement: { active: true }, verifiedTransactionIds: ['test-transaction'] },
  { ok: true, entitlement: { active: true }, outcomes: [{ transactionId: 'test-transaction', safeToFinish: false, granted: true, code: 'active' }] },
  { ok: false, outcomes: [{ transactionId: 'test-transaction', safeToFinish: true, granted: true, code: 'active' }] },
]) test('missing/false finish authorization or unsuccessful backend envelope never finishes', async () => {
  const h = paymentHarness(); const c = ready(h); h.state.fetch = async () => h.response(payload);
  await c.request('foreground'); assert.equal(h.state.finishes.length, 0);
});

test('repeated reconciliation is idempotent through the existing backend contract', async () => {
  const h = paymentHarness(); const c = ready(h); const grants = new Set(); const normal = h.state.fetch;
  h.state.fetch = async (url, init) => {
    if (url.endsWith('/restore')) for (const p of JSON.parse(init.body).purchases) grants.add(p.transactionId);
    return normal(url, init);
  };
  await c.request('auth_session'); await c.request('foreground'); await c.request('plans_mount');
  assert.equal(grants.size, 1); assert.equal(h.state.requests.length, 0); assert.equal(h.state.active, true);
});

test('A response after switch to B cannot finish or refresh B; B gets its own queued flight', async () => {
  const h = paymentHarness(); const c = ready(h); let replyA; const events = [];
  c.subscribe(e => events.push(e));
  h.state.fetch = (url, init) => {
    assert.ok(url.endsWith('/restore'));
    if (init.headers.Authorization === `Bearer ${TOKEN}`) return new Promise(r => { replyA = r; });
    assert.equal(init.headers.Authorization, 'Bearer token-b');
    return Promise.resolve(h.response({ ok: true, alreadyLinked: true, entitlement: { active: false },
      outcomes: [{ transactionId: 'test-transaction', code: 'iap_already_linked', granted: false, safeToFinish: false, retryable: false }] }));
  };
  const a = c.request('auth_session'); await flush();
  c.setSession('token-b', B); c.request('auth_session'); c.request('plans_mount');
  replyA(activeReply(h)); assert.equal(await a, null); await flush();
  assert.equal(posts(h).length, 2); assert.equal(h.state.finishes.length, 0); assert.deepEqual(events, []);
});

test('A to B to A invalidates the original flight generation', async () => {
  const h = paymentHarness(); const c = ready(h); let reply; let calls = 0; const normal = h.state.fetch;
  h.state.fetch = (url, init) => url.endsWith('/restore') && calls++ === 0 ? new Promise(r => { reply = r; }) : normal(url, init);
  const old = c.request('auth_session'); await flush();
  c.setSession('b', B); c.setSession(TOKEN, ACCOUNT); c.request('auth_session');
  reply(activeReply(h)); assert.equal(await old, null); await flush();
  assert.equal(h.state.finishes.length, 1); assert.equal(posts(h).length, 2);
});

test('account switch during history query blocks the old POST', async () => {
  const h = paymentHarness(); const c = ready(h); let reply;
  h.iap.getAvailablePurchases = () => new Promise(r => { reply = r; });
  const old = c.request('auth_session'); await flush(); c.setSession('b', B);
  reply(h.state.purchases); assert.equal(await old, null);
  assert.equal(posts(h).length, 0); assert.equal(h.state.finishes.length, 0);
});

test('account switch during access refresh suppresses the late UI notification', async () => {
  const h = paymentHarness(); const c = ready(h); let reply; let updates = 0; const normal = h.state.fetch;
  h.state.fetch = (url, init) => url.endsWith('/entitlement') ? new Promise(r => { reply = r; }) : normal(url, init);
  c.subscribe(() => { updates++; }); const old = c.request('auth_session'); await flush();
  assert.equal(h.state.finishes.length, 1); c.setSession('b', B);
  reply(h.response({ ok: true, entitlement: { active: true } })); assert.equal(await old, null); assert.equal(updates, 0);
});

for (const history of ['empty', 'owned']) test(`silent ${history} query never syncs, requests purchase, or opens Apple account UI`, async () => {
  const h = paymentHarness(); const c = ready(h); if (history === 'empty') h.state.purchases = [];
  let sync = 0; let queryOptions;
  h.iap.syncIOS = async () => { sync++; throw Error('Apple sign-in must not be requested'); };
  h.iap.getAvailablePurchases = async options => { queryOptions = options; return h.state.purchases; };
  await c.request('auth_session');
  assert.equal(sync, 0); assert.equal(h.state.requests.length, 0);
  assert.deepEqual(queryOptions, { onlyIncludeActiveItemsIOS: false, alsoPublishToEventListenerIOS: false });
  assert.equal(h.state.alerts.length, 0); assert.equal(posts(h).length, history === 'empty' ? 0 : 1);
});

test('manual Restore keeps its query-first and explicit empty-history sync fallback', async () => {
  const h = paymentHarness(); let sync = 0;
  h.iap.syncIOS = async () => { sync++; h.state.purchases = [h.transaction()]; };
  assert.equal((await h.service.restore(TOKEN, ACCOUNT)).ok, true);
  assert.equal(sync, 1); assert.equal(posts(h).length, 1); assert.equal(h.state.finishes.length, 1);
});

test('foreground reconciliation waits for purchase verification, then recovers its failed activation', async () => {
  const h = paymentHarness(); const c = ready(h); let verifyReply; const normal = h.state.fetch;
  h.state.fetch = (url, init) => url.endsWith('/verify') ? new Promise(r => { verifyReply = r; }) : normal(url, init);
  const purchase = h.service.purchase('monthly', TOKEN, ACCOUNT); await flush(); h.emit(h.state.purchases[0]); await flush();
  const recovery = c.request('foreground'); await flush(); assert.equal(posts(h).length, 0);
  verifyReply(h.response({}, 503)); assert.equal((await purchase).activationPending, true);
  assert.equal((await recovery).ok, true); assert.equal(posts(h).length, 1); assert.equal(h.state.finishes.length, 1);
});

test('purchase and manual Restore are blocked during silent reconciliation', async () => {
  const h = paymentHarness(); const c = ready(h); let reply; const normal = h.state.fetch;
  h.state.fetch = (url, init) => url.endsWith('/restore') ? new Promise(r => { reply = r; }) : normal(url, init);
  const p = c.request('foreground'); await flush();
  assert.equal((await h.service.purchase('monthly', TOKEN, ACCOUNT)).code, 'purchase_in_progress');
  assert.equal((await h.service.restore(TOKEN, ACCOUNT)).code, 'purchase_in_progress');
  assert.equal(h.state.requests.length, 0); reply(activeReply(h)); await p;
});

test('silent recovery waits behind manual Restore and never overlaps its POST', async () => {
  const h = paymentHarness(); const c = ready(h); let reply; let calls = 0; const normal = h.state.fetch;
  h.state.fetch = (url, init) => url.endsWith('/restore') && calls++ === 0 ? new Promise(r => { reply = r; }) : normal(url, init);
  const manual = h.service.restore(TOKEN, ACCOUNT); await flush(); const silent = c.request('foreground'); await flush();
  assert.equal(posts(h).length, 1); reply(activeReply(h)); await manual; await silent; assert.equal(posts(h).length, 2);
});

test('retryable item failure stays unfinished and retries with bounded backoff', async () => {
  const h = paymentHarness(); const c = ready(h); const normal = h.state.fetch;
  h.state.fetch = async () => h.response({ ok: true, outcomes: [{ transactionId: 'test-transaction',
    code: 'iap_temporarily_unavailable', granted: false, safeToFinish: false, retryable: true }] });
  assert.equal((await c.request('foreground')).ok, false); assert.equal(h.state.finishes.length, 0);
  await h.advance(4999); assert.equal(posts(h).length, 1);
  await h.advance(1); assert.equal(posts(h).length, 2); assert.equal(h.state.alerts.length, 0);
  h.state.fetch = normal; assert.equal((await c.request('plans_mount')).ok, true); assert.equal(h.state.finishes.length, 1);
});

test('sign-out and root unmount discard a pending response and notification', async () => {
  const h = paymentHarness(); ready(h); let reply;
  h.state.fetch = () => new Promise(r => { reply = r; });
  const hook = h.load('lib/useSubscriptionReconciliation.ts').useSubscriptionReconciliation;
  h.renderHook(hook); await flush(); h.unmountHook(); reply(activeReply(h)); await flush();
  assert.equal(h.state.finishes.length, 0); assert.equal(h.state.alerts.length, 0);
});

test('existing isolated guest session recovers without creating an identity or changing main auth', async () => {
  const h = paymentHarness(); h.state.purchases = [h.transaction()]; const authBefore = h.state.authValue;
  const c = coordinator(h); c.setSession(null, null, true);
  assert.equal((await c.request('auth_session')).ok, true);
  assert.equal(posts(h)[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(h.state.authValue, authBefore); assert.equal(h.state.requests.length, 0);
});

test('guest without a persisted session is skipped rather than signed in anonymously', async () => {
  const h = paymentHarness(); h.auth.getSession = async () => ({ data: { session: null } });
  const c = coordinator(h); c.setSession(null, null, true);
  assert.equal(await c.request('plans_mount'), null); assert.equal(h.state.initCalls, 0); assert.equal(posts(h).length, 0);
});

test('unauthenticated launch performs no StoreKit or backend work', async () => {
  const h = paymentHarness(); const c = coordinator(h); c.setSession(null, null);
  assert.equal(await c.request('auth_session'), null); assert.equal(h.state.http.length, 0); assert.equal(h.state.initCalls, 0);
});

test('post-Apple offline Plans handler uses activation-pending localization, never purchase-failed copy', async () => {
  const h = paymentHarness(); const normal = h.state.fetch;
  h.state.fetch = async (url, init) => url.endsWith('/verify') ? Promise.reject(new TypeError('offline')) : normal(url, init);
  const p = h.plansAction(); await flush(); h.emit(h.transaction()); await p;
  assert.deepEqual(h.state.alerts, [['plans.activationPendingTitle', 'plans.activationPendingBody']]);
  assert.equal(h.state.busy, null); assert.equal(h.state.active, false); assert.equal(h.state.finishes.length, 0);
});

test('all supported locales explain automatic activation and no repurchase', async () => {
  for (const locale of ['en', 'es', 'fr', 'ja', 'ko', 'zh-Hans']) {
    const text = readFileSync(new URL(`../lib/locales/${locale}.mjs`, import.meta.url), 'utf8');
    assert.match(text, /plans.activationPendingTitle/); assert.match(text, /plans.activationPendingBody/);
  }
  const en = readFileSync(new URL('../lib/locales/en.mjs', import.meta.url), 'utf8');
  assert.match(en, /Youmi will retry automatically\. You do not need to purchase again/);
});

for (const status of ['expired', 'revoked']) test(`silent ${status} reconciliation refreshes authoritative access without finishing a denied item`, async () => {
  const h = paymentHarness(); const c = ready(h); let updates = 0;
  c.subscribe(() => { updates++; });
  h.state.fetch = async url => url.endsWith('/restore') ? h.response({ ok: true, entitlement: { active: false, status },
    outcomes: [{ transactionId: 'test-transaction', code: status, granted: false, safeToFinish: false, retryable: false }] })
    : h.response({ ok: true, entitlement: { active: false, status } });
  assert.equal((await c.request('foreground')).code, status);
  assert.equal(updates, 1); assert.equal(h.state.finishes.length, 0); assert.equal(h.state.active, false);
});

test('a failed access read never causes an optimistic UI update', async () => {
  const h = paymentHarness(); const c = ready(h); let updates = 0; const normal = h.state.fetch;
  h.state.fetch = async (url, init) => url.endsWith('/entitlement') ? h.response({}, 503) : normal(url, init);
  c.subscribe(() => { updates++; }); await c.request('foreground');
  assert.equal(updates, 0); assert.equal(h.state.active, true, 'backend persisted the grant');
});

test('actual Settings subscriber refreshes its own guarded plan after silent recovery', async () => {
  const h = paymentHarness(); const c = ready(h); let status;
  const loadPlan = h.handler('app/(tabs)/settings.tsx', 'loadPlan', { ...h.common, setPlanStatus: value => { status = value; } });
  const cleanup = h.effect('app/(tabs)/settings.tsx', 'subscriptionReconciliation.subscribe', {
    subscriptionReconciliation: c, screenIdentity: ACCOUNT, isGuest: false,
    loadPlan, loadGuestPlan: async () => { throw Error('foreign UI refresh'); },
  })();
  await c.request('auth_session'); await flush();
  assert.equal(status.entitlement.active, true); cleanup();
});

test('root effect remount invalidates its old flight and recovers without duplicate connection listeners', async () => {
  const h = paymentHarness(); h.state.purchases = [h.transaction()];
  const hook = h.load('lib/useSubscriptionReconciliation.ts').useSubscriptionReconciliation;
  h.renderHook(hook); h.unmountHook(); h.renderHook(hook); await flush();
  assert.equal(h.state.active, true); assert.equal(posts(h).length, 1);
  assert.deepEqual(h.listenerCounts(), { updates: 1, errors: 1 }); h.unmountHook();
});

test('loss of session credentials invalidates an old response even before user metadata clears', async () => {
  const h = paymentHarness(); const c = ready(h); let reply;
  h.state.fetch = () => new Promise(r => { reply = r; });
  const p = c.request('auth_session'); await flush(); c.setSession(null, ACCOUNT);
  reply(activeReply(h)); assert.equal(await p, null); assert.equal(h.state.finishes.length, 0);
});

test('account switch between authorized finishes prevents finishing the next item under a stale session', async () => {
  const h = paymentHarness(); const c = ready(h);
  h.state.purchases.push(h.transaction(MONTHLY, 'second'));
  let completedFinish;
  h.iap.finishTransaction = args => { h.state.finishes.push(args); return new Promise(r => { completedFinish = r; }); };
  const p = c.request('auth_session'); await flush(); assert.equal(h.state.finishes.length, 1);
  c.setSession('b', B); completedFinish(); assert.equal(await p, null);
  assert.equal(h.state.finishes.length, 1);
});

for (const other of ['foreign', 'retryable']) test(`mixed owned/${other} outcomes still refresh persisted access without finishing the other item`, async () => {
  const h = paymentHarness(); const c = ready(h); let updates = 0;
  h.state.purchases.push({ ...h.transaction(MONTHLY, 'other'), appAccountToken: B });
  c.subscribe(() => { updates++; });
  h.state.fetch = async url => url.endsWith('/restore') ? h.response({ ok: true,
    alreadyLinked: other === 'foreign', entitlement: { active: true }, outcomes: [
      { transactionId: 'test-transaction', code: 'active', granted: true, safeToFinish: true, retryable: false },
      { transactionId: 'other', code: other === 'foreign' ? 'iap_already_linked' : 'iap_temporarily_unavailable',
        granted: false, safeToFinish: false, retryable: other === 'retryable' },
    ] }) : h.response({ ok: true, entitlement: { active: true } });
  const result = await c.request('foreground');
  assert.equal(result.ok, other === 'foreign'); assert.equal(updates, 1);
  assert.deepEqual(h.state.finishes.map(x => x.purchase.transactionId), ['test-transaction']);
  assert.equal(h.state.alerts.length, 0);
});
