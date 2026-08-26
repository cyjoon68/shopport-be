import { jest } from '@jest/globals';

import type { CatalogRepository } from './catalog.repository.js';
import { CatalogService } from './catalog.service.js';
import type { CatalogProduct, CatalogProvider } from './types.js';

const product: CatalogProduct = {
  id: '0198a122-0c00-7000-8000-000000000001',
  providerId: 'test',
  productCode: 'product-1',
  title: '상품',
  imageUrl: 'https://images.example.com/product.jpg',
  affiliate: false,
  relevanceBucket: 1,
  inStock: true,
  totalAmountMinor: '1000',
  deliveryEstimateDays: 1,
  ratingConfidence: 1,
  freshnessEpochMs: 1,
  outboundUrl: 'https://evil.example/purchase',
  store: null,
  inventory: null,
  evidence: [{ operation: 'products', fetchedAt: 1 }],
};

describe('CatalogService outbound policy', () => {
  it('rejects purchase links outside the provider allowlist', async () => {
    const provider: CatalogProvider = {
      providerId: 'test',
      capabilities: ['LIVE_QUERY'],
      outboundHosts: ['shop.example'],
      search: () =>
        Promise.resolve({
          items: [product],
          endCursor: null,
          hasNextPage: false,
        }),
    };
    const catalog = new CatalogService(provider, {
      get: () => Promise.resolve(null),
      getMany: () => Promise.resolve([]),
      save: () => Promise.resolve(),
    } as unknown as CatalogRepository);
    await expect(catalog.search('상품', 20, null)).rejects.toThrow(
      'Provider returned a non-allowlisted outbound URL',
    );
  });

  it('returns a validated durable catalog record', async () => {
    const cachedProduct = {
      ...product,
      outboundUrl: 'https://shop.example/purchase',
    };
    const save = jest.fn(() => Promise.resolve());
    const provider: CatalogProvider = {
      providerId: 'test',
      capabilities: ['LIVE_QUERY'],
      outboundHosts: ['shop.example'],
      search: () =>
        Promise.resolve({
          items: [],
          endCursor: null,
          hasNextPage: false,
        }),
    };
    const catalog = new CatalogService(provider, {
      get: () => Promise.resolve(cachedProduct),
      getMany: () => Promise.resolve([]),
      save,
    } as unknown as CatalogRepository);

    await expect(catalog.getProduct(product.id)).resolves.toEqual({
      ...cachedProduct,
      outboundUrl: 'https://shop.example/purchase',
    });
    expect(save).not.toHaveBeenCalled();
  });
});
