import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../../config/environment.js';
import type { ArchiveReader } from '../archive/archive.reader.js';
import type { AssetsRepository } from '../assets/assets.repository.js';
import { type AssetGraphql, AssetsService } from '../assets/assets.service.js';
import type { CatalogService } from '../catalog/catalog.service.js';
import type { ConversationRepository } from './conversation.repository.js';
import { MessageLoader } from './message.loader.js';

describe('MessageLoader resource bounds', () => {
  it('returns only the 50 most recent messages', async () => {
    const conversationId = '0198a122-0c00-7000-8000-000000000001';
    const records = Array.from({ length: 75 }, (_, index) => ({
      id: `0198a122-0c00-7000-8000-${String(index).padStart(12, '0')}`,
      conversationId,
      role: 'user',
      status: 'completed',
      createdAt: new Date(index * 1_000),
    }));
    const messagesFor = jest
      .fn<
        (
          conversationIds: ReadonlyArray<string>,
          first: number,
        ) => Promise<typeof records>
      >()
      .mockResolvedValue(records);
    const repository = {
      messagesFor,
      partsFor: jest.fn(() => Promise.resolve([])),
    } as unknown as ConversationRepository;
    const archives = {
      forConversations: jest.fn(() => Promise.resolve(new Map())),
    } as unknown as ArchiveReader;
    const loader = new MessageLoader(
      repository,
      {} as CatalogService,
      archives,
      {} as AssetsService,
    );

    const messages = await loader.load(conversationId);

    expect(messages).toHaveLength(50);
    expect(messages.at(0)?.id).toBe(records.at(25)?.id);
    expect(messages.at(-1)?.id).toBe(records.at(-1)?.id);
    expect(messagesFor).toHaveBeenCalledWith([conversationId], 50);
  });

  it('resolves de-duplicated current and archived image IDs in one batch', async () => {
    const firstConversationId = '0198a122-0c00-7000-8000-000000000001';
    const secondConversationId = '0198a122-0c00-7000-8000-000000000002';
    const currentMessageId = '0198a122-0c00-7000-8000-000000000003';
    const archivedMessageId = '0198a122-0c00-7000-8000-000000000004';
    const currentAssetId = '0198a122-0c00-7000-8000-000000000005';
    const archivedAssetId = '0198a122-0c00-7000-8000-000000000006';
    const currentAsset: AssetGraphql = {
      id: currentAssetId,
      status: 'READY',
      url: 'https://assets.example.com/current.jpg',
      width: 1200,
      height: 900,
      createdAt: new Date('2026-08-27T00:00:00.000Z'),
    };
    const archivedAsset: AssetGraphql = {
      ...currentAsset,
      id: archivedAssetId,
      url: 'https://assets.example.com/archived.jpg',
    };
    const repository = {
      messagesFor: jest.fn(() =>
        Promise.resolve([
          {
            id: currentMessageId,
            conversationId: firstConversationId,
            role: 'user',
            status: 'completed',
            createdAt: new Date('2026-08-27T00:00:00.000Z'),
          },
        ]),
      ),
      partsFor: jest.fn(() =>
        Promise.resolve([
          {
            id: '0198a122-0c00-7000-8000-000000000007',
            messageId: currentMessageId,
            kind: 'image',
            position: 0,
            payload: { id: currentAssetId },
          },
          {
            id: '0198a122-0c00-7000-8000-000000000008',
            messageId: currentMessageId,
            kind: 'image',
            position: 1,
            payload: { id: currentAssetId },
          },
        ]),
      ),
    } as unknown as ConversationRepository;
    const archives = {
      forConversations: jest.fn(() =>
        Promise.resolve(
          new Map([
            [
              secondConversationId,
              {
                messages: [
                  {
                    id: archivedMessageId,
                    conversationId: secondConversationId,
                    role: 'user',
                    status: 'completed',
                    createdAt: new Date('2026-08-26T00:00:00.000Z'),
                  },
                ],
                parts: [
                  {
                    id: '0198a122-0c00-7000-8000-000000000009',
                    messageId: archivedMessageId,
                    kind: 'image',
                    position: 0,
                    payload: {
                      ...archivedAsset,
                      createdAt: archivedAsset.createdAt.toISOString(),
                    },
                  },
                ],
              },
            ],
          ]),
        ),
      ),
    } as unknown as ArchiveReader;
    const findForConversations = jest
      .fn<
        (
          assetIds: ReadonlyArray<string>,
          conversationIds: ReadonlyArray<string>,
        ) => Promise<ReadonlyArray<AssetGraphql>>
      >()
      .mockResolvedValue([currentAsset, archivedAsset]);
    const loader = new MessageLoader(
      repository,
      {} as CatalogService,
      archives,
      { findForConversations } as unknown as AssetsService,
    );

    const [current, archived] = await Promise.all([
      loader.load(firstConversationId),
      loader.load(secondConversationId),
    ]);

    expect(current[0]?.parts).toHaveLength(2);
    expect(archived[0]?.parts).toEqual([
      expect.objectContaining({
        __typename: 'ImageMessagePart',
        asset: archivedAsset,
      }),
    ]);
    expect(findForConversations).toHaveBeenCalledTimes(1);
    expect(findForConversations).toHaveBeenCalledWith(
      [currentAssetId, archivedAssetId],
      [firstConversationId, secondConversationId],
    );
  });

  it('freshly signs the same image on repeated request-scoped reads', async () => {
    const now = jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-08-27T00:00:00.000Z').getTime());
    try {
      const conversationId = '0198a122-0c00-7000-8000-000000000001';
      const messageId = '0198a122-0c00-7000-8000-000000000002';
      const assetId = '0198a122-0c00-7000-8000-000000000003';
      const message = {
        id: messageId,
        conversationId,
        role: 'user',
        status: 'completed',
        createdAt: new Date('2026-08-26T00:00:00.000Z'),
      };
      const repository = {
        messagesFor: jest.fn(() => Promise.resolve([message])),
        partsFor: jest.fn(() =>
          Promise.resolve([
            {
              id: '0198a122-0c00-7000-8000-000000000004',
              messageId,
              kind: 'image',
              position: 0,
              payload: {
                id: assetId,
                status: 'PROCESSING',
                url: null,
                width: null,
                height: null,
                createdAt: '2026-08-26T00:00:00.000Z',
              },
            },
          ]),
        ),
      } as unknown as ConversationRepository;
      const archives = {
        forConversations: jest.fn(() => Promise.resolve(new Map())),
      } as unknown as ArchiveReader;
      const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
      });
      const assets = new AssetsService(
        {
          findForConversations: () =>
            Promise.resolve([
              {
                id: assetId,
                status: 'ready',
                normalizedKey: `uploads/account/${assetId}/normalized.jpg`,
                width: 1200,
                height: 900,
                createdAt: new Date('2026-08-26T00:00:00.000Z'),
              },
            ]),
        } as unknown as AssetsRepository,
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

      const first = await new MessageLoader(
        repository,
        {} as CatalogService,
        archives,
        assets,
      ).load(conversationId);
      now.mockReturnValue(new Date('2026-08-27T00:01:00.000Z').getTime());
      const second = await new MessageLoader(
        repository,
        {} as CatalogService,
        archives,
        assets,
      ).load(conversationId);

      const firstPart = first[0]?.parts[0];
      const secondPart = second[0]?.parts[0];
      expect(firstPart).toMatchObject({ __typename: 'ImageMessagePart' });
      expect(secondPart).toMatchObject({ __typename: 'ImageMessagePart' });
      if (
        firstPart?.__typename !== 'ImageMessagePart' ||
        secondPart?.__typename !== 'ImageMessagePart'
      ) {
        throw new Error('Expected image parts');
      }
      expect(firstPart.asset.url).not.toBe(secondPart.asset.url);
    } finally {
      now.mockRestore();
    }
  });

  it('omits an image asset outside the loaded conversation', async () => {
    const conversationId = '0198a122-0c00-7000-8000-000000000001';
    const otherConversationId = '0198a122-0c00-7000-8000-000000000005';
    const messageId = '0198a122-0c00-7000-8000-000000000002';
    const assetId = '0198a122-0c00-7000-8000-000000000003';
    const repository = {
      messagesFor: jest.fn(() =>
        Promise.resolve([
          {
            id: messageId,
            conversationId,
            role: 'user',
            status: 'completed',
            createdAt: new Date('2026-08-26T00:00:00.000Z'),
          },
        ]),
      ),
      partsFor: jest.fn(() =>
        Promise.resolve([
          {
            id: '0198a122-0c00-7000-8000-000000000004',
            messageId,
            kind: 'image',
            position: 0,
            payload: { id: assetId },
          },
        ]),
      ),
    } as unknown as ConversationRepository;
    const findForConversations = jest
      .fn<
        (
          assetIds: ReadonlyArray<string>,
          conversationIds: ReadonlyArray<string>,
        ) => Promise<ReadonlyArray<AssetGraphql>>
      >()
      .mockImplementation((_assetIds, conversationIds) =>
        Promise.resolve(
          conversationIds.includes(otherConversationId)
            ? [
                {
                  id: assetId,
                  status: 'READY',
                  url: 'https://assets.example.com/foreign.jpg',
                  width: 1200,
                  height: 900,
                  createdAt: new Date('2026-08-26T00:00:00.000Z'),
                },
              ]
            : [],
        ),
      );
    const assets = { findForConversations } as unknown as AssetsService;
    const loader = new MessageLoader(
      repository,
      {} as CatalogService,
      {
        forConversations: () => Promise.resolve(new Map()),
      } as unknown as ArchiveReader,
      assets,
    );

    const messages = await loader.load(conversationId);

    expect(messages[0]?.parts).toEqual([]);
    expect(findForConversations).toHaveBeenCalledWith(
      [assetId],
      [conversationId],
    );
  });
});
