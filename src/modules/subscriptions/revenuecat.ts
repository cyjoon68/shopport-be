import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const productIds = new Set(['shopport_pro_monthly', 'shopport_pro_annual']);

const webhookSchema = z.object({
  event: z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    app_user_id: z.uuid(),
    product_id: z
      .string()
      .nullable()
      .optional()
      .transform((value) => value ?? null),
    event_timestamp_ms: z.number().int().nonnegative(),
    expiration_at_ms: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .transform((value) => value ?? null),
  }),
});

export type RevenueCatEvent = z.infer<typeof webhookSchema>['event'];

export type EntitlementUpdate = Readonly<{
  accountId: string;
  key: 'pro' | 'trial';
  productId: string | null;
  expiresAt: Date | null;
  sourceEventAt: Date;
}>;

export const parseRevenueCatWebhook = (body: unknown): RevenueCatEvent =>
  webhookSchema.parse(body).event;

const digest = (value: string): Buffer =>
  createHash('sha256').update(value).digest();

export const verifyRevenueCatAuthorization = (
  authorization: string | undefined,
  secret: string,
): boolean => {
  if (!authorization) return false;
  return timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`));
};

export const entitlementUpdateFrom = (
  event: RevenueCatEvent,
): EntitlementUpdate | null => {
  if (!event.product_id || !productIds.has(event.product_id)) return null;
  const sourceEventAt = new Date(event.event_timestamp_ms);
  if (event.type === 'EXPIRATION') {
    return {
      accountId: event.app_user_id,
      key: 'trial',
      productId: null,
      expiresAt: null,
      sourceEventAt,
    };
  }
  const activeTypes = new Set([
    'INITIAL_PURCHASE',
    'RENEWAL',
    'PRODUCT_CHANGE',
    'UNCANCELLATION',
    'SUBSCRIPTION_EXTENDED',
    'TEMPORARY_ENTITLEMENT_GRANT',
    'CANCELLATION',
  ]);
  if (!activeTypes.has(event.type)) return null;
  return {
    accountId: event.app_user_id,
    key: 'pro',
    productId: event.product_id,
    expiresAt:
      event.expiration_at_ms === null ? null : new Date(event.expiration_at_ms),
    sourceEventAt,
  };
};

export const revenueCatPayloadHash = (body: unknown): string =>
  createHash('sha256').update(JSON.stringify(body)).digest('hex');
