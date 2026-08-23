import { NotFoundException } from '@nestjs/common';
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { z } from 'zod';

import { type AuthenticatedRequest, viewerIdFrom } from '../auth/auth.guard.js';
import type { ViewerRecord } from './profile.repository.js';
import { ProfileRepository } from './profile.repository.js';

type ViewerGraphql = Readonly<{
  id: string;
  displayName: string;
  profileImageUrl: string | null;
  trialStartedAt: Date;
  trialEndsAt: Date;
  entitlement: Readonly<{
    key: string;
    isActive: boolean;
    productId: string | null;
    expiresAt: Date | null;
  }>;
}>;

type UserError = Readonly<{
  code: string;
  message: string;
  path: ReadonlyArray<string>;
}>;

type ViewerPayload = Readonly<{
  viewer: ViewerGraphql | null;
  userErrors: ReadonlyArray<UserError>;
}>;

const updateViewerSchema = z.object({
  displayName: z.string().trim().min(1).max(30),
});

const viewerGraphql = (viewer: ViewerRecord): ViewerGraphql => {
  const now = new Date();
  const isPro =
    viewer.entitlementKey === 'pro' &&
    (viewer.entitlementExpiresAt === null || viewer.entitlementExpiresAt > now);
  return {
    id: viewer.id,
    displayName: viewer.displayName,
    profileImageUrl: viewer.profileImageUrl,
    trialStartedAt: viewer.trialStartedAt,
    trialEndsAt: viewer.trialEndsAt,
    entitlement: {
      key: isPro ? 'pro' : 'trial',
      isActive: isPro || viewer.trialEndsAt > now,
      productId: viewer.productId,
      expiresAt: isPro ? viewer.entitlementExpiresAt : viewer.trialEndsAt,
    },
  };
};

@Resolver('Viewer')
export class ProfileResolver {
  public constructor(private readonly profiles: ProfileRepository) {}

  @Query('viewer')
  public async viewer(
    @Context('req') request: AuthenticatedRequest,
  ): Promise<ViewerGraphql> {
    const viewer = await this.profiles.viewer(viewerIdFrom(request));
    if (!viewer) throw new NotFoundException('Viewer not found');
    return viewerGraphql(viewer);
  }

  @Mutation('updateViewer')
  public async updateViewer(
    @Context('req') request: AuthenticatedRequest,
    @Args('input') input: unknown,
  ): Promise<ViewerPayload> {
    const parsed = updateViewerSchema.safeParse(input);
    if (!parsed.success) {
      return {
        viewer: null,
        userErrors: [
          {
            code: 'VALIDATION_FAILED',
            message: '닉네임은 1자 이상 30자 이하로 입력해 주세요.',
            path: ['displayName'],
          },
        ],
      };
    }
    const viewer = await this.profiles.updateDisplayName(
      viewerIdFrom(request),
      parsed.data.displayName,
    );
    return {
      viewer: viewer ? viewerGraphql(viewer) : null,
      userErrors: viewer
        ? []
        : [
            {
              code: 'NOT_FOUND',
              message: '계정을 찾을 수 없습니다.',
              path: [],
            },
          ],
    };
  }

  @Mutation('deleteViewerAccount')
  public async deleteViewerAccount(
    @Context('req') request: AuthenticatedRequest,
  ): Promise<Readonly<{ success: boolean; userErrors: ReadonlyArray<never> }>> {
    return {
      success: await this.profiles.deleteAccount(viewerIdFrom(request)),
      userErrors: [],
    };
  }
}
