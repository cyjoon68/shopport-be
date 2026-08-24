import { describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../../config/environment.js';
import type { AssetsRepository } from './assets.repository.js';
import { AssetsService } from './assets.service.js';

describe('AssetsService upload replay protection', () => {
  it('signs a create-only upload and returns the required header', async () => {
    const repository = {
      ownsConversation: jest.fn(() => Promise.resolve(true)),
      create: jest.fn((input: Readonly<{ id: string }>) =>
        Promise.resolve({
          id: input.id,
          status: 'pending_upload',
          normalizedKey: null,
          width: null,
          height: null,
          createdAt: new Date('2026-08-24T00:00:00.000Z'),
        }),
      ),
    } as unknown as AssetsRepository;
    const config = new ConfigService<Environment, true>({
      AWS_REGION: 'ap-northeast-2',
      AWS_ENDPOINT_URL: 'http://localhost:4566',
      ASSET_BUCKET: 'shopport-assets',
      RAW_ASSET_BUCKET: 'shopport-raw',
      NORMALIZED_ASSET_BUCKET: 'shopport-normalized',
      ARCHIVE_BUCKET: 'shopport-archive',
      ASSET_CDN_HOST: 'assets.example.com',
    } as Environment);
    const service = new AssetsService(repository, config);

    const upload = await service.createUpload({
      accountId: '0198a122-0c00-7000-8000-000000000001',
      conversationId: '0198a122-0c00-7000-8000-000000000002',
      contentType: 'image/jpeg',
      byteSize: 128,
    });

    expect(upload.headers).toContainEqual({
      name: 'if-none-match',
      value: '*',
    });
    expect(upload.uploadUrl).toContain('if-none-match');
  });
});
