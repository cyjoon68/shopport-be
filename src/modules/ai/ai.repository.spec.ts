import { describe, expect, it, jest } from '@jest/globals';

import type { Database } from '../../database/database.module.js';
import type { CatalogService } from '../catalog/catalog.service.js';
import type { CatalogProduct } from '../catalog/types.js';
import { AiRepository } from './ai.repository.js';

const product: CatalogProduct = {
  id: '0198a122-0c00-7000-8000-000000000001',
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

describe('AiRepository', () => {
  it('stores a product snapshot with completed recommendations', async () => {
    const returning = jest
      .fn<() => Promise<Array<{ id: string }>>>()
      .mockResolvedValue([{ id: 'run-1' }]);
    const where = jest
      .fn<() => { returning: typeof returning }>()
      .mockReturnValue({ returning });
    const set = jest
      .fn<() => { where: typeof where }>()
      .mockReturnValue({ where });
    const update = jest
      .fn<() => { set: typeof set }>()
      .mockReturnValue({ set });
    const values = jest
      .fn<(value: unknown) => Promise<void>>()
      .mockResolvedValue(undefined);
    const insert = jest
      .fn<(table: unknown) => { values: typeof values }>()
      .mockReturnValue({ values });
    const transaction = {
      update,
      insert,
    };
    const database = {
      transaction: (
        callback: (value: typeof transaction) => Promise<void>,
      ): Promise<void> => callback(transaction),
    } as unknown as Database;
    const getProducts = jest.fn(
      (ids: ReadonlyArray<string>): Promise<Array<CatalogProduct>> =>
        Promise.resolve(ids.length > 0 ? [product] : []),
    );
    const repository = new AiRepository(database, {
      getProducts,
    } as unknown as CatalogService);

    await repository.completeRun(
      '0198a122-0c00-7000-8000-000000000002',
      '0198a122-0c00-7000-8000-000000000003',
      '0198a122-0c00-7000-8000-000000000004',
      '',
      [
        {
          productId: product.id,
          aiSummary: '건조함을 줄이는 데 쓸 수 있고 재고가 확인된 립밤이에요.',
        },
      ],
      {
        dimension: 'purpose',
        question: '어디에서 사용할 건가요?',
        options: [
          { id: 'home', label: '집' },
          { id: 'outside', label: '외출' },
        ],
        allowFreeText: true,
      },
      ['oliveyoung'],
    );

    expect(getProducts).toHaveBeenCalledWith([product.id]);
    expect(values.mock.calls.at(-1)?.[0]).toEqual([
      expect.objectContaining({
        kind: 'ask_user',
        payload: expect.objectContaining({ providerIds: ['oliveyoung'] }),
      }),
      expect.objectContaining({
        kind: 'product_reference',
        payload: expect.objectContaining({
          productId: product.id,
          productSnapshot: expect.objectContaining({ id: product.id }),
        }),
      }),
    ]);
  });

  it('reads the provider filter only from the latest assistant clarification', async () => {
    const latestLimit = jest
      .fn<() => Promise<Array<{ id: string }>>>()
      .mockResolvedValue([{ id: 'assistant-message' }]);
    const latestOrderBy = jest
      .fn<() => { limit: typeof latestLimit }>()
      .mockReturnValue({
        limit: latestLimit,
      });
    const latestWhere = jest
      .fn<() => { orderBy: typeof latestOrderBy }>()
      .mockReturnValue({ orderBy: latestOrderBy });
    const latestInnerJoin = jest
      .fn<() => { where: typeof latestWhere }>()
      .mockReturnValue({ where: latestWhere });
    const latestFrom = jest
      .fn<() => { innerJoin: typeof latestInnerJoin }>()
      .mockReturnValue({ innerJoin: latestInnerJoin });
    const payloadLimit = jest
      .fn<() => Promise<Array<{ payload: unknown }>>>()
      .mockResolvedValue([
        { payload: { providerIds: ['oliveyoung', 'daiso'] } },
      ]);
    const payloadWhere = jest
      .fn<() => { limit: typeof payloadLimit }>()
      .mockReturnValue({ limit: payloadLimit });
    const payloadFrom = jest
      .fn<() => { where: typeof payloadWhere }>()
      .mockReturnValue({ where: payloadWhere });
    const database = {
      select: jest
        .fn()
        .mockReturnValueOnce({ from: latestFrom })
        .mockReturnValueOnce({ from: payloadFrom }),
    } as unknown as Database;
    const repository = new AiRepository(database, {} as CatalogService);

    await expect(
      repository.pendingProviderIds(
        '0198a122-0c00-7000-8000-000000000005',
        '0198a122-0c00-7000-8000-000000000006',
      ),
    ).resolves.toEqual(['oliveyoung', 'daiso']);
  });
});
