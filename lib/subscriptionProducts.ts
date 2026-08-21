export const SUBSCRIPTION_GROUP_ID = '22109238';
export const SUBSCRIPTION_TERMS_URL = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';
export const SUBSCRIPTION_PRIVACY_URL = 'https://ayden-z0410.github.io/youmi-lens-site/privacy-policy.html';

export const SUBSCRIPTION_PRODUCTS = {
  monthly: {
    plan: 'monthly',
    productId: 'com.aydenz.youmilensipad.student.monthly',
    expectedPeriodUnitIOS: 'month',
  },
  annual: {
    plan: 'annual',
    productId: 'com.aydenz.youmilensipad.student.annual',
    expectedPeriodUnitIOS: 'year',
  },
} as const;

export type SubscriptionPlan = keyof typeof SUBSCRIPTION_PRODUCTS;
export type SubscriptionProductId = (typeof SUBSCRIPTION_PRODUCTS)[SubscriptionPlan]['productId'];

export const SUBSCRIPTION_PRODUCT_IDS = [
  SUBSCRIPTION_PRODUCTS.monthly.productId,
  SUBSCRIPTION_PRODUCTS.annual.productId,
] as const;

export const LEGACY_STUDENT_ACCESS_PRODUCT_IDS = [
  'com.aydenz.youmilensipad.studentbasic30d',
  'com.aydenz.youmilensipad.studentpass30d',
] as const;

const planByProductId = new Map<SubscriptionProductId, SubscriptionPlan>([
  [SUBSCRIPTION_PRODUCTS.monthly.productId, 'monthly'],
  [SUBSCRIPTION_PRODUCTS.annual.productId, 'annual'],
]);

export function planForSubscriptionProductId(productId: string | null | undefined): SubscriptionPlan | null {
  return productId ? planByProductId.get(productId as SubscriptionProductId) ?? null : null;
}

export function isSubscriptionProductId(productId: string | null | undefined): productId is SubscriptionProductId {
  return planForSubscriptionProductId(productId) !== null;
}

export function productIdForPlan(plan: SubscriptionPlan): SubscriptionProductId {
  return SUBSCRIPTION_PRODUCTS[plan].productId;
}
