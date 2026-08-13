import { Inject, Injectable } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service.js';
import type { CatalogProduct, CatalogSearchResult } from '../catalog/types.js';

type CatalogReader = Pick<CatalogService, 'getProduct' | 'search'>;

export type AiToolSession = Readonly<{
  searchProducts: (query: string) => Promise<CatalogSearchResult>;
  getProduct: (id: string) => Promise<CatalogProduct | null>;
  compareProducts: (
    ids: ReadonlyArray<string>,
  ) => Promise<ReadonlyArray<CatalogProduct>>;
}>;

@Injectable()
export class AiTools {
  public constructor(
    @Inject(CatalogService) private readonly catalog: CatalogReader,
  ) {}

  public createSession = (): AiToolSession => {
    let calls = 0;
    const count = (): void => {
      calls += 1;
      if (calls > 6) throw new Error('AI tool call limit exceeded');
    };
    return {
      searchProducts: async (query): Promise<CatalogSearchResult> => {
        count();
        return this.catalog.search(query || '추천 상품', 4, null);
      },
      getProduct: async (id): Promise<CatalogProduct | null> => {
        count();
        return this.catalog.getProduct(id);
      },
      compareProducts: async (ids): Promise<ReadonlyArray<CatalogProduct>> => {
        count();
        const uniqueIds = [...new Set(ids)];
        if (uniqueIds.length < 2 || uniqueIds.length > 4) {
          throw new Error('compareProducts requires 2 to 4 unique products');
        }
        const products = await Promise.all(
          uniqueIds.map((id) => this.catalog.getProduct(id)),
        );
        return products.filter(
          (product): product is CatalogProduct => product !== null,
        );
      },
    };
  };
}
