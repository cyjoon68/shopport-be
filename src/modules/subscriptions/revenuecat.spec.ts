import {
  entitlementUpdateFrom,
  parseRevenueCatWebhook,
  verifyRevenueCatAuthorization,
} from './revenuecat.js';

describe('RevenueCat webhook boundary', () => {
  it('rejects a wrong authorization value', () => {
    expect(verifyRevenueCatAuthorization('Bearer correct', 'correct')).toBe(
      true,
    );
    expect(verifyRevenueCatAuthorization('Bearer wrong', 'correct')).toBe(
      false,
    );
    expect(verifyRevenueCatAuthorization(undefined, 'correct')).toBe(false);
  });

  it('maps only Shopport products to pro entitlement', () => {
    const event = parseRevenueCatWebhook({
      event: {
        id: 'event-1',
        type: 'INITIAL_PURCHASE',
        app_user_id: '0198a122-0c00-7000-8000-000000000001',
        product_id: 'shopport_pro_monthly',
        event_timestamp_ms: 1_786_460_400_000,
        expiration_at_ms: 1_789_052_400_000,
      },
    });
    expect(entitlementUpdateFrom(event)).toEqual({
      accountId: '0198a122-0c00-7000-8000-000000000001',
      key: 'pro',
      productId: 'shopport_pro_monthly',
      expiresAt: new Date(1_789_052_400_000),
      sourceEventAt: new Date(1_786_460_400_000),
    });
  });

  it('does not activate unknown products', () => {
    const event = parseRevenueCatWebhook({
      event: {
        id: 'event-2',
        type: 'INITIAL_PURCHASE',
        app_user_id: '0198a122-0c00-7000-8000-000000000001',
        product_id: 'unknown',
        event_timestamp_ms: 1_786_460_400_000,
      },
    });
    expect(entitlementUpdateFrom(event)).toBeNull();
  });
});
