import { Inject, Injectable } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service.js';
import type { CatalogProduct, CatalogSearchResult } from '../catalog/types.js';

type CatalogReader = Pick<CatalogService, 'getProduct' | 'search'>;

export type AiToolSession = Readonly<{
  searchProducts: (query: string) => Promise<CatalogSearchResult>;
  getProduct: (id: string) => Promise<CatalogProduct | null>;
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
    };
  };
}
