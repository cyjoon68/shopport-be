import { Inject, Injectable } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service.js';
import { rankProducts } from '../catalog/neutral-ranking.js';
import type { CatalogProduct, CatalogSearchResult } from '../catalog/types.js';
import type { AiProviderId } from './ai-request.js';

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

  public createSession = (
    forcedProviderIds: ReadonlyArray<AiProviderId> = [],
  ): AiToolSession => {
    let calls = 0;
    const authorizedProductIds = new Set<string>();
    const count = (): void => {
      calls += 1;
      if (calls > 6) throw new Error('AI tool call limit exceeded');
    };
    return {
      searchProducts: async (input): Promise<CatalogSearchResult> => {
        count();
        const providerIds =
          forcedProviderIds.length > 0
            ? forcedProviderIds
            : [input.providerId ?? 'daiso'];
        const results = await Promise.all(
          providerIds.map((providerId) =>
            this.catalog.search(input.query || '추천 상품', 5, null, {
              providerId,
              ...(input.budgetMax === undefined
                ? {}
                : { budgetMax: input.budgetMax }),
              ...(input.location === undefined
                ? {}
                : { location: input.location }),
            }),
          ),
        );
        if (forcedProviderIds.length > 0) {
          results.forEach(({ items }) => {
            items.forEach(({ id }) => authorizedProductIds.add(id));
          });
        }
        if (results.length === 1) return results[0] as CatalogSearchResult;
        return {
          items: rankProducts(results.flatMap(({ items }) => items)).slice(
            0,
            10,
          ),
          endCursor: null,
          hasNextPage: results.some(({ hasNextPage }) => hasNextPage),
        };
      },
      getProduct: async (id): Promise<CatalogProduct | null> => {
        count();
        if (forcedProviderIds.length > 0 && !authorizedProductIds.has(id))
          return null;
        const product = await this.catalog.getProduct(id);
        return forcedProviderIds.length === 0 ||
          !product ||
          forcedProviderIds.some(
            (providerId) => providerId === product.providerId,
          )
          ? product
          : null;
      },
    };
  };
}
