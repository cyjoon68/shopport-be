import { Inject, Injectable } from '@nestjs/common';

import { CatalogService } from '../catalog/catalog.service.js';
import { rankProducts } from '../catalog/neutral-ranking.js';
import type { CatalogProduct, CatalogSearchResult } from '../catalog/types.js';
import type { AiProviderId } from './ai-request.js';

type CatalogReader = Pick<CatalogService, 'getProduct' | 'search'>;

type AiProductSearchInput = Readonly<{
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
    const exhaustedProviderIds = new Set<AiProviderId>();
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
        const activeProviderIds = providerIds.filter(
          (providerId) => !exhaustedProviderIds.has(providerId),
        );
        if (activeProviderIds.length === 0)
          throw new Error('Selected providers are unavailable');
        const search = (
          providerId: AiProviderId,
        ): Promise<CatalogSearchResult> =>
          this.catalog.search(input.query || '추천 상품', 5, null, {
            providerId,
            ...(input.budgetMax === undefined
              ? {}
              : { budgetMax: input.budgetMax }),
            ...(input.location === undefined
              ? {}
              : { location: input.location }),
          });
        const results = await Promise.all(
          activeProviderIds.map(async (providerId) => {
            try {
              return { providerId, result: await search(providerId) };
            } catch {
              try {
                return { providerId, result: await search(providerId) };
              } catch {
                exhaustedProviderIds.add(providerId);
                return { providerId, result: null };
              }
            }
          }),
        );
        const successfulResults = results.flatMap(({ result }) =>
          result ? [result] : [],
        );
        const unavailableProviderIds = providerIds.filter((providerId) =>
          exhaustedProviderIds.has(providerId),
        );
        if (successfulResults.length === 0)
          throw new Error('Selected providers are unavailable');
        const [firstResult] = successfulResults;
        if (forcedProviderIds.length > 0) {
          successfulResults.forEach(({ items }) => {
            items.forEach(({ id }) => authorizedProductIds.add(id));
          });
        }
        if (successfulResults.length === 1 && firstResult)
          return {
            ...firstResult,
            unavailableProviderIds,
          };
        return {
          items: rankProducts(
            successfulResults.flatMap(({ items }) => items),
          ).slice(0, 10),
          endCursor: null,
          hasNextPage: successfulResults.some(({ hasNextPage }) => hasNextPage),
          unavailableProviderIds,
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
