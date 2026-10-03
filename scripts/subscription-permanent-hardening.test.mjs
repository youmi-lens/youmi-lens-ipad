import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { paymentHarness, ACCOUNT, MONTHLY, ANNUAL, flush, track } from './helpers/payment-harness.mjs';

const B='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const scoped=(h)=>h.load('lib/billingRequestIdentity.ts').BillingRequestIdentity;

test('backend closed blocks before any StoreKit purchase request',async()=>{
  const h=paymentHarness();h.state.availability=[{productId:MONTHLY,purchasable:false,environment:'Production'}];
  assert.equal((await h.service.purchase('monthly','token-a',ACCOUNT)).code,'sales_closed');
  assert.equal(h.state.requests.length,0);assert.equal(h.state.initCalls,0);
});
test('missing/backend-failed availability fails closed before StoreKit',async()=>{
  const h=paymentHarness();h.state.availability=[];
  assert.equal((await h.service.purchase('monthly','token-a',ACCOUNT)).code,'sales_closed');
  assert.equal(h.state.requests.length,0);
});
test('backend availability and Apple product and master flag are all required by UI',async()=>{
  const h=paymentHarness();const {canPurchaseSubscription}=h.load('lib/subscriptionAvailability.ts');
  const catalog=await h.service.loadProducts();
  const open=[{productId:MONTHLY,purchasable:true,environment:'Production'}];
  assert.equal(canPurchaseSubscription('monthly',catalog,open),true);
  assert.equal(canPurchaseSubscription('monthly',catalog,null),false);
  assert.equal(canPurchaseSubscription('monthly',catalog,open,false),false);
  assert.equal(canPurchaseSubscription('annual',catalog,open),false);
  assert.equal(canPurchaseSubscription('monthly',{monthly:null,annual:null},open),false);
  assert.equal(canPurchaseSubscription('monthly',catalog,[{...open[0],environment:'Sandbox'}]),false);
});
test('same owner purchase uses immutable start credentials, finishes only explicit success',async()=>{
  const h=paymentHarness();const p=h.service.purchase('monthly','token-a',ACCOUNT);await flush();h.emit(h.transaction());
  assert.equal((await p).code,'success');
  const verification=h.state.http.find(x=>x.url.endsWith('/verify'));
  assert.equal(verification.init.headers.Authorization,'Bearer token-a');
  assert.equal(JSON.parse(verification.init.body).purchaseAuthorizationId,'test-admission');
  assert.equal(h.state.finishes.length,1);
});
for(const [payload,expected] of [
  [{ok:false,error:'iap_already_linked'},'already_linked'],
  [{ok:false,reason:'sales_closed'},'sales_closed'],
  [{ok:false,error:'iap_verification_failed'},'backend_verification_failed'],
  [{ok:true,granted:false,reason:'revoked',safeToFinish:false},'revoked'],
  [{ok:true,granted:false,reason:'refunded',safeToFinish:false},'revoked'],
])test(`verify ${expected}/${payload.reason??payload.error} does not finish`,async()=>{
  const h=paymentHarness();h.state.fetch=async()=>h.response(payload);
  const p=h.service.purchase('monthly','token-a',ACCOUNT);await flush();h.emit(h.transaction());
  assert.equal((await p).code,expected);assert.equal(h.state.finishes.length,0);
});
test('duplicate callback verifies and finishes once',async()=>{
  const h=paymentHarness();const p=h.service.purchase('monthly','token-a',ACCOUNT);await flush();
  const tx=h.transaction();h.emit(tx);h.emit(tx);await p;await flush();
  assert.equal(h.state.http.filter(x=>x.url.endsWith('/verify')).length,1);assert.equal(h.state.finishes.length,1);
});
test('late callback with another account token does not verify for current account',async()=>{
  const h=paymentHarness();const p=h.service.purchase('monthly','token-a',ACCOUNT);await flush();
  h.emit({...h.transaction(),appAccountToken:B});await flush();
  assert.equal(h.state.http.filter(x=>x.url.endsWith('/verify')).length,0);
  h.error({code:'E_USER_CANCELLED',productId:MONTHLY});await p;
});
test('account context replacement cannot retag an in-flight verification rejection',async()=>{
  const h=paymentHarness();let finish;
  h.state.fetch=()=>new Promise(resolve=>{finish=resolve;});
  const p=h.service.purchase('monthly','token-a',ACCOUNT);await flush();h.emit(h.transaction());await flush();
  h.service.verificationContext={accountId:B,accessToken:'token-b'};
  finish(h.response({ok:false,error:'iap_already_linked'},409));await p;
  const keys=[...h.service.ownershipRejections.keys()];
  assert.ok(keys.length);assert.ok(keys.every(k=>k.startsWith(ACCOUNT)));assert.equal(h.state.finishes.length,0);
});
test('Restore no history is explicit no_purchase with no finish',async()=>{
  const h=paymentHarness();assert.equal((await h.service.restore('token-a',ACCOUNT)).code,'no_purchase');assert.equal(h.state.finishes.length,0);
});
test('Restore mixed valid/invalid history finishes only authorized item and reports failure',async()=>{
  const h=paymentHarness();h.state.purchases=[h.transaction(MONTHLY,'good'),h.transaction(ANNUAL,'bad')];
  h.state.fetch=async()=>h.response({ok:true,entitlement:{active:true},verifiedTransactionIds:['good','bad'],outcomes:[
    {transactionId:'good',code:'active',granted:true,safeToFinish:true,retryable:false},
    {transactionId:'bad',code:'iap_verification_failed',granted:false,safeToFinish:false,retryable:false},
  ]});
  const result=await h.service.restore('token-a',ACCOUNT);
  assert.equal(result.code,'backend_verification_failed');assert.equal(result.outcomes.length,2);
  assert.deepEqual(h.state.finishes.map(x=>x.purchase.transactionId),['good']);
});
for(const code of ['sales_closed','iap_already_linked','revoked','refunded','iap_temporarily_unavailable'])test(`Restore ${code} never finishes despite legacy verified-ID list`,async()=>{
  const h=paymentHarness();h.state.purchases=[h.transaction()];
  h.state.fetch=async()=>h.response({ok:true,alreadyLinked:code==='iap_already_linked',entitlement:{active:false,status:code},
    verifiedTransactionIds:['test-transaction'],outcomes:[{transactionId:'test-transaction',code,granted:false,safeToFinish:false,retryable:code==='iap_temporarily_unavailable'}]});
  await h.service.restore('token-a',ACCOUNT);assert.equal(h.state.finishes.length,0);
});
test('actual Settings async handler discards a response after account switch',async()=>{
  const h=paymentHarness();let reply;let writes=0;
  const load=h.handler('app/(tabs)/settings.tsx','loadPlan',{...h.common,fetchPlanStatus:()=>new Promise(r=>{reply=r;}),setPlanStatus:()=>{writes++;}});
  const p=load();await flush();h.statusIdentity.setIdentity(B);reply({entitlement:{active:true}});await p;
  assert.equal(writes,0);
});
test('actual Plans async handler discards old and out-of-order status responses',async()=>{
  const h=paymentHarness();let reply;let writes=0;
  const load=h.handler('app/plans.tsx','loadStatus',{...h.common,fetchPlanStatus:()=>new Promise(r=>{reply=r;}),setPlanStatus:()=>{writes++;}});
  const p=load();await flush();h.signedRequestIdentity.setIdentity(B);reply({entitlement:{active:true}});await p;
  assert.equal(writes,0);
});
test('actual purchase UI never shows success for previous account',async()=>{
  const h=paymentHarness();let reply;
  h.state.fetch=()=>new Promise(r=>{reply=r;});
  const action=h.plansAction();await flush();h.emit(h.transaction());await flush();
  h.actionIdentity.setIdentity(B);h.state.busy='purchase';reply(h.response({ok:true,granted:true,safeToFinish:true,entitlement:{active:true}}));await action;
  assert.equal(h.state.alerts.length,0);assert.equal(h.state.refreshes,0);assert.equal(h.state.busy,'purchase','old completion cannot unlock a new account action');
});
test('A to B to A and newer request both invalidate the earlier ticket',()=>{
  const h=paymentHarness(),Guard=scoped(h),guard=new Guard();guard.setIdentity(ACCOUNT);const a=guard.begin();
  guard.setIdentity(B);guard.setIdentity(ACCOUNT);assert.equal(guard.owns(a),false);
  const first=guard.begin(),second=guard.begin();assert.equal(guard.owns(first),false);assert.equal(guard.owns(second),true);
});
test('zh-Hans uses subscription access language',()=>{
  const source=readFileSync(new URL('../lib/locales/zh-Hans.mjs',import.meta.url),'utf8');
  assert.match(source,/"plans.active": "已开通"/);assert.doesNotMatch(source,/活动访问权限/);
});
