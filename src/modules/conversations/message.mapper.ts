import { z } from 'zod';

import type { AssetGraphql } from '../assets/assets.service.js';
import { toProductGraphql } from '../catalog/catalog.mapper.js';
import type { CatalogService } from '../catalog/catalog.service.js';
import type {
  MessageGraphql,
  MessagePartGraphql,
  MessagePartRecord,
  MessageRecord,
} from './conversation.types.js';

const textPayload = z.object({ text: z.string() });
const moneyPayload = z.object({
  amountMinor: z.string(),
  currency: z.string(),
});
const productOfferPayload = z
  .object({
    id: z.uuid(),
    price: moneyPayload,
    shipping: moneyPayload,
    total: moneyPayload,
    isInStock: z.boolean(),
    availability: z.enum(['IN_STOCK', 'OUT_OF_STOCK', 'UNKNOWN']).optional(),
    deliveryExpectedAt: z.coerce.date().nullable(),
    observedAt: z.coerce.date(),
    outboundUrl: z.url(),
  })
  .transform((offer) => ({
    ...offer,
    availability: offer.availability ?? 'UNKNOWN',
  }));
const productSnapshotPayload = z.object({
  id: z.uuid(),
  provider: z.object({ providerId: z.string(), displayName: z.string() }),
  title: z.string(),
  imageUrl: z.url(),
  isAffiliate: z.boolean(),
  isSaved: z.boolean(),
  offer: productOfferPayload,
});
const productPayload = z
  .object({
    productId: z.uuid(),
    aiSummary: z.string().trim().min(1).max(80).optional(),
    productSnapshot: productSnapshotPayload.nullish(),
  })
  .refine(
    ({ productId, productSnapshot }) =>
      !productSnapshot || productSnapshot.id === productId,
    {
      message: 'Product snapshot ID must match the reference',
      path: ['productSnapshot'],
    },
  );
const askUserPayload = z.object({
  question: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string() })),
  allowFreeText: z.boolean(),
});
const toolPayload = z.object({
  toolName: z.string(),
  status: z.enum(['STARTED', 'COMPLETED', 'FAILED']),
});
export const imagePayload = z.object({ id: z.uuid() });

const mapPart = async (
  part: MessagePartRecord,
  catalog: CatalogService,
  assets: ReadonlyMap<string, AssetGraphql>,
): Promise<MessagePartGraphql | null> => {
  if (part.kind === 'text') {
    const payload = textPayload.safeParse(part.payload);
    return payload.success
      ? { __typename: 'TextMessagePart', id: part.id, text: payload.data.text }
      : null;
  }
  if (part.kind === 'product_reference') {
    const payload = productPayload.safeParse(part.payload);
    if (!payload.success) return null;
    const product =
      payload.data.productSnapshot ??
      (await catalog
        .getProduct(payload.data.productId)
        .then((result) => (result ? toProductGraphql(result) : null)));
    return product
      ? {
          __typename: 'ProductReferenceMessagePart',
          id: part.id,
          product,
          aiSummary: payload.data.aiSummary ?? null,
        }
      : null;
  }
  if (part.kind === 'ask_user') {
    const payload = askUserPayload.safeParse(part.payload);
    return payload.success
      ? { __typename: 'AskUserMessagePart', id: part.id, ...payload.data }
      : null;
  }
  if (part.kind === 'tool_status') {
    const payload = toolPayload.safeParse(part.payload);
    return payload.success
      ? { __typename: 'ToolStatusMessagePart', id: part.id, ...payload.data }
      : null;
  }
  if (part.kind === 'image') {
    const payload = imagePayload.safeParse(part.payload);
    if (!payload.success) return null;
    const asset = assets.get(payload.data.id);
    return asset
      ? { __typename: 'ImageMessagePart', id: part.id, asset }
      : null;
  }
  return null;
};

export const mapMessages = async (
  records: ReadonlyArray<MessageRecord>,
  parts: ReadonlyArray<MessagePartRecord>,
  catalog: CatalogService,
  assets: ReadonlyMap<string, AssetGraphql> = new Map(),
): Promise<ReadonlyArray<MessageGraphql>> => {
  const partsByMessage = new Map<string, Array<MessagePartRecord>>();
  for (const part of parts) {
    const current = partsByMessage.get(part.messageId) ?? [];
    current.push(part);
    partsByMessage.set(part.messageId, current);
  }
  return Promise.all(
    records.map(async (message) => {
      const mapped = await Promise.all(
        (partsByMessage.get(message.id) ?? []).map((part) =>
          mapPart(part, catalog, assets),
        ),
      );
      return {
        id: message.id,
        role: message.role.toUpperCase(),
        status: message.status.toUpperCase(),
        parts: mapped.filter((part) => part !== null),
        createdAt: message.createdAt,
      };
    }),
  );
};
