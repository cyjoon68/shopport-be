import { describe, expect, it, jest } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';

import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AssetsResolver } from './assets.resolver.js';
import type { AssetsService } from './assets.service.js';

const accountId = '0198a122-0c00-7000-8000-000000000001';
const assetId = '0198a122-0c00-7000-8000-000000000002';
const request = {
  user: { sessionId: '0198a122-0c00-7000-8000-000000000003', sub: accountId },
} as AuthenticatedRequest;

describe('AssetsResolver', () => {
  it('returns a not-found user error when upload creation has no conversation', async () => {
    const resolver = new AssetsResolver({
      createUpload: jest.fn(() =>
        Promise.reject(new NotFoundException('Conversation not found')),
      ),
    } as unknown as AssetsService);

    await expect(
      resolver.createAssetUpload(request, {
        conversationId: assetId,
        contentType: 'image/jpeg',
        byteSize: 128,
      }),
    ).resolves.toEqual({
      upload: null,
      userErrors: [expect.objectContaining({ code: 'NOT_FOUND' })],
    });
  });

  it('leaves unexpected upload errors for the shared error formatter', async () => {
    const resolver = new AssetsResolver({
      createUpload: jest.fn(() => Promise.reject(new Error('storage failed'))),
    } as unknown as AssetsService);

    await expect(
      resolver.createAssetUpload(request, {
        conversationId: assetId,
        contentType: 'image/jpeg',
        byteSize: 128,
      }),
    ).rejects.toThrow('storage failed');
  });

  it('returns a not-found user error when no owned asset is deleted', async () => {
    const resolver = new AssetsResolver({
      delete: jest.fn(() => Promise.resolve(false)),
    } as unknown as AssetsService);

    await expect(
      resolver.deleteAsset(request, { id: assetId }),
    ).resolves.toEqual({
      success: false,
      userErrors: [expect.objectContaining({ code: 'NOT_FOUND' })],
    });
  });
});
