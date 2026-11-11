# Offer-code redemption ("有优惠码？兑换")

Branch: `bot/ipad/offer-code-redeem`. Status: **client ready, gated OFF**. Backend work is still needed before turning it on.

## What the app does

- **Plans** (and **Settings → Plan** for signed-in users) shows "Have an offer code? Redeem" / "有优惠码？兑换". It appears only when
  `OFFER_CODES_LIVE` is on (`EXPO_PUBLIC_OFFER_CODES_LIVE=true` **and** `EXPO_PUBLIC_SUBSCRIPTIONS_LIVE=true`) and the platform is iOS.
- Tapping it calls `expo-iap`'s `presentCodeRedemptionSheetIOS()`. That function already ships in the installed expo-iap 4.3.1
  (`ios/ExpoIapModule.swift`), so there is **no dependency upgrade and no native/config-plugin change**.
- Apple's sheet validates the code, shows the discounted price and charges. The app never sees the typed code.
- The redeemed transaction arrives on the existing `purchaseUpdatedListener`. It has no `appAccountToken`, so it is deferred and
  then handed to `subscriptionReconciliation`, which runs a silent restore (`/api/iap/restore`). After the sheet closes the UI also
  triggers `offer_code_redeemed`, which keeps the bounded retry episode going if the transaction lands a few seconds late. Access is
  only ever read back from the backend. Nothing is granted locally.

## Blocker: the backend rejects token-less subscriptions (production monorepo, not changed here)

Apple's redemption sheet (and the App Store redemption URL) **cannot attach an `appAccountToken`**. The backend currently requires one:

- `server/iapSubscriptions.mjs` `assertSubscriptionIdentity()` throws `SubscriptionAccountTokenError` when it is missing.
- `persist_verified_subscription` (migration `20261004021500_early_renewal_entitlement.sql`) rejects a null token and requires
  `token = user_id`.

**Result today:** someone who redeems YOUMIDY30 and similar codes is charged the discounted price, but restore does not grant Student
Access. This applies to codes shared on social media too, with or without this button.

What the backend needs (proposal, for the backend owner):

1. In restore/verify, when an auto-renewable transaction is Apple-verified, has `offerType = 3`, **no** `appAccountToken` and **no**
   existing binding, bind it to the authenticated caller and call Apple's **Set App Account Token** endpoint
   (`PUT /inApps/v1/transactions/{originalTransactionId}/appAccountToken`, body `{"appAccountToken": "<user uuid>"}`).
   Then re-fetch the transaction and persist it through the normal path. Future renewals carry the token.
   Keep the existing rule that never takes over a foreign binding.
2. Persist the offer fields. `iapApple.mjs` decodes `offerType` and `offerDiscountType` but drops them. It also does not decode
   `offerIdentifier` or `offerPeriod`, and `rawTransaction` is `null` for subscriptions. None of today's tables
   (`app_store_subscription_states`, `app_store_subscription_bindings`, `apple_iap_transactions`) has an offer column, so
   **per-code attribution is not queryable yet**.

Proposed migration (not applied):

```sql
create table if not exists public.app_store_offer_redemptions (
  transaction_id          text primary key,
  original_transaction_id text not null,
  user_id                 uuid not null references auth.users(id) on delete cascade,
  product_id              text not null,
  offer_type              int  not null,          -- 3 = subscription offer code
  offer_identifier        text,                   -- offer reference name/ID from App Store Connect
  offer_discount_type     text,                   -- PAY_AS_YOU_GO / PAY_UP_FRONT / FREE_TRIAL
  offer_period            text,                   -- ISO 8601, e.g. P3M / P1Y
  price_milli             bigint,
  currency                text,
  storefront              text,
  environment             text not null,
  purchased_at            timestamptz not null,
  created_at              timestamptz not null default now()
);
alter table public.app_store_offer_redemptions enable row level security; -- service role writes only
```

## Attribution SQL (after the table above exists)

`offerIdentifier` identifies the **offer**, not the custom code someone typed. Attribution per platform therefore works only when
each platform code is its own offer in App Store Connect. The six codes were created that way: YOUMIDY30/40, YOUMIXHS30/40 and
YOUMISPH30/40. Check that each offer's identifier contains its platform tag, or adjust the `CASE` below.

```sql
select
  case
    when r.offer_identifier ilike '%DY%'  then 'Douyin 抖音'
    when r.offer_identifier ilike '%XHS%' then 'Xiaohongshu 小红书'
    when r.offer_identifier ilike '%SPH%' then 'WeChat Channels 视频号'
    else 'other'
  end                                        as platform,
  r.offer_identifier,
  r.product_id,
  count(*)                                   as redemptions,
  count(distinct r.user_id)                  as users,
  count(distinct r.user_id) filter (
    where s.status in ('active','grace_period','cancelled_but_active_until_expiry')
      and s.expires_at > now())              as currently_active,
  min(r.purchased_at)                        as first_redeemed,
  max(r.purchased_at)                        as last_redeemed
from public.app_store_offer_redemptions r
left join public.app_store_subscription_states s
  on s.original_transaction_id = r.original_transaction_id
where r.offer_type = 3
  and r.environment = 'Production'
group by 1, 2, 3
order by redemptions desc;
```

Until then, use App Store Connect → Sales and Trends (offer code reports by reference name) for redemption counts.

## Turning it on

1. Ship the backend change above (bind + Set App Account Token + offer persistence).
2. Set `EXPO_PUBLIC_OFFER_CODES_LIVE=true` in the EAS production environment.
3. Make a **new App Store build**. It is a JS + env change only, with no native diff, so an EAS Update could also deliver it if the
   project uses updates. This repo ships through store builds.
4. Test on a real device: Apple's redemption sheet does not work in the Simulator. Use a Sandbox tester, or a one-time code from
   App Store Connect.
