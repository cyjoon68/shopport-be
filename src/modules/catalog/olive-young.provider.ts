import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';

import { fetchCatalogJson } from './catalog-http.js';
import type { CatalogProduct } from './types.js';

const catalogIdNamespace = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const searchBaseUrl = 'https://mcp.aka.page';

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
    id: uuidv5(`oliveyoung:${product.goodsNumber}`, catalogIdNamespace),
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

export const searchOliveYoung = async (
  fetchImpl: typeof fetch,
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
  const response = await fetchCatalogJson(fetchImpl, url);
  const products = location
    ? oliveYoungInventorySchema.parse(response).data.inventory.products
    : oliveYoungSearchSchema.parse(response).data.products;
  const fetchedAt = Date.now();
  return products.map((product) =>
    toOliveYoungProduct(product, fetchedAt, location),
  );
};
