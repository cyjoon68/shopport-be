import { Inject, Injectable } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service.js';
import type { CatalogProduct, CatalogSearchResult } from '../catalog/types.js';

type CatalogReader = Pick<CatalogService, 'getProduct' | 'search'>;

export type AiProductSearchInput = Readonly<{
  query: string;
  providerId?: 'daiso' | 'oliveyoung';
  budgetMax?: number;
  location?: string;
}>;

export type AiToolSession = Readonly<{
  searchProducts: (input: AiProductSearchInput) => Promise<CatalogSearchResult>;
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
      searchProducts: async (input): Promise<CatalogSearchResult> => {
        count();
        return this.catalog.search(input.query || '추천 상품', 3, null, {
          providerId: input.providerId ?? 'daiso',
          ...(input.budgetMax === undefined
            ? {}
            : { budgetMax: input.budgetMax }),
          ...(input.location === undefined ? {} : { location: input.location }),
        });
      },
      getProduct: async (id): Promise<CatalogProduct | null> => {
        count();
        return this.catalog.getProduct(id);
      },
    };
  };
}
