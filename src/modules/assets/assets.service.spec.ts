import { generateKeyPairSync } from 'node:crypto';

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../../config/environment.js';
import type { AssetsRepository } from './assets.repository.js';
import { AssetsService } from './assets.service.js';

describe('AssetsService upload replay protection', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('freshly signs current assets for every batch read', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-27T00:00:00.000Z'));
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const findForConversations = jest.fn(() =>
      Promise.resolve([
        {
          id: '0198a122-0c00-7000-8000-000000000003',
          status: 'ready',
          normalizedKey:
            'uploads/0198a122-0c00-7000-8000-000000000001/0198a122-0c00-7000-8000-000000000003/normalized.jpg',
          width: 1200,
          height: 900,
          createdAt: new Date('2026-08-26T00:00:00.000Z'),
        },
      ]),
    );
    const service = new AssetsService(
      { findForConversations } as unknown as AssetsRepository,
      new ConfigService<Environment, true>({
        AWS_REGION: 'ap-northeast-2',
        ASSET_BUCKET: 'shopport-assets',
        RAW_ASSET_BUCKET: 'shopport-raw',
        NORMALIZED_ASSET_BUCKET: 'shopport-normalized',
        ARCHIVE_BUCKET: 'shopport-archive',
        ASSET_CDN_HOST: 'assets.example.com',
        CLOUDFRONT_KEY_PAIR_ID: 'test-key-pair',
        CLOUDFRONT_PRIVATE_KEY: privateKey.export({
          type: 'pkcs8',
          format: 'pem',
        }) as string,
      } as Environment),
    );

    const first = await service.findForConversations(
      ['0198a122-0c00-7000-8000-000000000003'],
      ['0198a122-0c00-7000-8000-000000000002'],
    );
    jest.setSystemTime(new Date('2026-08-27T00:01:00.000Z'));
    const second = await service.findForConversations(
      ['0198a122-0c00-7000-8000-000000000003'],
      ['0198a122-0c00-7000-8000-000000000002'],
    );

    expect(first[0]).toMatchObject({
      id: '0198a122-0c00-7000-8000-000000000003',
      status: 'READY',
      width: 1200,
      height: 900,
    });
    expect(first[0]?.url).not.toBe(second[0]?.url);
  });

  it('signs a create-only upload and returns the required header', async () => {
    const createForLiveConversation = jest.fn(
      (input: Readonly<{ id: string }>) =>
        Promise.resolve({
          id: input.id,
          status: 'pending_upload',
          normalizedKey: null,
          width: null,
          height: null,
          createdAt: new Date('2026-08-24T00:00:00.000Z'),
        }),
    );
    const repository = {
      createForLiveConversation,
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
    expect(upload.uploadUrl).toContain('X-Amz-Expires=600');
    expect(createForLiveConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        originalKey: expect.stringMatching(
          /^uploads\/0198a122-0c00-7000-8000-000000000001\/.+\/original$/u,
        ),
      }),
    );
  });

  it('rejects upload creation for a deleted conversation', async () => {
    const createForLiveConversation = jest.fn(() => Promise.resolve(null));
    const repository = {
      createForLiveConversation,
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

    await expect(
      service.createUpload({
        accountId: '0198a122-0c00-7000-8000-000000000001',
        conversationId: '0198a122-0c00-7000-8000-000000000002',
        contentType: 'image/jpeg',
        byteSize: 128,
      }),
    ).rejects.toThrow('Conversation not found');

    expect(createForLiveConversation).toHaveBeenCalledTimes(1);
  });
});
