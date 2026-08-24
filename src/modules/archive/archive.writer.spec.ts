import { describe, expect, it, jest } from '@jest/globals';

import type { Database } from '../../database/database.module.js';
import type { ObjectStore } from '../../storage/object-store.js';
import { ArchiveWriter } from './archive.writer.js';

describe('ArchiveWriter claims', () => {
  it('selects archive candidates in a skip-locked transaction', async () => {
    const lockRows = jest
      .fn<
        (
          strength: string,
          config: { skipLocked: boolean },
        ) => Promise<Array<never>>
      >()
      .mockResolvedValue([]);
    const transaction = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          innerJoin: jest.fn(() => ({
            where: jest.fn(() => ({
              orderBy: jest.fn(() => ({
                limit: jest.fn(() => ({ for: lockRows })),
              })),
            })),
          })),
        })),
      })),
    };
    const runTransaction = jest.fn(
      (callback: (value: typeof transaction) => Promise<boolean>) =>
        callback(transaction),
    );
    const database = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          innerJoin: jest.fn(() => ({
            where: jest.fn(() => ({
              orderBy: jest.fn(() => ({
                limit: jest.fn(() => Promise.resolve([])),
              })),
            })),
          })),
        })),
      })),
      transaction: runTransaction,
    } as unknown as Database;
    const writer = new ArchiveWriter(database, {} as ObjectStore);

    await expect(writer.archive()).resolves.toBe(false);

    expect(runTransaction).toHaveBeenCalledTimes(1);
    expect(lockRows).toHaveBeenCalledWith('update', { skipLocked: true });
  });
});
