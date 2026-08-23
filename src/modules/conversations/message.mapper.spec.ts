import { describe, expect, it } from '@jest/globals';
import { toProductGraphql } from '../catalog/catalog.mapper.js';
import type { CatalogService } from '../catalog/catalog.service.js';
import type { CatalogProduct } from '../catalog/types.js';
import { mapMessages } from './message.mapper.js';

const product: CatalogProduct = {
  id: '0198a122-0c00-7000-8000-000000000013',
  providerId: 'daiso',
  productCode: 'lip-balm',
  title: '립밤',
  imageUrl: 'https://example.com/lip-balm.jpg',
  affiliate: false,
  relevanceBucket: 3,
  inStock: true,
  totalAmountMinor: '1000',
  deliveryEstimateDays: null,
  ratingConfidence: 1,
  freshnessEpochMs: 1_786_460_400_000,
  outboundUrl: 'https://example.com/lip-balm',
  store: null,
  inventory: null,
  evidence: [],
};

describe('mapMessages', () => {
  it('restores an archived ask_user part for the GraphQL union', async () => {
    const messages = await mapMessages(
      [
        {
          id: '0198a122-0c00-7000-8000-000000000011',
          conversationId: '0198a122-0c00-7000-8000-000000000010',
          role: 'assistant',
          status: 'completed',
          createdAt: new Date('2026-08-14T00:00:00Z'),
        },
      ],
      [
        {
          id: '0198a122-0c00-7000-8000-000000000012',
          messageId: '0198a122-0c00-7000-8000-000000000011',
          kind: 'ask_user',
          position: 0,
          payload: {
            question: '예산은 어느 정도인가요?',
            options: [
              { id: 'under-3', label: '3만원 이하' },
              { id: 'under-5', label: '5만원 이하' },
            ],
            allowFreeText: true,
            providerIds: ['oliveyoung'],
          },
        },
      ],
      {} as CatalogService,
    );
    expect(messages[0]?.parts).toEqual([
      {
        __typename: 'AskUserMessagePart',
        id: '0198a122-0c00-7000-8000-000000000012',
        question: '예산은 어느 정도인가요?',
        options: [
          { id: 'under-3', label: '3만원 이하' },
          { id: 'under-5', label: '5만원 이하' },
        ],
        allowFreeText: true,
      },
    ]);
  });

  it('uses a stored product snapshot after the catalog cache is cleared', async () => {
    const snapshot = toProductGraphql(product);
    const messages = await mapMessages(
      [
        {
          id: '0198a122-0c00-7000-8000-000000000011',
          conversationId: '0198a122-0c00-7000-8000-000000000010',
          role: 'assistant',
          status: 'completed',
          createdAt: new Date('2026-08-14T00:00:00Z'),
        },
      ],
      [
        {
          id: '0198a122-0c00-7000-8000-000000000012',
          messageId: '0198a122-0c00-7000-8000-000000000011',
          kind: 'product_reference',
          position: 0,
          payload: {
            productId: product.id,
            aiSummary:
              '건조함을 줄이는 데 쓸 수 있고 재고가 확인된 립밤이에요.',
            productSnapshot: {
              ...snapshot,
              offer: {
                ...snapshot.offer,
                observedAt: snapshot.offer.observedAt.toISOString(),
              },
            },
          },
        },
      ],
      { getProduct: () => Promise.resolve(null) } as unknown as CatalogService,
    );

    expect(messages[0]?.parts).toEqual([
      expect.objectContaining({
        __typename: 'ProductReferenceMessagePart',
        product: expect.objectContaining({ id: product.id }),
      }),
    ]);
  });

  it('maps new and legacy product references without fabricating summaries', async () => {
    const messages = await mapMessages(
      [
        {
          id: '0198a122-0c00-7000-8000-000000000011',
          conversationId: '0198a122-0c00-7000-8000-000000000010',
          role: 'assistant',
          status: 'completed',
          createdAt: new Date('2026-08-14T00:00:00Z'),
        },
      ],
      [
        {
          id: '0198a122-0c00-7000-8000-000000000012',
          messageId: '0198a122-0c00-7000-8000-000000000011',
          kind: 'product_reference',
          position: 0,
          payload: {
            productId: product.id,
            aiSummary:
              '건조함을 줄이는 데 쓸 수 있고 재고가 확인된 립밤이에요.',
          },
        },
        {
          id: '0198a122-0c00-7000-8000-000000000014',
          messageId: '0198a122-0c00-7000-8000-000000000011',
          kind: 'product_reference',
          position: 1,
          payload: { productId: product.id },
        },
      ],
      {
        getProduct: () => Promise.resolve(product),
      } as unknown as CatalogService,
    );

    expect(messages[0]?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          __typename: 'ProductReferenceMessagePart',
          aiSummary: '건조함을 줄이는 데 쓸 수 있고 재고가 확인된 립밤이에요.',
        }),
        expect.objectContaining({
          __typename: 'ProductReferenceMessagePart',
          aiSummary: null,
        }),
      ]),
    );
  });
});
