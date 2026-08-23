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
  entitlementExpiresAt: null,
  entitlementKey: 'trial',
  id: accountId,
  productId: null,
  profileImageUrl: null,
  trialEndsAt: new Date('2026-08-30T00:00:00.000Z'),
  trialStartedAt: new Date('2026-08-23T00:00:00.000Z'),
} satisfies ViewerRecord;

describe('profile resolver', () => {
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
