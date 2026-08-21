/**
 * TEMPORARY preview configuration for the Student Basic subscription page.
 *
 * The real auto-renewable Monthly / Annual subscription products do NOT exist in
 * App Store Connect yet, so `app/plans.tsx` is a VISUAL PREVIEW only:
 *
 *   • SUBSCRIPTIONS_LIVE gates the Subscribe button off. While it is `false`, no
 *     purchase can be made and neither the Monthly nor the Annual card calls the
 *     existing consumable purchase method (`purchaseStudentPass`).
 *   • PREVIEW_PRICES are placeholder display strings shown ONLY while the page is
 *     a preview. They are display-only; no purchase or verification logic reads
 *     them, so they can never influence what a user is actually charged.
 *
 * ── Commercialization V2 (when the subscription products are created) ──
 *   1. Set SUBSCRIPTIONS_LIVE = true.
 *   2. DELETE PREVIEW_PRICES. Render each plan's price from StoreKit's localized
 *      `product.displayPrice` (fetched in lib/purchases.ts) — NEVER from a
 *      hard-coded value. StoreKit is the single source of truth for live prices,
 *      including per-storefront currency and formatting.
 */

/**
 * Release gate. Production defaults to false until ASC products, backend
 * deployment, notifications, and true-device Sandbox verification are complete.
 */
export const SUBSCRIPTIONS_LIVE = process.env.EXPO_PUBLIC_SUBSCRIPTIONS_LIVE === 'true';

/**
 * Placeholder prices for the preview only. Temporary — replace with StoreKit
 * `product.displayPrice` when SUBSCRIPTIONS_LIVE becomes true (see file header).
 */
export const PREVIEW_PRICES = {
  monthly: 'US$4.99',
  annual: 'US$49.99',
} as const;
