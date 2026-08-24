import { describe, expect, it, jest } from '@jest/globals';

import type { Database } from '../../database/database.module.js';
import type { ObjectStore } from '../../storage/object-store.js';
import { ArchiveReader } from './archive.reader.js';
import { encodeArchive } from './archive-format.js';

describe('ArchiveReader resource bounds', () => {
  it('does not download every archive object concurrently', async () => {
    const conversationId = '0198a122-0c00-7000-8000-000000000001';
    const archives = Array.from({ length: 3 }, (_, index) => {
      const encoded = encodeArchive([
        {
          message: {
            conversationId,
            createdAt: `2026-01-0${String(index + 1)}T00:00:00.000Z`,
            id: `0198a122-0c00-7000-8000-00000000001${String(index)}`,
            role: 'user',
            status: 'completed',
          },
          parts: [],
        },
      ]);
      return {
        body: encoded.body,
        checksum: encoded.checksum,
        conversationId,
        objectKey: `archive-${String(index)}`,
      };
    });
    const database = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            orderBy: jest.fn(() =>
              Promise.resolve(
                archives.map(({ checksum, conversationId, objectKey }) => ({
                  checksum,
                  conversationId,
                  objectKey,
                })),
              ),
            ),
          })),
        })),
      })),
    } as unknown as Database;
    let active = 0;
    let maximumActive = 0;
    const get = jest.fn(async (...parameters: [string, string]) => {
      const key = parameters[1];
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      const archive = archives.find(({ objectKey }) => objectKey === key);
      if (!archive) throw new Error('Missing archive fixture');
      return archive.body;
    });
    const reader = new ArchiveReader(database, {
      get,
    } as unknown as ObjectStore);

    await expect(reader.forConversations([conversationId])).resolves.toEqual(
      expect.any(Map),
    );

    expect(maximumActive).toBe(1);
  });
});
