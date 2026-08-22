import { toProductGraphql } from '../catalog/catalog.mapper.js';
import type { CatalogProduct } from '../catalog/types.js';

export const toAiProductResult = (
  products: ReadonlyArray<CatalogProduct>,
): Readonly<{
  kind: 'product_cards';
  rankingPolicy: 'neutral-v1';
  products: ReadonlyArray<
    ReturnType<typeof toProductGraphql> &
      Readonly<{
        providerId: string;
        productCode: string;
        productName: string;
        price: number;
        store: CatalogProduct['store'];
        inventory: CatalogProduct['inventory'];
        evidence: ReadonlyArray<
          Readonly<{ operation: 'products' | 'inventory'; fetchedAt: string }>
        >;
        fetchedAt: string;
      }>
  >;
}> => ({
  kind: 'product_cards' as const,
  rankingPolicy: 'neutral-v1' as const,
  products: products.map((product) => ({
    ...toProductGraphql(product),
    providerId: product.providerId,
    productCode: product.productCode,
    productName: product.title,
    price: Number(product.totalAmountMinor),
    store: product.store,
    inventory: product.inventory,
    evidence: product.evidence.map(({ operation, fetchedAt }) => ({
      operation,
      fetchedAt: new Date(fetchedAt).toISOString(),
    })),
    fetchedAt: new Date(product.freshnessEpochMs).toISOString(),
  })),
});
