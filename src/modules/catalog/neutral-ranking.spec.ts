import { rankProducts } from './neutral-ranking.js';
import type { CatalogProduct } from './types.js';

const product = (
  id: string,
  providerId: string,
  overrides: Partial<CatalogProduct> = {},
): CatalogProduct => ({
  id,
  providerId,
  productCode: id,
  title: id,
  imageUrl: 'https://example.com/product.jpg',
  affiliate: false,
  relevanceBucket: 1,
  inStock: true,
  totalAmountMinor: '10000',
  deliveryEstimateDays: 2,
  ratingConfidence: 0.8,
  freshnessEpochMs: 1,
  outboundUrl: 'https://example.com/products/1',
  store: null,
  inventory: null,
  evidence: [{ operation: 'products', fetchedAt: 1 }],
  ...overrides,
});

describe('rankProducts', () => {
  it('keeps provider and affiliate status outside neutral-v1 ordering', () => {
    const input = [
      product('b', 'coupang', { affiliate: true }),
      product('a', 'daiso', { affiliate: false }),
    ];

    expect(rankProducts(input).map(({ id }) => id)).toEqual(['a', 'b']);
  });

  it('orders by relevance, stock, total price, delivery, confidence, freshness, and id', () => {
    const input = [
      product('stale', 'naver', { freshnessEpochMs: 1 }),
      product('fresh', 'gmarket', { freshnessEpochMs: 2 }),
      product('cheap', 'daiso', { totalAmountMinor: '9000' }),
      product('irrelevant', 'coupang', { relevanceBucket: 0 }),
      product('sold-out', 'coupang', { inStock: false }),
    ];

    expect(rankProducts(input).map(({ id }) => id)).toEqual([
      'cheap',
      'fresh',
      'stale',
      'sold-out',
      'irrelevant',
    ]);
  });
});
