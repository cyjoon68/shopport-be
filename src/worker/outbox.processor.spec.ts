import { describe, expect, it, jest } from '@jest/globals';

import type { Database } from '../database/database.module.js';
import type { RedisClient } from '../redis/redis.module.js';
import type { ObjectStore } from '../storage/object-store.js';
import { OutboxProcessor } from './outbox.processor.js';

describe('OutboxProcessor failure isolation', () => {
  it('records one failed event and continues with the next event', async () => {
    const events = [
      {
        attemptCount: 0,
        id: '0198a122-0c00-7000-8000-000000000001',
        payload: {
          accountId: '0198a122-0c00-7000-8000-000000000010',
          normalizedKey: null,
          originalKey: 'fail',
        },
        topic: 'asset.purge',
      },
      {
        attemptCount: 0,
        id: '0198a122-0c00-7000-8000-000000000002',
        payload: {
          accountId: '0198a122-0c00-7000-8000-000000000011',
          normalizedKey: null,
          originalKey: 'succeed',
        },
        topic: 'asset.purge',
      },
    ];
    const updates: Array<Record<string, unknown>> = [];
    const database = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            orderBy: jest.fn(() => ({
              limit: jest.fn(() => Promise.resolve(events)),
            })),
          })),
        })),
      })),
      update: jest.fn(() => ({
        set: jest.fn((value: Record<string, unknown>) => {
          updates.push(value);
          return { where: jest.fn(() => Promise.resolve()) };
        }),
      })),
    } as unknown as Database;
    const deleteKey = jest.fn((_bucket: string, key: string) =>
      key === 'fail'
        ? Promise.reject(new Error('S3 unavailable'))
        : Promise.resolve(),
    );
    const processor = new OutboxProcessor(
      database,
      {} as RedisClient,
      { deleteKey } as unknown as ObjectStore,
    );

    await expect(processor.process()).resolves.toBe(true);

    expect(deleteKey).toHaveBeenCalledTimes(2);
    expect(updates).toEqual([
      expect.objectContaining({ attemptCount: 1 }),
      expect.objectContaining({ publishedAt: expect.any(Date) }),
    ]);
  });
});
