import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CatalogProduct,
  CatalogProvider,
  CatalogSearchInput,
  CatalogSearchResult,
} from './types.js';
import { rankProducts } from './neutral-ranking.js';

const products = [
  {
    id: '0198a122-0c00-7000-8000-000000000001',
    providerId: 'fake',
    title: '오래 쓰는 스테인리스 텀블러 600ml',
    imageUrl: 'https://picsum.photos/seed/shopport-tumbler/800/800',
    affiliate: true,
    relevanceBucket: 3,
    inStock: true,
    totalAmountMinor: '21900',
    deliveryEstimateDays: 1,
    ratingConfidence: 0.96,
    freshnessEpochMs: 1_786_460_400_000,
    outboundUrl: 'https://example.com/products/tumbler',
  },
  {
    id: '0198a122-0c00-7000-8000-000000000002',
    providerId: 'fake',
    title: '초경량 접이식 우산 210g',
    imageUrl: 'https://picsum.photos/seed/shopport-umbrella/800/800',
    affiliate: false,
    relevanceBucket: 3,
    inStock: true,
    totalAmountMinor: '15900',
    deliveryEstimateDays: 2,
    ratingConfidence: 0.91,
    freshnessEpochMs: 1_786_460_300_000,
    outboundUrl: 'https://example.com/products/umbrella',
  },
  {
    id: '0198a122-0c00-7000-8000-000000000003',
    providerId: 'fake',
    title: '저소음 무선 마우스',
    imageUrl: 'https://picsum.photos/seed/shopport-mouse/800/800',
    affiliate: true,
    relevanceBucket: 2,
    inStock: true,
    totalAmountMinor: '18900',
    deliveryEstimateDays: 1,
    ratingConfidence: 0.89,
    freshnessEpochMs: 1_786_460_200_000,
    outboundUrl: 'https://example.com/products/mouse',
  },
  {
    id: '0198a122-0c00-7000-8000-000000000004',
    providerId: 'fake',
    title: '수납형 태블릿 스탠드',
    imageUrl: 'https://picsum.photos/seed/shopport-stand/800/800',
    affiliate: false,
    relevanceBucket: 2,
    inStock: false,
    totalAmountMinor: '12900',
    deliveryEstimateDays: null,
    ratingConfidence: 0.84,
    freshnessEpochMs: 1_786_460_100_000,
    outboundUrl: 'https://example.com/products/stand',
  },
] as const satisfies ReadonlyArray<CatalogProduct>;

const encodeCursor = (id: string): string =>
  Buffer.from(`product:${id}`, 'utf8').toString('base64url');

@Injectable()
export class FakeCatalogProvider implements CatalogProvider {
  public readonly providerId = 'fake';
  public readonly capabilities = ['LIVE_QUERY'] as const;
  public readonly outboundHosts = ['example.com'] as const;

  public search = (input: CatalogSearchInput): Promise<CatalogSearchResult> => {
    const query = input.query.trim().toLocaleLowerCase('ko-KR');
    const ranked = rankProducts(
      products.filter(
        (product) =>
          query.length === 0 ||
          product.title.toLocaleLowerCase('ko-KR').includes(query),
      ),
    );
    const afterIndex = input.after
      ? ranked.findIndex(
          (product) => encodeCursor(product.id) === input.after,
        ) + 1
      : 0;
    const start = Math.max(afterIndex, 0);
    const items = ranked.slice(start, start + input.first);
    const last = items.at(-1);
    return Promise.resolve({
      items,
      endCursor: last ? encodeCursor(last.id) : null,
      hasNextPage: start + items.length < ranked.length,
    });
  };

  public getProduct = (id: string): Promise<CatalogProduct | null> =>
    Promise.resolve(products.find((product) => product.id === id) ?? null);

  public resolveOutboundLink = async (id: string): Promise<string> => {
    const product = await this.getProduct(id);
    if (!product) throw new NotFoundException('Product not found');
    return product.outboundUrl;
  };
}
