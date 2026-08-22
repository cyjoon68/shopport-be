import { AiTools } from './ai-tools.js';
import type { CatalogProduct, CatalogSearchResult } from '../catalog/types.js';

const product = (id: string): CatalogProduct => ({
  id,
  providerId: 'test',
  productCode: id,
  title: id,
  imageUrl: 'https://images.example/product.jpg',
  affiliate: false,
  relevanceBucket: 1,
  inStock: true,
  totalAmountMinor: '1000',
  deliveryEstimateDays: 1,
  ratingConfidence: 1,
  freshnessEpochMs: 1,
  outboundUrl: 'https://shop.example/product',
  store: null,
  inventory: null,
  evidence: [{ operation: 'products', fetchedAt: 1 }],
});

describe('AI read-only tools', () => {
  it('caps a turn at six catalog calls', async () => {
    const catalog = {
      search: (): Promise<CatalogSearchResult> =>
        Promise.resolve({
          items: [product('one')],
          endCursor: null,
          hasNextPage: false,
        }),
      getProduct: (id: string): Promise<CatalogProduct> =>
        Promise.resolve(product(id)),
    };
    const session = new AiTools(catalog).createSession();
    await session.searchProducts({ query: '상품' });
    await session.getProduct('one');
    await session.getProduct('two');
    await session.getProduct('three');
    await session.getProduct('four');
    await session.getProduct('five');
    await expect(session.getProduct('six')).rejects.toThrow(
      'AI tool call limit exceeded',
    );
  });
});
