import { Injectable } from '@nestjs/common';

import { decodePageCursor, encodePageCursor } from '../../common/cursor.js';
import { searchDaiso, withDaisoInventory } from './daiso.provider.js';
import { rankProducts } from './neutral-ranking.js';
import { searchOliveYoung } from './olive-young.provider.js';
import type {
  CatalogProduct,
  CatalogProvider as CatalogProviderContract,
  CatalogSearchInput,
  CatalogSearchResult,
} from './types.js';

const inventoryConcurrency = 4;

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
    const page = decodePageCursor(input.after ?? null);
    const query = input.query.trim();
    if (query.length === 0) {
      return {
        items: [],
        endCursor: null,
        hasNextPage: false,
        unavailableProviderIds: [],
      };
    }
    const size = Math.min(Math.max(input.first, 1), 20);
    const fetchSize = input.budgetMax === undefined ? size : 20;
    const providerId = input.providerId ?? 'daiso';
    const products =
      providerId === 'oliveyoung'
        ? await searchOliveYoung(
            this.#fetchImpl,
            query,
            page,
            fetchSize,
            input.location,
          )
        : await searchDaiso(this.#fetchImpl, query, page, fetchSize);
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
              .map(async (product) => {
                try {
                  return await withDaisoInventory(
                    this.#fetchImpl,
                    product,
                    location,
                  );
                } catch {
                  return {
                    ...product,
                    availability: 'UNKNOWN' as const,
                    inStock: false,
                    inventory: {
                      status: 'unconfirmed' as const,
                      quantity: null,
                      location,
                    },
                  };
                }
              }),
          )),
        );
      }
      items = rankProducts(inventory);
    }
    return {
      items,
      endCursor: encodePageCursor(page + 1),
      hasNextPage: products.length === fetchSize || withinBudget.length > size,
      unavailableProviderIds: [],
    };
  };
}
