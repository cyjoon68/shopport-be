import { jest } from '@jest/globals';

import { CatalogProvider } from './catalog.provider.js';
import { fetchCatalogJson } from './catalog-http.js';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });

const requestUrl = (input: Parameters<typeof fetch>[0]): URL =>
  new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );

const retailerProvider = (): Readonly<{
  provider: CatalogProvider;
  urls: Array<URL>;
}> => {
  const urls: URL[] = [];
  const fetchImpl: typeof fetch = (input) => {
    const url = requestUrl(input);
    urls.push(url);
    if (url.pathname === '/api/daiso/products') {
      return Promise.resolve(
        jsonResponse({
          success: true,
          data: {
            products: [
              {
                id: 'expensive',
                name: '비싼 수납함',
                price: 5000,
                imageUrl: 'https://cdn.daisomall.co.kr/expensive.jpg',
                soldOut: false,
              },
              {
                id: '1049516',
                name: '패브릭 수납박스',
                price: 3000,
                imageUrl: 'https://cdn.daisomall.co.kr/box.jpg',
                soldOut: false,
              },
            ],
          },
        }),
      );
    }
    if (url.pathname === '/api/daiso/inventory') {
      return Promise.resolve(
        jsonResponse({
          success: true,
          data: {
            storeInventory: {
              inStockCount: 1,
              stores: [
                {
                  storeCode: 'ST001',
                  storeName: '다이소 강남역점',
                  address: '서울 강남구',
                  distance: '0.5',
                  quantity: 4,
                },
              ],
            },
          },
        }),
      );
    }
    if (url.pathname === '/api/oliveyoung/inventory') {
      return Promise.resolve(
        jsonResponse({
          success: true,
          data: {
            inventory: {
              products: [
                {
                  goodsNumber: 'A000000241365',
                  goodsName: '생기 립밤',
                  imageUrl: 'https://image.oliveyoung.co.kr/lip.jpg',
                  priceToPay: 18900,
                  inStock: true,
                  storeInventory: {
                    inStockCount: 1,
                    stores: [
                      {
                        storeCode: 'D176',
                        storeName: '올리브영 명동 타운',
                        address: '서울 중구',
                        distance: 0.2,
                        remainQuantity: 3,
                        stockStatus: 'in_stock',
                      },
                    ],
                  },
                },
              ],
            },
          },
        }),
      );
    }
    throw new Error(`Unexpected URL ${url.href}`);
  };

  const provider = new CatalogProvider();
  provider.useFetch(fetchImpl);
  return { provider, urls };
};

describe('CatalogProvider Daiso', () => {
  it('applies budget and attaches location inventory', async () => {
    const { provider } = retailerProvider();
    const daiso = await provider.search({
      query: '수납함',
      first: 3,
      after: null,
      budgetMax: 4000,
      location: '강남역',
    });

    expect(daiso.items).toHaveLength(1);
    expect(daiso.items[0]).toMatchObject({
      providerId: 'daiso',
      productCode: '1049516',
      totalAmountMinor: '3000',
      inventory: {
        status: 'in_stock',
        quantity: 4,
        location: '강남역',
      },
    });
    expect(daiso.items[0]?.store?.name).toBe('다이소 강남역점');
  });

  it('limits concurrent per-product inventory requests', async () => {
    let active = 0;
    let maximumActive = 0;
    const provider = new CatalogProvider();
    provider.useFetch(async (input) => {
      const url = requestUrl(input);
      if (url.pathname === '/api/daiso/products') {
        return jsonResponse({
          success: true,
          data: {
            products: Array.from({ length: 5 }, (_, index) => ({
              id: `product-${String(index)}`,
              imageUrl: `https://cdn.daisomall.co.kr/${String(index)}.jpg`,
              name: `상품 ${String(index)}`,
              price: 1000,
            })),
          },
        });
      }
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return jsonResponse({
        success: true,
        data: { storeInventory: { inStockCount: 0, stores: [] } },
      });
    });

    await provider.search({
      after: null,
      first: 5,
      location: '서울',
      query: '상품',
    });

    expect(maximumActive).toBeLessThanOrEqual(4);
  });
});

