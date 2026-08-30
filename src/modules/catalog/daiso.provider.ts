import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';

import { fetchCatalogJson } from './catalog-http.js';
import type { CatalogProduct } from './types.js';

const catalogIdNamespace = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const searchBaseUrl = 'https://mcp.aka.page';

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

const toDaisoProduct = (
  product: z.infer<typeof daisoProductSchema>,
  fetchedAt: number,
): CatalogProduct => ({
  id: uuidv5(`daiso:${product.id}`, catalogIdNamespace),
  providerId: 'daiso',
  productCode: product.id,
  title: product.name,
  imageUrl: product.imageUrl,
  affiliate: false,
  relevanceBucket: 2,
  inStock: product.soldOut === false,
  availability:
    product.soldOut === true
      ? 'OUT_OF_STOCK'
      : product.soldOut === false
        ? 'IN_STOCK'
        : 'UNKNOWN',
  totalAmountMinor: String(product.price),
  deliveryEstimateDays: null,
  ratingConfidence: 0,
  freshnessEpochMs: fetchedAt,
  outboundUrl: `https://www.daisomall.co.kr/ds/prd/detail?pdNo=${encodeURIComponent(product.id)}`,
  store: null,
  inventory: null,
  evidence: [{ operation: 'products', fetchedAt }],
});

export const searchDaiso = async (
  fetchImpl: typeof fetch,
  query: string,
  page: number,
  size: number,
): Promise<ReadonlyArray<CatalogProduct>> => {
  const url = new URL('/api/daiso/products', searchBaseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('page', String(page));
  url.searchParams.set('pageSize', String(size));
  const parsed = daisoSearchSchema.parse(
    await fetchCatalogJson(fetchImpl, url),
  );
  const fetchedAt = Date.now();
  return parsed.data.products.map((product) =>
    toDaisoProduct(product, fetchedAt),
  );
};

export const withDaisoInventory = async (
  fetchImpl: typeof fetch,
  product: CatalogProduct,
  location: string,
): Promise<CatalogProduct> => {
  const url = new URL('/api/daiso/inventory', searchBaseUrl);
  url.searchParams.set('productId', product.productCode);
  url.searchParams.set('keyword', location);
  url.searchParams.set('pageSize', '10');
  const parsed = daisoInventorySchema.parse(
    await fetchCatalogJson(fetchImpl, url),
  );
  const stores = parsed.data.storeInventory.stores;
  const inStockStore = stores.find(({ quantity }) => quantity > 0);
  const store = inStockStore ?? stores.at(0);
  const fetchedAt = Date.now();
  const inStock =
    inStockStore !== undefined || parsed.data.storeInventory.inStockCount > 0;
  return {
    ...product,
    inStock,
    availability: inStock ? 'IN_STOCK' : 'OUT_OF_STOCK',
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
