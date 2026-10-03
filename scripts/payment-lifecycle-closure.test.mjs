import assert from 'node:assert/strict';
import test from 'node:test';
import { paymentHarness, ACCOUNT, MONTHLY, flush } from './helpers/payment-harness.mjs';
const TOKEN='external-test-token', B='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const posts=h=>h.state.http.filter(x=>x.url.endsWith('/restore'));
const ready=h=>{h.state.purchases=[h.transaction()];const c=h.load('lib/subscriptionReconciliation.ts').subscriptionReconciliation;c.setSession(TOKEN,ACCOUNT);return c;};
for(const mode of ['offline','5xx','timeout']) test(`foreground ${mode} recovery retries without another lifecycle event or purchase`,async()=>{
  const h=paymentHarness(),c=ready(h),normal=h.state.fetch;
  h.state.fetch=(url,init)=>url.endsWith('/restore') ? mode==='offline'?Promise.reject(Error('offline')):mode==='timeout'?new Promise(()=>{}):Promise.resolve(h.response({},503)):normal(url,init);
  const first=c.request('auth_session');await flush();if(mode==='timeout')await h.advance(25_000);await first;
  assert.equal(h.state.finishes.length,0);h.state.fetch=normal;
  await h.advance(5000);assert.equal(posts(h).length,2);assert.equal(h.state.active,true);assert.equal(h.state.finishes.length,1);
  await h.advance(120000);assert.equal(posts(h).length,2);assert.equal(h.state.requests.length,0);
});
test('background suspends retry; foreground resumes the same unfinished transaction',async()=>{
  const h=paymentHarness(),c=ready(h),normal=h.state.fetch;
  h.state.fetch=async()=>h.response({},503);await c.request('auth_session');c.setForeground(false);
  await h.advance(120000);assert.equal(posts(h).length,1);h.state.fetch=normal;c.setForeground(true);
  await c.request('foreground');assert.equal(h.state.finishes.length,1);
});
test('logout cancels a scheduled retry; new account gets only its own credentials',async()=>{
  const h=paymentHarness(),c=ready(h);h.state.fetch=async()=>h.response({},503);
  await c.request('auth_session');c.setSession(null,null);await h.advance(120000);assert.equal(posts(h).length,1);
  h.state.fetch=async()=>h.response({ok:true,alreadyLinked:true,outcomes:[{transactionId:'test-transaction',code:'iap_already_linked',safeToFinish:false,retryable:false}],entitlement:{active:false}});
  c.setSession('token-b',B);await c.request('auth_session');await h.advance(120000);
  assert.equal(posts(h).length,2);assert.equal(posts(h)[1].init.headers.Authorization,'Bearer token-b');assert.equal(h.state.finishes.length,0);
});
test('Apple success with failed immediate verification itself starts automatic recovery',async()=>{
  const h=paymentHarness(),c=ready(h),normal=h.state.fetch;
  h.state.fetch=(url,init)=>url.endsWith('/verify')?Promise.resolve(h.response({},503)):normal(url,init);
  const p=h.service.purchase('monthly',TOKEN,ACCOUNT);await flush();h.emit(h.transaction());
  assert.equal((await p).activationPending,true);await flush();assert.equal(posts(h).length,1);assert.equal(h.state.active,true);assert.equal(h.state.requests.length,1);
  c.dispose();
});
test('late StoreKit update with no in-memory purchase context wakes history recovery',async()=>{
  const h=paymentHarness(),c=ready(h);h.state.purchases=[];await c.request('auth_session');
  h.state.purchases=[h.transaction()];h.emit(h.transaction());await flush();
  assert.equal(posts(h).length,1);assert.equal(h.state.finishes.length,1);assert.equal(h.state.requests.length,0);c.dispose();
});
for(const tier of ['admin','developer'])test(`subscription normalization preserves ${tier} precedence`,()=>{
  const h=paymentHarness(),normalize=h.load('lib/planStatus.ts').normalizePlanStatus;
  const plan={planType:tier,displayName:'Developer',unlimited:true,studentPassActive:true,studentPassExpiry:'2099-01-01T00:00:00Z',entitlement:{active:true,status:'cancelled_but_active_until_expiry'}};
  assert.equal(normalize(plan).planType,tier);assert.equal(normalize(plan).displayName,'Developer');assert.equal(normalize(plan).unlimited,true);
});
test('cached expiry clamps access even without a successful network refresh; cancellation is preserved before expiry',()=>{
  const h=paymentHarness(),normalize=h.load('lib/planStatus.ts').normalizePlanStatus;
  const plan={planType:'student_pass',displayName:'Student Basic',studentPassActive:true,studentPassExpiry:'2026-10-03T12:00:00Z',entitlement:{active:true,status:'cancelled_but_active_until_expiry',productId:MONTHLY,expiresAt:'2026-10-03T12:00:00Z'}};
  assert.equal(normalize(plan,Date.parse('2026-10-03T11:59:59Z')).entitlement.status,'cancelled_but_active_until_expiry');
  const expired=normalize(plan,Date.parse('2026-10-03T12:00:00Z'));assert.equal(expired.entitlement.active,false);assert.equal(expired.studentPassActive,false);assert.equal(expired.planType,'public_trial');
});
test('revoked/refunded cache never becomes active from a stale studentPassActive flag',()=>{
  const h=paymentHarness(),normalize=h.load('lib/planStatus.ts').normalizePlanStatus;
  for(const status of ['revoked','refunded'])assert.equal(normalize({planType:'student_pass',studentPassActive:true,studentPassExpiry:'2099-01-01T00:00:00Z',entitlement:{active:false,status}}).entitlement.active,false);
});

