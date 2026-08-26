import { Injectable } from '@nestjs/common';
import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';

import { decodePageCursor, encodePageCursor } from '../../common/cursor.js';
import { rankProducts } from './neutral-ranking.js';
import type {
  CatalogProduct,
  CatalogProvider as CatalogProviderContract,
  CatalogSearchInput,
  CatalogSearchResult,
} from './types.js';

const catalogIdNamespace = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const searchBaseUrl = 'https://mcp.aka.page';
const providerTimeoutMilliseconds = 10_000;
const maximumResponseBytes = 1024 * 1024;
const inventoryConcurrency = 4;

const oliveYoungStoreSchema = z.object({
  storeCode: z.string(),
  storeName: z.string(),
  address: z.string(),
  distance: z.number().optional(),
  remainQuantity: z.number().int().optional(),
  stockStatus: z.enum(['in_stock', 'out_of_stock', 'not_sold']),
});

const oliveYoungProductSchema = z.object({
  goodsNumber: z.string().trim().min(1),
  goodsName: z.string().trim().min(1),
  imageUrl: z.url(),
  priceToPay: z.number().int().nonnegative(),
  inStock: z.boolean().optional(),
  storeInventory: z
    .object({
      inStockCount: z.number().int().nonnegative(),
      stores: z.array(oliveYoungStoreSchema),
    })
    .optional(),
});

const daisoProductSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  price: z.number().int().nonnegative(),
  imageUrl: z.url(),
  soldOut: z.boolean().optional(),
});

const daisoStoreSchema = z.object({
  storeCode: z.string(),
  storeName: z.string(),
  address: z.string(),
  distance: z.string().optional(),
  quantity: z.number().int().nonnegative(),
});

const oliveYoungSearchSchema = z.object({
  success: z.literal(true),
  data: z.object({ products: z.array(oliveYoungProductSchema) }),
});

const oliveYoungInventorySchema = z.object({
  success: z.literal(true),
  data: z.object({
    inventory: z.object({ products: z.array(oliveYoungProductSchema) }),
  }),
});

const daisoSearchSchema = z.object({
  success: z.literal(true),
  data: z.object({ products: z.array(daisoProductSchema) }),
});

const daisoInventorySchema = z.object({
  success: z.literal(true),
  data: z.object({
    storeInventory: z.object({
      inStockCount: z.number().int().nonnegative(),
      stores: z.array(daisoStoreSchema),
    }),
  }),
});

const catalogIdFor = (
  providerId: 'oliveyoung' | 'daiso',
  productCode: string,
): string => uuidv5(`${providerId}:${productCode}`, catalogIdNamespace);

const toOliveYoungProduct = (
  product: z.infer<typeof oliveYoungProductSchema>,
  fetchedAt: number,
  location?: string,
): CatalogProduct => {
  const stores = product.storeInventory?.stores ?? [];
  const inStockStore = stores.find(
    ({ stockStatus }) => stockStatus === 'in_stock',
  );
  const store = inStockStore ?? stores.at(0);
  const status = product.storeInventory
    ? inStockStore || product.storeInventory.inStockCount > 0
      ? 'in_stock'
      : 'out_of_stock'
    : location
      ? 'unconfirmed'
      : null;
  return {
    id: catalogIdFor('oliveyoung', product.goodsNumber),
    providerId: 'oliveyoung',
    productCode: product.goodsNumber,
    title: product.goodsName,
    imageUrl: product.imageUrl,
    affiliate: false,
    relevanceBucket: 2,
    inStock: status ? status === 'in_stock' : (product.inStock ?? true),
    totalAmountMinor: String(product.priceToPay),
    deliveryEstimateDays: null,
    ratingConfidence: 0,
    freshnessEpochMs: fetchedAt,
    outboundUrl: `https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=${encodeURIComponent(product.goodsNumber)}`,
    store: store
      ? {
          code: store.storeCode,
          name: store.storeName,
          address: store.address,
          distance:
            store.distance === undefined ? null : String(store.distance),
        }
      : null,
    inventory:
      location && status
        ? {
            status,
            quantity: store?.remainQuantity ?? null,
            location,
          }
        : null,
    evidence: [
      { operation: 'products', fetchedAt },
      ...(location ? [{ operation: 'inventory' as const, fetchedAt }] : []),
    ],
  };
};

const toDaisoProduct = (
  product: z.infer<typeof daisoProductSchema>,
  fetchedAt: number,
): CatalogProduct => ({
  id: catalogIdFor('daiso', product.id),
  providerId: 'daiso',
  productCode: product.id,
  title: product.name,
  imageUrl: product.imageUrl,
  affiliate: false,
  relevanceBucket: 2,
  inStock: product.soldOut !== true,
  totalAmountMinor: String(product.price),
  deliveryEstimateDays: null,
  ratingConfidence: 0,
  freshnessEpochMs: fetchedAt,
  outboundUrl: `https://www.daisomall.co.kr/ds/prd/detail?pdNo=${encodeURIComponent(product.id)}`,
  store: null,
  inventory: null,
  evidence: [{ operation: 'products', fetchedAt }],
});