describe('CatalogProvider Olive Young', () => {
  it('attaches location inventory', async () => {
    const { provider } = retailerProvider();
    const oliveYoung = await provider.search({
      query: '립밤',
      first: 3,
      after: null,
      providerId: 'oliveyoung',
      location: '명동',
    });

    expect(oliveYoung.items[0]).toEqual(
      expect.objectContaining({
        providerId: 'oliveyoung',
        productCode: 'A000000241365',
        inventory: {
          status: 'in_stock',
          quantity: 3,
          location: '명동',
        },
      }),
    );
  });
});

describe('CatalogProvider dispatch and ranking', () => {
  it('routes one provider', async () => {
    const { provider, urls } = retailerProvider();
    await provider.search({
      query: '수납함',
      first: 3,
      after: null,
      budgetMax: 4000,
      location: '강남역',
    });
    await provider.search({
      query: '립밤',
      first: 3,
      after: null,
      providerId: 'oliveyoung',
      location: '명동',
    });

    expect(urls.map(({ pathname }) => pathname)).toEqual([
      '/api/daiso/products',
      '/api/daiso/inventory',
      '/api/oliveyoung/inventory',
    ]);
    expect(urls[1]?.searchParams.get('keyword')).toBe('강남역');
    expect(urls[2]?.searchParams.get('storeKeyword')).toBe('명동');
  });

  it('rejects an invalid page cursor instead of fetching the first page', async () => {
    const fetchImpl = jest.fn<typeof fetch>();
    const provider = new CatalogProvider();
    provider.useFetch(fetchImpl);

    await expect(
      provider.search({
        query: '수납함',
        first: 3,
        after: Buffer.from('0').toString('base64url'),
      }),
    ).rejects.toThrow('Invalid cursor');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an invalid page cursor before an empty search returns', async () => {
    const fetchImpl = jest.fn<typeof fetch>();
    const provider = new CatalogProvider();
    provider.useFetch(fetchImpl);

    await expect(
      provider.search({
        query: ' ',
        first: 3,
        after: Buffer.from('0').toString('base64url'),
      }),
    ).rejects.toThrow('Invalid cursor');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('CatalogProvider bounded HTTP', () => {
  it('cancels a non-OK response body without masking the stable error', async () => {
    const cancel = jest
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('cancel failed'));
    const body = new ReadableStream<Uint8Array>({ cancel });

    await expect(
      fetchCatalogJson(
        () => Promise.resolve(new Response(body, { status: 503 })),
        new URL('https://example.com/catalog'),
      ),
    ).rejects.toThrow('Catalog request failed: 503');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels a declared oversized body without masking the stable error', async () => {
    const cancel = jest
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('cancel failed'));
    const body = new ReadableStream<Uint8Array>({ cancel });

    await expect(
      fetchCatalogJson(
        () =>
          Promise.resolve(
            new Response(body, {
              headers: { 'content-length': '1048577' },
              status: 200,
            }),
          ),
        new URL('https://example.com/catalog'),
      ),
    ).rejects.toThrow('Catalog response too large');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('propagates provider failures instead of returning an empty result', async () => {
    const provider = new CatalogProvider();
    provider.useFetch(() =>
      Promise.resolve(jsonResponse({ success: false }, 500)),
    );

    await expect(
      provider.search({ query: '수납함', first: 3, after: null }),
    ).rejects.toThrow('Catalog request failed: 500');
  });

  it('bounds provider request time and response size', async () => {
    let requestSignal: AbortSignal | null = null;
    const provider = new CatalogProvider();
    provider.useFetch((_input, init) => {
      requestSignal = init?.signal ?? null;
      return Promise.resolve(
        jsonResponse({
          success: true,
          data: {
            products: [
              {
                id: 'safe',
                imageUrl: 'https://cdn.daisomall.co.kr/safe.jpg',
                name: '안전한 상품',
                price: 1000,
              },
            ],
          },
        }),
      );
    });

    await provider.search({ after: null, first: 1, query: '상품' });
    expect(requestSignal).toBeInstanceOf(AbortSignal);

    provider.useFetch(() =>
      Promise.resolve(
        jsonResponse({
          padding: 'x'.repeat(1_100_000),
          success: true,
          data: { products: [] },
        }),
      ),
    );
    await expect(
      provider.search({ after: null, first: 1, query: '상품' }),
    ).rejects.toThrow('Catalog response too large');
  });
});
