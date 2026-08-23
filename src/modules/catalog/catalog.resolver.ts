import { Args, Query, Resolver } from '@nestjs/graphql';
import { z } from 'zod';

import { CatalogLoader } from './catalog.loader.js';
import type { ProductGraphql } from './catalog.mapper.js';
import { productCursor, toProductGraphql } from './catalog.mapper.js';
import { CatalogService } from './catalog.service.js';

type ProductConnection = Readonly<{
  edges: ReadonlyArray<Readonly<{ cursor: string; node: ProductGraphql }>>;
  pageInfo: Readonly<{
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  }>;
}>;

const searchInputSchema = z.object({
  query: z.string().trim().min(1).max(200),
});
const idSchema = z.uuid();

@Resolver('Product')
export class CatalogResolver {
  public constructor(
    private readonly catalog: CatalogService,
    private readonly loader: CatalogLoader,
  ) {}

  @Query('searchProducts')
  public async searchProducts(
    @Args('input') input: unknown,
    @Args('first') first: number,
    @Args('after') after: string | null,
  ): Promise<ProductConnection> {
    const parsed = searchInputSchema.parse(input);
    const result = await this.catalog.search(parsed.query, first, after);
    const edges = result.items.map((product) => ({
      cursor: productCursor(product.id),
      node: toProductGraphql(product),
    }));
    return {
      edges,
      pageInfo: {
        hasNextPage: result.hasNextPage,
        hasPreviousPage: after !== null,
        startCursor: edges.at(0)?.cursor ?? null,
        endCursor: result.endCursor,
      },
    };
  }

  @Query('product')
  public async product(@Args('id') id: unknown): Promise<ProductGraphql> {
    return toProductGraphql(await this.loader.load(idSchema.parse(id)));
  }
}