@Injectable()
export class CatalogProvider implements CatalogProviderContract {
  public readonly providerId = 'catalog';
  public readonly capabilities = ['LIVE_QUERY'] as const;
  public readonly outboundHosts = [
    'www.oliveyoung.co.kr',
    'www.daisomall.co.kr',
  ] as const;

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
    const page = decodePageCursor(input.after ?? null);
    const size = Math.min(Math.max(input.first, 1), 20);
    const fetchSize = input.budgetMax === undefined ? size : 20;
    const providerId = input.providerId ?? 'daiso';
    const products =
      providerId === 'oliveyoung'
        ? await this.searchOliveYoung(query, page, fetchSize, input.location)
        : await this.searchDaiso(query, page, fetchSize);
    const withinBudget = products.filter(
      ({ totalAmountMinor }) =>
        input.budgetMax === undefined ||
        Number(totalAmountMinor) <= input.budgetMax,
    );
    const selected = rankProducts(withinBudget).slice(0, size);
    const location = input.location;
    let items: ReadonlyArray<CatalogProduct> = selected;
    if (location && providerId === 'daiso') {
      const inventory: Array<CatalogProduct> = [];
      for (
        let index = 0;
        index < selected.length;
        index += inventoryConcurrency
      ) {
        inventory.push(
          ...(await Promise.all(
            selected
              .slice(index, index + inventoryConcurrency)
              .map((product) => this.withDaisoInventory(product, location)),
          )),
        );
      }
      items = rankProducts(inventory);
    }
    return {
      items,
      endCursor: encodePageCursor(page + 1),
      hasNextPage: products.length === fetchSize || withinBudget.length > size,
    };
  };

  private readonly searchOliveYoung = async (
    query: string,
    page: number,
    size: number,
    location?: string,
  ): Promise<ReadonlyArray<CatalogProduct>> => {
    const url = new URL(
      location ? '/api/oliveyoung/inventory' : '/api/oliveyoung/products',
      searchBaseUrl,
    );
    url.searchParams.set('keyword', query);
    url.searchParams.set('page', String(page));
    url.searchParams.set('size', String(size));
    if (location) {
      url.searchParams.set('storeKeyword', location);
      url.searchParams.set('storeLimit', '10');
      url.searchParams.set('stockCheckLimit', String(size));
    }
    const response = await this.getJson(url);
    const products = location
      ? oliveYoungInventorySchema.parse(response).data.inventory.products
      : oliveYoungSearchSchema.parse(response).data.products;
    const fetchedAt = Date.now();
    return products.map((product) =>
      toOliveYoungProduct(product, fetchedAt, location),
    );
  };

  private readonly searchDaiso = async (
    query: string,
    page: number,
    size: number,
  ): Promise<ReadonlyArray<CatalogProduct>> => {
    const url = new URL('/api/daiso/products', searchBaseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(size));
    const parsed = daisoSearchSchema.parse(await this.getJson(url));
    const fetchedAt = Date.now();
    return parsed.data.products.map((product) =>
      toDaisoProduct(product, fetchedAt),
    );
  };

  private readonly withDaisoInventory = async (
    product: CatalogProduct,
    location: string,
  ): Promise<CatalogProduct> => {
    const url = new URL('/api/daiso/inventory', searchBaseUrl);
    url.searchParams.set('productId', product.productCode);
    url.searchParams.set('keyword', location);
    url.searchParams.set('pageSize', '10');
    const parsed = daisoInventorySchema.parse(await this.getJson(url));
    const stores = parsed.data.storeInventory.stores;
    const inStockStore = stores.find(({ quantity }) => quantity > 0);
    const store = inStockStore ?? stores.at(0);
    const fetchedAt = Date.now();
    const inStock =
      inStockStore !== undefined || parsed.data.storeInventory.inStockCount > 0;
    return {
      ...product,
      inStock,
      freshnessEpochMs: fetchedAt,
      store: store
        ? {
            code: store.storeCode,
            name: store.storeName,
            address: store.address,
            distance: store.distance ?? null,
          }
        : null,
      inventory: {
        status: inStock ? 'in_stock' : 'out_of_stock',
        quantity: store?.quantity ?? null,
        location,
      },
      evidence: [...product.evidence, { operation: 'inventory', fetchedAt }],
    };
  };

  private readonly getJson = async (url: URL): Promise<unknown> => {
    const response = await this.#fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(providerTimeoutMilliseconds),
    });
    if (!response.ok) {
      throw new Error(`Catalog request failed: ${String(response.status)}`);
    }
    const declaredLength = response.headers.get('content-length');
    if (
      declaredLength !== null &&
      Number(declaredLength) > maximumResponseBytes
    ) {
      throw new Error('Catalog response too large');
    }
    if (!response.body) throw new Error('Catalog response has no body');
    const reader = response.body.getReader();
    const chunks: Array<Buffer> = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumResponseBytes) {
        await reader.cancel();
        throw new Error('Catalog response too large');
      }
      chunks.push(Buffer.from(chunk.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  };
}
