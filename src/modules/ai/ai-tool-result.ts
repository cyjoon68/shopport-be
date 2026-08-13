import { toProductGraphql } from '../catalog/catalog.mapper.js';
import type { CatalogProduct } from '../catalog/types.js';

export const toAiProductResult = (
  products: ReadonlyArray<CatalogProduct>,
): Readonly<{
  kind: 'product_cards';
  rankingPolicy: 'neutral-v1';
  products: ReturnType<typeof toProductGraphql>[];
}> => ({
  kind: 'product_cards',
  rankingPolicy: 'neutral-v1',
  products: products.map((product) => toProductGraphql(product)),
});
