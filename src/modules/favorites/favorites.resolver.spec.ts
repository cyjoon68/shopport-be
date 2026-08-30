import { describe, expect, it, jest } from '@jest/globals';

import { encodeCursor } from '../../common/cursor.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import type { CatalogService } from '../catalog/catalog.service.js';
import type { CatalogProduct } from '../catalog/types.js';
import type { FavoritesRepository } from './favorites.repository.js';
import { FavoritesResolver } from './favorites.resolver.js';

const accountId = '0198a122-0c00-7000-8000-000000000001';
const request = {
  user: { sessionId: '0198a122-0c00-7000-8000-000000000002', sub: accountId },
} as AuthenticatedRequest;

const product = (id: string): CatalogProduct => ({
  affiliate: false,
  deliveryEstimateDays: null,
  evidence: [],
  freshnessEpochMs: 1_786_460_400_000,
  id,
  imageUrl: `https://example.com/${id}.jpg`,
  inStock: true,
  inventory: null,
  outboundUrl: `https://example.com/${id}`,
  productCode: id,
  providerId: 'daiso',
  ratingConfidence: 1,
  relevanceBucket: 3,
  store: null,
  availability: 'IN_STOCK',
  title: id,
  totalAmountMinor: '1000',
});

describe('FavoritesResolver', () => {
  it('returns a real page after the supplied saved-product cursor', async () => {
    const ids = [
      '0198a122-0c00-7000-8000-000000000010',
      '0198a122-0c00-7000-8000-000000000011',
      '0198a122-0c00-7000-8000-000000000012',
    ];
    const list = jest.fn<
      (
        requestedAccountId: string,
        first: number,
        after: unknown,
      ) => Promise<Array<{ productId: string; savedAt: Date }>>
    >(() =>
      Promise.resolve(
        ids.map((productId, index) => ({
          productId,
          savedAt: new Date(`2026-08-2${String(3 - index)}T00:00:00.000Z`),
        })),
      ),
    );
    const getProducts = jest.fn(() => Promise.resolve(ids.map(product)));
    const resolver = new FavoritesResolver(
      { list } as unknown as FavoritesRepository,
      { getProducts } as unknown as CatalogService,
    );
    const after = encodeCursor({
      createdAt: '2026-08-24T00:00:00.000Z',
      id: '0198a122-0c00-7000-8000-000000000009',
    });

    const result = await resolver.savedProducts(request, 2, after);

    expect(result.edges).toHaveLength(2);
    expect(result.pageInfo).toMatchObject({
      hasNextPage: true,
      hasPreviousPage: true,
    });
    expect(list).toHaveBeenCalledWith(
      accountId,
      2,
      expect.objectContaining({ id: '0198a122-0c00-7000-8000-000000000009' }),
    );
  });

  it('batches saved-state resolution for products in one request', async () => {
    const has = jest.fn(() => Promise.resolve(true));
    const hasMany = jest.fn(() =>
      Promise.resolve(
        new Set([
          '0198a122-0c00-7000-8000-000000000020',
          '0198a122-0c00-7000-8000-000000000021',
        ]),
      ),
    );
    const resolver = new FavoritesResolver(
      { has, hasMany } as unknown as FavoritesRepository,
      {} as CatalogService,
    );

    await expect(
      Promise.all([
        resolver.isSaved(request, {
          id: '0198a122-0c00-7000-8000-000000000020',
        } as never),
        resolver.isSaved(request, {
          id: '0198a122-0c00-7000-8000-000000000021',
        } as never),
      ]),
    ).resolves.toEqual([true, true]);

    expect(hasMany).toHaveBeenCalledTimes(1);
    expect(has).not.toHaveBeenCalled();
  });
});
