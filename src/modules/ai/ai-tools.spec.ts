import { jest } from '@jest/globals';

import type { CatalogProduct, CatalogSearchResult } from '../catalog/types.js';
import { AiTools } from './ai-tools.js';

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
  availability: 'IN_STOCK',
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
          unavailableProviderIds: [],
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
          unavailableProviderIds: [],
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
          unavailableProviderIds: [],
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

  it('returns successful selected-provider products after one failed provider retry', async () => {
    let daisoAttempts = 0;
    let oliveYoungAttempts = 0;
    const search = (
      _query: string,
      _first: number,
      _after: string | null,
      filters: { providerId?: 'daiso' | 'oliveyoung' } = {},
    ): Promise<CatalogSearchResult> => {
      if (filters.providerId === 'oliveyoung') {
        oliveYoungAttempts += 1;
        return Promise.reject(new Error('oliveyoung token=secret unavailable'));
      }
      daisoAttempts += 1;
      return Promise.resolve({
        items: [product('daiso-1', 'daiso')],
        endCursor: null,
        hasNextPage: false,
        unavailableProviderIds: [],
      });
    };
    const session = new AiTools({
      search,
      getProduct: (id): Promise<CatalogProduct | null> =>
        Promise.resolve(product(id, 'daiso')),
    }).createSession(['oliveyoung', 'daiso']);

    const result = await session.searchProducts({ query: '립밤' });

    expect(oliveYoungAttempts).toBe(2);
    expect(daisoAttempts).toBe(1);
    expect(result).toMatchObject({
      items: [expect.objectContaining({ id: 'daiso-1' })],
      unavailableProviderIds: ['oliveyoung'],
    });
    await expect(session.getProduct('daiso-1')).resolves.toMatchObject({
      id: 'daiso-1',
    });
    await expect(session.getProduct('oliveyoung-1')).resolves.toBeNull();

    const nextResult = await session.searchProducts({ query: '보습 립밤' });

    expect(oliveYoungAttempts).toBe(2);
    expect(daisoAttempts).toBe(2);
    expect(nextResult.unavailableProviderIds).toEqual(['oliveyoung']);
  });

  it('retries each selected provider once before reporting every provider unavailable', async () => {
    const attempts = { daiso: 0, oliveyoung: 0 };
    const session = new AiTools({
      search: (
        _query,
        _first,
        _after,
        filters,
      ): Promise<CatalogSearchResult> => {
        const providerId = filters?.providerId ?? 'daiso';
        attempts[providerId] += 1;
        return Promise.reject(new Error('upstream token=secret unavailable'));
      },
      getProduct: (): Promise<CatalogProduct | null> => Promise.resolve(null),
    }).createSession(['oliveyoung', 'daiso']);

    await expect(session.searchProducts({ query: '립밤' })).rejects.toThrow(
      'Selected providers are unavailable',
    );
    await expect(
      session.searchProducts({ query: '보습 립밤' }),
    ).rejects.toThrow('Selected providers are unavailable');
    expect(attempts).toEqual({ daiso: 2, oliveyoung: 2 });
  });

  it('does not call another provider when a single forced provider fails', async () => {
    const attempts = { daiso: 0, oliveyoung: 0 };
    const session = new AiTools({
      search: (
        _query,
        _first,
        _after,
        filters,
      ): Promise<CatalogSearchResult> => {
        const providerId = filters?.providerId ?? 'daiso';
        attempts[providerId] += 1;
        return Promise.reject(new Error('upstream token=secret unavailable'));
      },
      getProduct: (): Promise<CatalogProduct | null> => Promise.resolve(null),
    }).createSession(['oliveyoung']);

    await expect(session.searchProducts({ query: '립밤' })).rejects.toThrow(
      'Selected providers are unavailable',
    );
    expect(attempts).toEqual({ daiso: 0, oliveyoung: 2 });
  });
});
