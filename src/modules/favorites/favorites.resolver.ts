import {
  Args,
  Context,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import { z } from 'zod';
import { viewerIdFrom, type AuthenticatedRequest } from '../auth/auth.guard.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { productCursor, toProductGraphql } from '../catalog/catalog.mapper.js';
import type { ProductGraphql } from '../catalog/catalog.mapper.js';
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
  public constructor(
    private readonly favorites: FavoritesRepository,
    private readonly catalog: CatalogService,
  ) {}

  @Query('savedProducts')
  public async savedProducts(
    @Context('req') request: AuthenticatedRequest,
    @Args('first') requestedFirst: number,
  ): Promise<ProductConnection> {
    const first = Math.min(Math.max(requestedFirst, 1), 50);
    const ids = await this.favorites.list(viewerIdFrom(request), first);
    const products = (await this.catalog.getProducts(ids)).filter(
      (product) => product !== null,
    );
    const edges = products.map((product) => ({
      cursor: productCursor(product.id),
      node: toProductGraphql(product, true),
    }));
    return {
      edges,
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
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
    return this.favorites.has(viewerIdFrom(request), product.id);
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
}
