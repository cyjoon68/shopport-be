import { Injectable } from '@nestjs/common';
import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';
import { rankProducts } from './neutral-ranking.js';
import type {
  CatalogProduct,
  CatalogProvider,
  CatalogSearchInput,
  CatalogSearchResult,
} from './types.js';

const catalogIdNamespace = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const retailSearchBaseUrl = 'https://mcp.aka.page';

const oliveYoungProductSchema = z.object({
  goodsNumber: z.string().trim().min(1),
  goodsName: z.string().trim().min(1),
  imageUrl: z.url(),
  priceToPay: z.number().int().nonnegative(),
  inStock: z.boolean().optional(),
});

const daisoProductSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  price: z.number().int().nonnegative(),
  imageUrl: z.url(),
  soldOut: z.boolean().optional(),
});

const oliveYoungSearchSchema = z.object({
  success: z.literal(true),
  data: z.object({
    products: z.array(oliveYoungProductSchema),
  }),
});

const daisoSearchSchema = z.object({
  success: z.literal(true),
  data: z.object({
    products: z.array(daisoProductSchema),
  }),
});

const catalogIdFor = (
  providerId: 'oliveyoung' | 'daiso',
  sourceId: string,
): string => uuidv5(`${providerId}:${sourceId}`, catalogIdNamespace);

const pageFromCursor = (after: string | null): number => {
  if (!after) return 1;
  const page = Number(Buffer.from(after, 'base64url').toString('utf8'));
  return Number.isInteger(page) && page > 0 ? page : 1;
};

const encodePageCursor = (page: number): string =>
  Buffer.from(String(page), 'utf8').toString('base64url');

const interleave = (
  left: ReadonlyArray<CatalogProduct>,
  right: ReadonlyArray<CatalogProduct>,
): ReadonlyArray<CatalogProduct> => {
  const items: CatalogProduct[] = [];
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftItem = left.at(index);
    const rightItem = right.at(index);
    if (leftItem) items.push(leftItem);
    if (rightItem) items.push(rightItem);
  }
  return items;
};

@Injectable()
export class RetailCatalogProvider implements CatalogProvider {
  public readonly providerId = 'retail';
  public readonly capabilities = ['LIVE_QUERY'] as const;
  public readonly outboundHosts = [
    'www.oliveyoung.co.kr',
    'www.daisomall.co.kr',
  ] as const;

  readonly #products = new Map<string, CatalogProduct>();
  #fetchImpl: typeof fetch = fetch;

  public useFetch = (fetchImpl: typeof fetch): void => {
    this.#fetchImpl = fetchImpl;
  };

  public search = async (
    input: CatalogSearchInput,
  ): Promise<CatalogSearchResult> => {
    const query = input.query.trim();
    if (query.length === 0) {
      return { items: [], endCursor: null, hasNextPage: false };
    }
    const page = pageFromCursor(input.after);
    const size = Math.min(Math.max(input.first, 1), 20);
    const [oliveYoung, daiso] = await Promise.all([
      this.searchOliveYoung(query, page, size).catch(() => []),
      this.searchDaiso(query, page, size).catch(() => []),
    ]);
    const items = interleave(
      rankProducts(oliveYoung),
      rankProducts(daiso),
    ).slice(0, size);
    items.forEach((product) => this.#products.set(product.id, product));
    return {
      items,
      endCursor: encodePageCursor(page + 1),
      hasNextPage: oliveYoung.length + daiso.length > items.length,
    };
  };

  public getProduct = (id: string): Promise<CatalogProduct | null> =>
    Promise.resolve(this.#products.get(id) ?? null);

  public resolveOutboundLink = async (id: string): Promise<string> => {
    const product = await this.getProduct(id);
    if (!product) throw new Error('Product not found');
    return product.outboundUrl;
  };

  private readonly searchOliveYoung = async (
    query: string,
    page: number,
    size: number,
  ): Promise<ReadonlyArray<CatalogProduct>> => {
    const url = new URL('/api/oliveyoung/products', retailSearchBaseUrl);
    url.searchParams.set('keyword', query);
    url.searchParams.set('page', String(page));
    url.searchParams.set('size', String(size));
    const parsed = oliveYoungSearchSchema.parse(await this.getJson(url));
    return parsed.data.products.map((product) => ({
      id: catalogIdFor('oliveyoung', product.goodsNumber),
      providerId: 'oliveyoung',
      title: product.goodsName,
      imageUrl: product.imageUrl,
      affiliate: false,
      relevanceBucket: 2,
      inStock: product.inStock ?? true,
      totalAmountMinor: String(product.priceToPay),
      deliveryEstimateDays: null,
      ratingConfidence: 0,
      freshnessEpochMs: 0,
      outboundUrl: `https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=${encodeURIComponent(product.goodsNumber)}`,
    }));
  };

  private readonly searchDaiso = async (
    query: string,
    page: number,
    size: number,
  ): Promise<ReadonlyArray<CatalogProduct>> => {
    const url = new URL('/api/daiso/products', retailSearchBaseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(size));
    const parsed = daisoSearchSchema.parse(await this.getJson(url));
    return parsed.data.products.map((product) => ({
      id: catalogIdFor('daiso', product.id),
      providerId: 'daiso',
      title: product.name,
      imageUrl: product.imageUrl,
      affiliate: false,
      relevanceBucket: 2,
      inStock: product.soldOut !== true,
      totalAmountMinor: String(product.price),
      deliveryEstimateDays: null,
      ratingConfidence: 0,
      freshnessEpochMs: 0,
      outboundUrl: `https://www.daisomall.co.kr/ds/prd/detail?pdNo=${encodeURIComponent(product.id)}`,
    }));
  };

  private readonly getJson = async (url: URL): Promise<unknown> => {
    const response = await this.#fetchImpl(url, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(
        `Retail catalog request failed: ${String(response.status)}`,
      );
    }
    return response.json();
  };
}