test('native finish failure retries the authorized transaction without changing paid access', async()=>{
  const h=paymentHarness(),c=ready(h);let finishes=0;
  h.iap.finishTransaction=async()=>{finishes++;throw Error('native temporary failure');};
  const first=await c.request('auth_session');assert.equal(first.ok,true);assert.equal(first.finishPending,true);assert.equal(h.state.active,true);
  h.iap.finishTransaction=async()=>{finishes++;};await h.advance(5000);assert.equal(finishes,2);
  await h.advance(120000);assert.equal(finishes,2);assert.equal(h.state.requests.length,0);
});
test('failure of the final access read retries until the active UI can be refreshed', async()=>{
  const h=paymentHarness(),c=ready(h),normal=h.state.fetch;let events=0;c.subscribe(()=>events++);
  h.state.fetch=(url,init)=>url.endsWith('/entitlement')?Promise.reject(Error('offline')):normal(url,init);
  await c.request('auth_session');assert.equal(events,0);h.state.fetch=normal;await h.advance(5000);assert.equal(events,1);assert.equal(h.state.requests.length,0);
});
test('permanent environment rejection does not keep polling an unauthorized test chain', async()=>{
  const h=paymentHarness(),c=ready(h);h.state.fetch=async()=>h.response({ok:true,outcomes:[{transactionId:'test-transaction',code:'iap_environment_not_allowed',safeToFinish:false,granted:false,retryable:false}]});
  await c.request('auth_session');await h.advance(120000);assert.equal(posts(h).length,1);assert.equal(h.state.finishes.length,0);
});

test('persistent backend failure retries on a bounded schedule, then rests until a new lifecycle trigger', async () => {
  const h = paymentHarness(), c = ready(h);
  h.state.fetch = async () => h.response({}, 503);
  await c.request('auth_session');
  for (const delay of [5000, 15000, 30000, 60000, 120000, 300000]) await h.advance(delay);
  assert.equal(posts(h).length, 7, 'one initial attempt plus exactly the six scheduled retries');
  await h.advance(3_600_000);
  assert.equal(posts(h).length, 7, 'no unbounded loop after the episode is exhausted');
  assert.equal(h.state.finishes.length, 0, 'never finishes a transaction the backend did not authorize');
  await c.request('foreground');
  assert.equal(posts(h).length, 8, 'a new lifecycle trigger starts a fresh episode');
  c.dispose();
});
