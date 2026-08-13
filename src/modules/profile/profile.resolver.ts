import { Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { NotFoundException } from '@nestjs/common';
import { viewerIdFrom, type AuthenticatedRequest } from '../auth/auth.guard.js';
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

@Resolver('Viewer')
export class ProfileResolver {
  public constructor(private readonly profiles: ProfileRepository) {}

  @Query('viewer')
  public async viewer(
    @Context('req') request: AuthenticatedRequest,
  ): Promise<ViewerGraphql> {
    const viewer = await this.profiles.viewer(viewerIdFrom(request));
    if (!viewer) throw new NotFoundException('Viewer not found');
    const now = new Date();
    const isPro =
      viewer.entitlementKey === 'pro' &&
      (viewer.entitlementExpiresAt === null ||
        viewer.entitlementExpiresAt > now);
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
