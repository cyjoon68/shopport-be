import { CatalogService } from './catalog.service.js';
import type { CatalogProduct, CatalogProvider } from './types.js';

const product: CatalogProduct = {
  id: '0198a122-0c00-7000-8000-000000000001',
  providerId: 'test',
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
      getProduct: () => Promise.resolve(product),
      resolveOutboundLink: () => Promise.resolve(product.outboundUrl),
    };
    const catalog = new CatalogService(provider);
    await expect(catalog.search('상품', 20, null)).rejects.toThrow(
      'Provider returned a non-allowlisted outbound URL',
    );
  });
});
