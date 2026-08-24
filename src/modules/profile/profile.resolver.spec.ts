import { jest } from '@jest/globals';

import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import type { ProfileRepository, ViewerRecord } from './profile.repository.js';
import { ProfileResolver } from './profile.resolver.js';

const accountId = '0198a122-0c00-7000-8000-000000000001';
const request = {
  user: {
    sessionId: '0198a122-0c00-7000-8000-000000000002',
    sub: accountId,
  },
} as AuthenticatedRequest;

const viewer = {
  displayName: '새 닉네임',
  id: accountId,
  profileImageUrl: null,
} satisfies ViewerRecord;

describe('profile resolver', () => {
  it('keeps legacy clients on unlimited AI access', async () => {
    const findViewer = jest.fn<
      (accountId: string) => Promise<ViewerRecord | null>
    >(() => Promise.resolve(viewer));
    const resolver = new ProfileResolver({
      viewer: findViewer,
    } as unknown as ProfileRepository);

    const result = await resolver.viewer(request);

    expect(result.entitlement).toEqual({
      key: 'pro',
      isActive: true,
      productId: null,
      expiresAt: null,
    });
    expect(result.trialStartedAt.toISOString()).toBe(
      '1970-01-01T00:00:00.000Z',
    );
    expect(result.trialEndsAt.toISOString()).toBe('9999-12-31T23:59:59.999Z');
    expect(findViewer).toHaveBeenCalledWith(accountId);
  });

  it('trims and updates the viewer nickname', async () => {
    const updateDisplayName = jest.fn<
      (accountId: string, displayName: string) => Promise<ViewerRecord | null>
    >(() => Promise.resolve(viewer));
    const resolver = new ProfileResolver({
      updateDisplayName,
    } as unknown as ProfileRepository);

    const result = await resolver.updateViewer(request, {
      displayName: '  새 닉네임  ',
    });

    expect(result.viewer?.displayName).toBe('새 닉네임');
    expect(result.viewer?.id).toBe(accountId);
    expect(result.userErrors).toEqual([]);
    expect(updateDisplayName).toHaveBeenCalledWith(accountId, '새 닉네임');
  });

  it('rejects an empty nickname without updating the account', async () => {
    const updateDisplayName = jest.fn();
    const resolver = new ProfileResolver({
      updateDisplayName,
    } as unknown as ProfileRepository);

    await expect(
      resolver.updateViewer(request, { displayName: '   ' }),
    ).resolves.toEqual({
      viewer: null,
      userErrors: [expect.objectContaining({ code: 'VALIDATION_FAILED' })],
    });
    expect(updateDisplayName).not.toHaveBeenCalled();
  });
});
