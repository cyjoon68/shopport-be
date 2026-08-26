import { describe, expect, it, jest } from '@jest/globals';

import type { Database } from '../database/database.module.js';
import type { ObjectStore } from '../storage/object-store.js';
import { OutboxProcessor } from './outbox.processor.js';

type MutableEvent = {
  attemptCount: number;
  failedAt: Date | null;
  id: string;
  lastError: string | null;
  lockedBy: string | null;
  lockedUntil: unknown;
  nextAttemptAt: Date;
  payload: unknown;
  publishedAt: Date | null;
  topic: string;
};

const eventFor = (
  id: string,
  originalKey: string,
  attemptCount = 0,
  normalizedKey: string | null = null,
): MutableEvent => ({
  attemptCount,
  failedAt: null,
  id,
  lastError: null,
  lockedBy: null,
  lockedUntil: null,
  nextAttemptAt: new Date(),
  payload: {
    accountId: '0198a122-0c00-7000-8000-000000000010',
    normalizedKey,
    originalKey,
  },
  publishedAt: null,
  topic: 'asset.purge',
});

const databaseFor = (events: MutableEvent[]): Database => {
  let claimedBy: string | null = null;
  let eventUpdateIndex = 0;
  const select = jest.fn(() => ({
    from: jest.fn(() => ({
      where: jest.fn(() => ({
        orderBy: jest.fn(() => ({
          limit: jest.fn(() => ({
            for: jest.fn(() => {
              eventUpdateIndex = 0;
              return Promise.resolve(
                events.filter(({ publishedAt }) => publishedAt === null),
              );
            }),
          })),
        })),
      })),
    })),
  }));
  const update = jest.fn(() => ({
    set: jest.fn((value: Partial<MutableEvent>) => {
      if (
        typeof value.lockedBy === 'string' &&
        value.attemptCount === undefined &&
        value.publishedAt === undefined
      ) {
        return {
          where: jest.fn(() => {
            claimedBy = value.lockedBy ?? null;
            for (const event of events) {
              if (event.publishedAt === null) Object.assign(event, value);
            }
            return Promise.resolve();
          }),
        };
      }
      const event = events.at(eventUpdateIndex);
      eventUpdateIndex += 1;
      const ownsLease = (): boolean =>
        event?.lockedBy === claimedBy && event.publishedAt === null;
      if (value.attemptCount !== undefined) {
        return {
          where: jest.fn(() => ({
            returning: jest.fn(() => {
              if (!event || !ownsLease()) return Promise.resolve([]);
              Object.assign(event, value);
              return Promise.resolve([{ attemptCount: event.attemptCount }]);
            }),
          })),
        };
      }
      return {
        where: jest.fn(() => {
          if (event && ownsLease()) Object.assign(event, value);
          return Promise.resolve();
        }),
      };
    }),
  }));
  const remove = jest.fn(() => ({
    where: jest.fn(() => Promise.resolve()),
  }));
  const database = { delete: remove, select, update } as unknown as Database;
  const transaction = jest.fn(
    <T>(callback: (value: Database) => Promise<T>): Promise<T> =>
      callback(database),
  );
  Object.assign(database, { transaction });
  return database;
};

