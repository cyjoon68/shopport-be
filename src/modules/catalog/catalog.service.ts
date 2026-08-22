import { Inject, Injectable } from '@nestjs/common';
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
    return { ...result, items: result.items.map(this.validateProduct) };
  };

  public getProduct = async (id: string): Promise<CatalogProduct | null> => {
    const product = await this.provider.getProduct(id);
    return product ? this.validateProduct(product) : null;
  };

  public getProducts = async (
    ids: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<CatalogProduct | null>> =>
    Promise.all(ids.map((id) => this.getProduct(id)));

  public resolveOutboundLink = async (id: string): Promise<string> =>
    this.validateOutboundUrl(await this.provider.resolveOutboundLink(id));

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
