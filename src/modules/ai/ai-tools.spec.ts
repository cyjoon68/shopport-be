import { AiTools } from './ai-tools.js';
import type { CatalogProduct, CatalogSearchResult } from '../catalog/types.js';

const product = (id: string): CatalogProduct => ({
  id,
  providerId: 'test',
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
});

describe('AI read-only tools', () => {
  it('compares at most four products and caps a turn at six calls', async () => {
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
    await expect(session.compareProducts(['one', 'two'])).resolves.toHaveLength(
      2,
    );
    await expect(
      session.compareProducts(['one', 'two', 'three', 'four', 'five']),
    ).rejects.toThrow('compareProducts requires 2 to 4 unique products');
    await session.searchProducts('상품');
    await session.getProduct('one');
    await session.getProduct('two');
    await session.getProduct('three');
    await expect(session.getProduct('four')).rejects.toThrow(
      'AI tool call limit exceeded',
    );
  });
});