describe('OutboxProcessor failure isolation', () => {
  it('keeps a partially deleted account purge unpublished and retryable', async () => {
    const fixedNow = Date.parse('2026-08-27T00:00:00.000Z');
    const now = jest.spyOn(Date, 'now').mockReturnValue(fixedNow);
    const event = eventFor('0198a122-0c00-7000-8000-000000000008', 'unused');
    event.topic = 'account.purge';
    event.payload = {
      accountId: '0198a122-0c00-7000-8000-000000000010',
    };
    const deletePrefix = jest
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(
        new Error('S3 multi-delete failed: count=1 codes=AccessDenied'),
      )
      .mockResolvedValue(undefined);
    const processor = new OutboxProcessor(databaseFor([event]), {
      deletePrefix,
    } as unknown as ObjectStore);

    try {
      await expect(processor.process()).resolves.toBe(true);

      expect(event.publishedAt).toBeNull();
      expect(event.attemptCount).toBe(1);
      expect(event.lastError).toBe(
        'S3 multi-delete failed: count=1 codes=AccessDenied',
      );
      expect(event.nextAttemptAt).toEqual(new Date(fixedNow + 2_000));

      await expect(processor.process()).resolves.toBe(true);

      expect(event.publishedAt).toBeInstanceOf(Date);
      expect(event.attemptCount).toBe(1);
    } finally {
      now.mockRestore();
    }
  });

  it('retries an asset purge until success and reports only the persisted attempt ten', async () => {
    const fixedNow = Date.parse('2026-08-27T00:00:00.000Z');
    const now = jest.spyOn(Date, 'now').mockReturnValue(fixedNow);
    const event = eventFor(
      '0198a122-0c00-7000-8000-000000000001',
      'uploads/account/asset/original',
      0,
      'uploads/account/asset/normalized.jpg',
    );
    let deleteAttempts = 0;
    const deleteKey = jest.fn((bucket: string, key: string) => {
      deleteAttempts += 1;
      return bucket === 'raw' &&
        key === 'uploads/account/asset/original' &&
        deleteAttempts <= 11
        ? Promise.reject(new Error('object store unavailable'))
        : Promise.resolve();
    });
    const write = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const processor = new OutboxProcessor(databaseFor([event]), {
      deleteKey,
    } as unknown as ObjectStore);

    try {
      for (let attempt = 1; attempt <= 11; attempt += 1) {
        await expect(processor.process()).resolves.toBe(true);
        expect(event.publishedAt).toBeNull();
        expect(event.failedAt).toBeNull();
        expect(event.attemptCount).toBe(attempt);
        expect(event.lastError).toBe('object store unavailable');
        expect(event.lockedBy).toBeNull();
        expect(event.lockedUntil).toBeNull();
        expect(event.nextAttemptAt).toEqual(
          new Date(fixedNow + Math.min(2 ** attempt, 3_600) * 1_000),
        );
        expect(write).toHaveBeenCalledTimes(attempt >= 10 ? 1 : 0);
      }

      expect(JSON.parse(String(write.mock.calls.at(0)?.at(0)))).toEqual(
        expect.objectContaining({
          task: 'outbox:asset.purge',
          message: 'object store unavailable',
        }),
      );

      await expect(processor.process()).resolves.toBe(true);

      expect(deleteKey).toHaveBeenNthCalledWith(
        12,
        'raw',
        'uploads/account/asset/original',
      );
      expect(deleteKey).toHaveBeenNthCalledWith(
        13,
        'normalized',
        'uploads/account/asset/normalized.jpg',
      );
      expect(event.publishedAt).toBeInstanceOf(Date);
      expect(event.failedAt).toBeNull();
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
      write.mockRestore();
    }
  });

  it('does not report or persist a stale failure after losing its lease', async () => {
    const event = eventFor(
      '0198a122-0c00-7000-8000-000000000002',
      'lost-lease',
      9,
    );
    const database = databaseFor([event]);
    const deleteKey = jest.fn(() => {
      event.lockedBy = 'replacement-worker';
      return Promise.reject(new Error('object store unavailable'));
    });
    const write = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const processor = new OutboxProcessor(database, {
      deleteKey,
    } as unknown as ObjectStore);

    try {
      await expect(processor.process()).resolves.toBe(true);

      expect(event.attemptCount).toBe(9);
      expect(event.lastError).toBeNull();
      expect(event.lockedBy).toBe('replacement-worker');
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it('continues the claimed batch when reporting attempt ten throws', async () => {
    const failed = eventFor('0198a122-0c00-7000-8000-000000000003', 'fail', 9);
    const succeeded = eventFor(
      '0198a122-0c00-7000-8000-000000000004',
      'succeed',
    );
    const deleteKey = jest.fn((_bucket: string, key: string) =>
      key === 'fail'
        ? Promise.reject(new Error('object store unavailable'))
        : Promise.resolve(),
    );
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('stderr unavailable');
    });
    const processor = new OutboxProcessor(databaseFor([failed, succeeded]), {
      deleteKey,
    } as unknown as ObjectStore);

    try {
      await expect(processor.process()).resolves.toBe(true);

      expect(failed.attemptCount).toBe(10);
      expect(failed.lockedBy).toBeNull();
      expect(succeeded.publishedAt).toBeInstanceOf(Date);
      expect(succeeded.lockedBy).toBeNull();
      expect(deleteKey).toHaveBeenCalledTimes(2);
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
    }
  });

  it('sanitizes and bounds error text with a non-error fallback', async () => {
    const long = eventFor('0198a122-0c00-7000-8000-000000000005', 'long');
    const unknown = eventFor('0198a122-0c00-7000-8000-000000000006', 'unknown');
    const message = `invalid\0${'x'.repeat(600)}`;
    const deleteKey =
      jest.fn<(_bucket: string, _key: string) => Promise<void>>();
    deleteKey.mockRejectedValueOnce(new Error(message));
    deleteKey.mockRejectedValueOnce(undefined);
    const processor = new OutboxProcessor(databaseFor([long, unknown]), {
      deleteKey,
    } as unknown as ObjectStore);

    await expect(processor.process()).resolves.toBe(true);

    expect(long.lastError).toBe(`invalid${'x'.repeat(600)}`.slice(0, 500));
    expect(long.lastError).toHaveLength(500);
    expect(long.lastError).not.toContain('\0');
    expect(unknown.lastError).toBe('Worker failure');
  });

  it('caps an overflowed exponential retry at one hour', async () => {
    const fixedNow = Date.parse('2026-08-27T00:00:00.000Z');
    const now = jest.spyOn(Date, 'now').mockReturnValue(fixedNow);
    const event = eventFor(
      '0198a122-0c00-7000-8000-000000000007',
      'overflow',
      1_023,
    );
    const processor = new OutboxProcessor(databaseFor([event]), {
      deleteKey: jest.fn(() => Promise.reject(new Error('unavailable'))),
    } as unknown as ObjectStore);

    try {
      await expect(processor.process()).resolves.toBe(true);

      expect(event.attemptCount).toBe(1_024);
      expect(event.nextAttemptAt).toEqual(new Date(fixedNow + 3_600_000));
      expect(event.lockedBy).toBeNull();
      expect(event.lockedUntil).toBeNull();
    } finally {
      now.mockRestore();
    }
  });
});
