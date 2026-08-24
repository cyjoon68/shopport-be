import { describe, expect, it, jest } from '@jest/globals';

import type { ArchiveReader } from '../archive/archive.reader.js';
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
    );

    const messages = await loader.load(conversationId);

    expect(messages).toHaveLength(50);
    expect(messages.at(0)?.id).toBe(records.at(25)?.id);
    expect(messages.at(-1)?.id).toBe(records.at(-1)?.id);
    expect(messagesFor).toHaveBeenCalledWith([conversationId], 50);
  });
});
