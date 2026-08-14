import { z } from 'zod';
import { toProductGraphql } from '../catalog/catalog.mapper.js';
import type { CatalogService } from '../catalog/catalog.service.js';
import type {
  MessageGraphql,
  MessagePartGraphql,
  MessagePartRecord,
  MessageRecord,
} from './conversation.types.js';

const textPayload = z.object({ text: z.string() });
const productPayload = z.object({ productId: z.uuid() });
const askUserPayload = z.object({
  question: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string() })),
  allowFreeText: z.boolean(),
});
const toolPayload = z.object({
  toolName: z.string(),
  status: z.enum(['STARTED', 'COMPLETED', 'FAILED']),
});
const imagePayload = z.object({
  id: z.uuid(),
  status: z.string(),
  url: z.url().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  createdAt: z.coerce.date(),
});

const mapPart = async (
  part: MessagePartRecord,
  catalog: CatalogService,
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
    const product = await catalog.getProduct(payload.data.productId);
    return product
      ? {
          __typename: 'ProductReferenceMessagePart',
          id: part.id,
          product: toProductGraphql(product),
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
    return payload.success
      ? { __typename: 'ImageMessagePart', id: part.id, asset: payload.data }
      : null;
  }
  return null;
};

export const mapMessages = async (
  records: ReadonlyArray<MessageRecord>,
  parts: ReadonlyArray<MessagePartRecord>,
  catalog: CatalogService,
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
          mapPart(part, catalog),
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
