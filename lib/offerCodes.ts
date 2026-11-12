import { Platform } from 'react-native';

import { SUBSCRIPTIONS_LIVE } from './subscriptionPreview';

/**
 * Build-time release gate for the in-app "Redeem offer code" entry (Plans + Settings).
 *
 * Default OFF. It is `true` only when the build sets `EXPO_PUBLIC_OFFER_CODES_LIVE=true` AND the live subscription
 * surface is on. Why a separate gate: Apple's offer-code sheet cannot attach an `appAccountToken` to the redeemed
 * transaction. The backend binds token-less offer codes to the signed-in account only after youmi-lens#59 is deployed;
 * before that a redemption would charge the person without granting Student Access, so turn this on only after that
 * deploy. See docs/offer-codes.md.
 */
export const OFFER_CODES_LIVE = SUBSCRIPTIONS_LIVE && process.env.EXPO_PUBLIC_OFFER_CODES_LIVE === 'true';

/** iOS-only: Apple's redemption sheet does not exist anywhere else. */
export function isOfferCodeRedemptionAvailable(os: string = Platform.OS, live: boolean = OFFER_CODES_LIVE): boolean {
  return live && os === 'ios';
}
