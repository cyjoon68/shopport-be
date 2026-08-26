import { Inject, Injectable } from '@nestjs/common';

import { CatalogRepository } from './catalog.repository.js';
import { CATALOG_PROVIDER } from './catalog.tokens.js';
import type {
  CatalogProduct,
  CatalogProvider,
  CatalogSearchInput,
  CatalogSearchResult,
} from './types.js';

@Injectable()
export class CatalogService {
  public constructor(
    @Inject(CATALOG_PROVIDER) private readonly provider: CatalogProvider,
    private readonly repository: CatalogRepository,
  ) {}

  public search = async (
    query: string,
    first: number,
    after: string | null,
    filters: Pick<
      CatalogSearchInput,
      'providerId' | 'budgetMax' | 'location'
    > = {},
  ): Promise<CatalogSearchResult> => {
    const result = await this.provider.search({
      query,
      first: Math.min(Math.max(first, 1), 50),
      after,
      ...filters,
    });
    const items = result.items.map(this.validateProduct);
    await this.repository.save(items);
    return { ...result, items };
  };

  public getProduct = async (id: string): Promise<CatalogProduct | null> => {
    const cached = await this.repository.get(id);
    return cached ? this.validateProduct(cached) : null;
  };

  public getProducts = async (
    ids: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<CatalogProduct | null>> =>
    (await this.repository.getMany(ids)).map((product) =>
      product ? this.validateProduct(product) : null,
    );

  private readonly validateProduct = (
    product: CatalogProduct,
  ): CatalogProduct => ({
    ...product,
    outboundUrl: this.validateOutboundUrl(product.outboundUrl),
  });

  private readonly validateOutboundUrl = (value: string): string => {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !this.provider.outboundHosts.includes(url.hostname)
    ) {
      throw new Error('Provider returned a non-allowlisted outbound URL');
    }
    return url.toString();
  };
}
