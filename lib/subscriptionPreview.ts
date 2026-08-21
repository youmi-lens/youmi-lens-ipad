/**
 * Live-subscription release gate for the Student Access subscription surface.
 *
 * The live surface (real StoreKit product fetch, the Subscribe action, and
 * localized StoreKit prices) is enabled ONLY when
 * `EXPO_PUBLIC_SUBSCRIPTIONS_LIVE=true` is set in the build environment. While
 * the flag is absent/false the Plans screen stays a safe VISUAL PREVIEW:
 *
 *   • SUBSCRIPTIONS_LIVE gates the Subscribe button off. While it is `false`, no
 *     purchase can be made and no product fetch is issued.
 *   • PREVIEW_PRICES are placeholder display strings shown ONLY in preview mode.
 *     They are display-only; no purchase or verification logic reads them, so
 *     they can never influence what a user is actually charged.
 *
 * The existence/status of the products in App Store Connect is a mutable
 * external fact and is intentionally NOT encoded here. This gate is purely a
 * build-time switch: production is live, everything else (dev/preview/CI) stays
 * safely gated unless the flag is explicitly set.
 */

/**
 * Build-time release gate. `true` only when the production build environment
 * sets `EXPO_PUBLIC_SUBSCRIPTIONS_LIVE=true`; defaults to the safe preview in
 * every other environment.
 */
export const SUBSCRIPTIONS_LIVE = process.env.EXPO_PUBLIC_SUBSCRIPTIONS_LIVE === 'true';

/**
 * Preview-only placeholder prices. When SUBSCRIPTIONS_LIVE is true these are
 * never rendered — `app/plans.tsx` uses StoreKit's localized `product.displayPrice`
 * (the single source of truth for live prices, including per-storefront currency).
 */
export const PREVIEW_PRICES = {
  monthly: 'US$4.99',
  annual: 'US$49.99',
} as const;
