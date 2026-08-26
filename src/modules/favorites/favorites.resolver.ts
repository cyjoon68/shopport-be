import {
  Args,
  Context,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import DataLoader from 'dataloader';
import { z } from 'zod';

import { decodeCursor, encodeCursor } from '../../common/cursor.js';
import { type AuthenticatedRequest, viewerIdFrom } from '../auth/auth.guard.js';
import type { ProductGraphql } from '../catalog/catalog.mapper.js';
import { toProductGraphql } from '../catalog/catalog.mapper.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { FavoritesRepository } from './favorites.repository.js';

const inputSchema = z.object({ productId: z.uuid() });

type ProductPayload = Readonly<{
  product: ProductGraphql | null;
  userErrors: ReadonlyArray<
    Readonly<{ code: string; message: string; path: string[] }>
  >;
}>;

type ProductConnection = Readonly<{
  edges: ReadonlyArray<Readonly<{ cursor: string; node: ProductGraphql }>>;
  pageInfo: Readonly<{
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  }>;
}>;

@Resolver('Product')
export class FavoritesResolver {
  readonly #savedLoaders = new WeakMap<
    AuthenticatedRequest,
    DataLoader<string, boolean>
  >();

  public constructor(
    private readonly favorites: FavoritesRepository,
    private readonly catalog: CatalogService,
  ) {}

  @Query('savedProducts')
  public async savedProducts(
    @Context('req') request: AuthenticatedRequest,
    @Args('first') requestedFirst: number,
    @Args('after') after: string | null,
  ): Promise<ProductConnection> {
    const first = Math.min(Math.max(requestedFirst, 1), 50);
    const cursor = after ?? null;
    const records = await this.favorites.list(
      viewerIdFrom(request),
      first,
      decodeCursor(cursor),
    );
    const hasNextPage = records.length > first;
    const page = records.slice(0, first);
    const products = await this.catalog.getProducts(
      page.map(({ productId }) => productId),
    );
    const edges = page.flatMap((record, index) => {
      const product = products[index];
      return product
        ? [
            {
              cursor: encodeCursor({
                createdAt: record.savedAt.toISOString(),
                id: record.productId,
              }),
              node: toProductGraphql(product, true),
            },
          ]
        : [];
    });
    return {
      edges,
      pageInfo: {
        hasNextPage,
        hasPreviousPage: cursor !== null,
        startCursor: edges.at(0)?.cursor ?? null,
        endCursor: edges.at(-1)?.cursor ?? null,
      },
    };
  }

  @Mutation('saveProduct')
  public saveProduct(
    @Context('req') request: AuthenticatedRequest,
    @Args('input') input: unknown,
  ): Promise<ProductPayload> {
    return this.setSaved(request, input, true);
  }

  @ResolveField('isSaved')
  public isSaved(
    @Context('req') request: AuthenticatedRequest,
    @Parent() product: ProductGraphql,
  ): Promise<boolean> {
    return this.savedLoader(request).load(product.id);
  }

  @Mutation('unsaveProduct')
  public unsaveProduct(
    @Context('req') request: AuthenticatedRequest,
    @Args('input') input: unknown,
  ): Promise<ProductPayload> {
    return this.setSaved(request, input, false);
  }

  private readonly setSaved = async (
    request: AuthenticatedRequest,
    input: unknown,
    saved: boolean,
  ): Promise<ProductPayload> => {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        product: null,
        userErrors: [
          {
            code: 'VALIDATION_FAILED',
            message: '상품 ID가 올바르지 않습니다.',
            path: ['productId'],
          },
        ],
      };
    }
    const product = await this.catalog.getProduct(parsed.data.productId);
    if (!product) {
      return {
        product: null,
        userErrors: [
          {
            code: 'NOT_FOUND',
            message: '상품을 찾을 수 없습니다.',
            path: ['productId'],
          },
        ],
      };
    }
    if (saved) {
      await this.favorites.save(viewerIdFrom(request), product.id);
    } else {
      await this.favorites.unsave(viewerIdFrom(request), product.id);
    }
    return { product: toProductGraphql(product, saved), userErrors: [] };
  };

  private readonly savedLoader = (
    request: AuthenticatedRequest,
  ): DataLoader<string, boolean> => {
    const existing = this.#savedLoaders.get(request);
    if (existing) return existing;
    const accountId = viewerIdFrom(request);
    const loader = new DataLoader<string, boolean>(async (productIds) => {
      const saved = await this.favorites.hasMany(accountId, productIds);
      return productIds.map((productId) => saved.has(productId));
    });
    this.#savedLoaders.set(request, loader);
    return loader;
  };
}
