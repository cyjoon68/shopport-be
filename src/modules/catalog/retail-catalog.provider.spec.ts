import { RetailCatalogProvider } from './retail-catalog.provider.js';

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });

describe('RetailCatalogProvider', () => {
  it('maps Olive Young and Daiso search hits into catalog products', async () => {
    const fetchImpl: typeof fetch = (input) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes('/api/oliveyoung/products')) {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: {
              products: [
                {
                  goodsNumber: 'A000000241365',
                  goodsName: '생기 립밤',
                  imageUrl:
                    'https://image.oliveyoung.co.kr/uploads/images/goods/lip.jpg?l=ko',
                  priceToPay: 18900,
                  inStock: true,
                },
              ],
            },
            meta: { page: 1, pageSize: 2, nextPage: false },
          }),
        );
      }
      if (url.includes('/api/daiso/products?')) {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: {
              products: [
                {
                  id: '1049516',
                  name: '패브릭 수납박스',
                  price: 5000,
                  imageUrl: 'https://cdn.daisomall.co.kr/file/PD/box.jpg',
                  soldOut: false,
                },
              ],
            },
          }),
        );
      }
      throw new Error(`Unexpected URL ${url}`);
    };

    const provider = new RetailCatalogProvider();
    provider.useFetch(fetchImpl);
    const result = await provider.search({
      query: '립밤',
      first: 4,
      after: null,
    });

    expect(
      new Set(
        result.items.map(({ providerId, title }) => `${providerId}:${title}`),
      ),
    ).toEqual(new Set(['oliveyoung:생기 립밤', 'daiso:패브릭 수납박스']));
    expect(result.items.map(({ providerId }) => providerId)).toEqual([
      'oliveyoung',
      'daiso',
    ]);
    expect(result.items.every(({ id }) => id.includes('-'))).toBe(true);
    const hostByProvider = Object.fromEntries(
      result.items.map((product) => [
        product.providerId,
        new URL(product.outboundUrl).hostname,
      ]),
    );
    expect(hostByProvider).toEqual({
      oliveyoung: 'www.oliveyoung.co.kr',
      daiso: 'www.daisomall.co.kr',
    });
    await expect(
      provider.getProduct(result.items[0]?.id ?? ''),
    ).resolves.toEqual(result.items[0]);
  });
});
