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

## Backend contract (youmi-lens/youmi-lens#59)

Apple's redemption sheet (and the App Store redemption URL) **cannot attach an `appAccountToken`**. Backend PR
https://github.com/youmi-lens/youmi-lens/pull/59 (migration `20261112090000_offer_code_redemptions.sql`) handles this:

- A verified `offerType = 3` transaction with no token and **no existing binding** is bound to the signed-in caller of
  verify/restore. The server then calls Apple's **Set App Account Token** (best-effort, non-blocking).
- If the chain is already bound to another account, the result is `iap_already_linked`, as before.
- A **Guest** (anonymous) caller gets **403 `iap_account_required`**. A guest binding could never move to a real account. The app
  therefore asks Guests to sign in ("请先登录再兑换优惠码") **before** Apple's sheet opens. If the code still comes back (for
  example from a later restore), the client maps it to `offer_requires_account`, shows the same prompt, and leaves the
  transaction unfinished so it binds after sign-in.
- Every offer-code transaction is recorded in `public.app_store_offer_redemptions` (`user_id, original_transaction_id,
  transaction_id unique, product_id, offer_identifier, offer_type, environment, redeemed_at, created_at`). RLS: service role
  writes; signed-in users can read only their own rows.

**Until #59 is merged, migrated and deployed**, redeeming a code charges the person without granting Student Access, so keep
`EXPO_PUBLIC_OFFER_CODES_LIVE` off.

## Attribution SQL

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
  count(distinct r.original_transaction_id)  as redemptions,     -- one row per offer-period transaction
  count(distinct r.user_id)                  as users,
  count(distinct r.user_id) filter (
    where s.status in ('active','grace_period','cancelled_but_active_until_expiry')
      and s.expires_at > now())              as currently_active,
  min(r.redeemed_at)                        as first_redeemed,
  max(r.redeemed_at)                        as last_redeemed
from public.app_store_offer_redemptions r
left join public.app_store_subscription_states s
  on s.original_transaction_id = r.original_transaction_id and s.user_id = r.user_id
where r.offer_type = 3
  and r.environment = 'Production'
group by 1, 2, 3
order by redemptions desc;
```

Before the backend change is live, use App Store Connect → Sales and Trends (offer code reports by reference name) for redemption counts.

## Turning it on

1. Merge, migrate and deploy backend #59 (bind + Set App Account Token + offer persistence).
2. Set `EXPO_PUBLIC_OFFER_CODES_LIVE=true` in the EAS production environment.
3. Make a **new App Store build**. It is a JS + env change only, with no native diff, so an EAS Update could also deliver it if the
   project uses updates. This repo ships through store builds.
4. Test on a real device: Apple's redemption sheet does not work in the Simulator. Use a Sandbox tester, or a one-time code from
   App Store Connect.
