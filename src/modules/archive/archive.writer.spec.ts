import { describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Database } from '../../database/database.module.js';
import { messages } from '../../database/schema.js';
import type { ObjectStore } from '../../storage/object-store.js';
import { ArchiveWriter } from './archive.writer.js';

describe('ArchiveWriter claims', () => {
  it('does no archive work when another worker owns maintenance', async () => {
    const execute = jest.fn<(statement: unknown) => Promise<unknown>>(() =>
      Promise.resolve({ rows: [{ locked: false }] }),
    );
    const transaction = { execute, select: jest.fn() };
    const database = {
      transaction: (
        callback: (value: typeof transaction) => Promise<boolean>,
      ): Promise<boolean> => callback(transaction),
    } as unknown as Database;
    const objects = {
      put: jest.fn(),
      get: jest.fn(),
    } as unknown as ObjectStore;
    const writer = new ArchiveWriter(database, objects);

    await expect(writer.archive()).resolves.toBe(false);

    const lockQuery = new PgDialect().sqlToQuery(
      execute.mock.calls[0]?.[0] as Parameters<PgDialect['sqlToQuery']>[0],
    ).sql;
    expect(lockQuery).toBe(
      "select pg_try_advisory_xact_lock(hashtextextended('shopport.archive', 0)) as locked",
    );
    expect(transaction.select).not.toHaveBeenCalled();
    expect(objects.put).not.toHaveBeenCalled();
    expect(objects.get).not.toHaveBeenCalled();
  });

  it('selects archive candidates in a skip-locked transaction', async () => {
    const lockRows = jest
      .fn<
        (
          strength: string,
          config: { of: unknown; skipLocked: boolean },
        ) => Promise<Array<never>>
      >()
      .mockResolvedValue([]);
    const limit = jest.fn<(count: number) => { for: typeof lockRows }>(() => ({
      for: lockRows,
    }));
    const transaction = {
      execute: jest.fn<(statement: unknown) => Promise<unknown>>(() =>
        Promise.resolve({ rows: [{ locked: true }] }),
      ),
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          innerJoin: jest.fn(() => ({
            where: jest.fn(() => ({
              orderBy: jest.fn(() => ({
                limit,
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
    expect(lockRows).toHaveBeenCalledWith('update', {
      of: messages,
      skipLocked: true,
    });
    expect(limit).toHaveBeenCalledWith(500);
  });
});
