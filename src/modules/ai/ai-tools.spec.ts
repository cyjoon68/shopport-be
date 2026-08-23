import { jest } from '@jest/globals';
import { AiTools } from './ai-tools.js';
import type { CatalogProduct, CatalogSearchResult } from '../catalog/types.js';

const product = (
  id: string,
  providerId = 'daiso',
  totalAmountMinor = '1000',
): CatalogProduct => ({
  id,
  providerId,
  productCode: id,
  title: id,
  imageUrl: 'https://images.example/product.jpg',
  affiliate: false,
  relevanceBucket: 1,
  inStock: true,
  totalAmountMinor,
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

  it('overrides the model provider with a selected retailer and returns five results', async () => {
    const search = jest.fn(
      (
        _query: string,
        _first: number,
        _after: string | null,
        filters: { providerId?: 'daiso' | 'oliveyoung' } = {},
      ): Promise<CatalogSearchResult> =>
        Promise.resolve({
          items: [product('oliveyoung-1', filters.providerId)],
          endCursor: null,
          hasNextPage: false,
        }),
    );
    const getProduct = jest.fn((): Promise<CatalogProduct> =>
      Promise.resolve(product('daiso-1')),
    );
    const session = new AiTools({ search, getProduct }).createSession([
      'oliveyoung',
    ]);

    const result = await session.searchProducts({
      query: '립밤',
      providerId: 'daiso',
    });

    expect(search).toHaveBeenCalledWith('립밤', 5, null, {
      providerId: 'oliveyoung',
    });
    expect(result.items).toHaveLength(1);
    await expect(session.getProduct('daiso-1')).resolves.toBeNull();
    expect(getProduct).not.toHaveBeenCalled();
  });

  it('searches both selected retailers with five results each and returns up to ten', async () => {
    const search = jest.fn(
      (
        _query: string,
        first: number,
        _after: string | null,
        filters: { providerId?: 'daiso' | 'oliveyoung' } = {},
      ): Promise<CatalogSearchResult> => {
        const providerId = filters.providerId ?? 'daiso';
        return Promise.resolve({
          items: Array.from({ length: first }, (_, index) =>
            product(
              `${providerId}-${String(index)}`,
              providerId,
              String(1_000 + index),
            ),
          ),
          endCursor: null,
          hasNextPage: false,
        });
      },
    );
    const session = new AiTools({
      search,
      getProduct: (): Promise<CatalogProduct | null> => Promise.resolve(null),
    }).createSession(['oliveyoung', 'daiso']);

    const result = await session.searchProducts({ query: '립밤' });

    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenNthCalledWith(1, '립밤', 5, null, {
      providerId: 'oliveyoung',
    });
    expect(search).toHaveBeenNthCalledWith(2, '립밤', 5, null, {
      providerId: 'daiso',
    });
    expect(result.items).toHaveLength(10);
  });

  it('does not substitute another retailer when a selected search fails', async () => {
    const search = jest.fn(
      (
        _query: string,
        _first: number,
        _after: string | null,
        filters: { providerId?: 'daiso' | 'oliveyoung' } = {},
      ): Promise<CatalogSearchResult> =>
        filters.providerId === 'oliveyoung'
          ? Promise.reject(new Error('oliveyoung unavailable'))
          : Promise.resolve({ items: [], endCursor: null, hasNextPage: false }),
    );
    const session = new AiTools({
      search,
      getProduct: (): Promise<CatalogProduct | null> => Promise.resolve(null),
    }).createSession(['oliveyoung', 'daiso']);

    await expect(session.searchProducts({ query: '립밤' })).rejects.toThrow(
      'oliveyoung unavailable',
    );
  });
});
