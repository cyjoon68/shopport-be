import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { z } from 'zod';
import { viewerIdFrom, type AuthenticatedRequest } from '../auth/auth.guard.js';
import { AssetsService } from './assets.service.js';
import type { AssetGraphql, AssetUploadGraphql } from './assets.service.js';

type UserError = Readonly<{
  code: string;
  message: string;
  path: ReadonlyArray<string>;
}>;

type AssetUploadPayload = Readonly<{
  upload: AssetUploadGraphql | null;
  userErrors: ReadonlyArray<UserError>;
}>;

type DeletePayload = Readonly<{
  success: boolean;
  userErrors: ReadonlyArray<UserError>;
}>;

const uploadSchema = z.object({
  conversationId: z.uuid(),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/heic', 'image/heif']),
  byteSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(15 * 1024 * 1024),
});
const idSchema = z.object({ id: z.uuid() });

const invalid = (message: string): UserError => ({
  code: 'VALIDATION_FAILED',
  message,
  path: ['input'],
});

@Resolver('Asset')
export class AssetsResolver {
  public constructor(private readonly assets: AssetsService) {}

  @Query('asset')
  public asset(
    @Context('req') request: AuthenticatedRequest,
    @Args('id') id: string,
  ): Promise<AssetGraphql | null> {
    return this.assets.find(viewerIdFrom(request), id);
  }

  @Mutation('createAssetUpload')
  public async createAssetUpload(
    @Context('req') request: AuthenticatedRequest,
    @Args('input') input: unknown,
  ): Promise<AssetUploadPayload> {
    const parsed = uploadSchema.safeParse(input);
    if (!parsed.success) {
      return {
        upload: null,
        userErrors: [invalid('이미지는 JPEG, PNG, HEIC 15MB 이하여야 합니다.')],
      };
    }
    return {
      upload: await this.assets.createUpload({
        accountId: viewerIdFrom(request),
        ...parsed.data,
      }),
      userErrors: [],
    };
  }

  @Mutation('deleteAsset')
  public async deleteAsset(
    @Context('req') request: AuthenticatedRequest,
    @Args('input') input: unknown,
  ): Promise<DeletePayload> {
    const parsed = idSchema.safeParse(input);
    if (!parsed.success)
      return {
        success: false,
        userErrors: [invalid('자산 ID가 올바르지 않습니다.')],
      };
    return {
      success: await this.assets.delete(viewerIdFrom(request), parsed.data.id),
      userErrors: [],
    };
  }
}
