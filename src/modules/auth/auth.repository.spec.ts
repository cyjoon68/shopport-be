import { describe, expect, it, jest } from '@jest/globals';

import type { Database } from '../../database/database.module.js';
import { AuthRepository } from './auth.repository.js';

describe('AuthRepository refresh replay handling', () => {
  it('revokes only descendants of the replayed session', async () => {
    const locked = jest
      .fn<
        () => Promise<
          Array<{
            accountId: string;
            expiresAt: Date;
            id: string;
            revokedAt: Date;
            tokenHash: string;
          }>
        >
      >()
      .mockResolvedValue([
        {
          accountId: '0198a122-0c00-7000-8000-000000000001',
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          id: '0198a122-0c00-7000-8000-000000000002',
          revokedAt: new Date('2026-08-24T00:00:00.000Z'),
          tokenHash: 'stored-hash',
        },
      ]);
    const transaction = {
      execute: jest.fn(() => Promise.resolve()),
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          innerJoin: jest.fn(() => ({
            where: jest.fn(() => ({
              limit: jest.fn(() => ({ for: locked })),
            })),
          })),
        })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({ where: jest.fn(() => Promise.resolve()) })),
      })),
    };
    const database = {
      transaction: (
        callback: (value: typeof transaction) => Promise<unknown>,
      ): Promise<unknown> => callback(transaction),
    } as unknown as Database;
    const repository = new AuthRepository(database);

    await expect(
      repository.rotateSession({
        expectedHash: 'expected-hash',
        matches: () => true,
        nextExpiresAt: new Date('2099-02-01T00:00:00.000Z'),
        nextTokenHash: 'next-hash',
        previousId: '0198a122-0c00-7000-8000-000000000002',
      }),
    ).resolves.toEqual({ status: 'replay' });

    expect(transaction.update).not.toHaveBeenCalled();
    expect(transaction.execute).toHaveBeenCalledTimes(1);
  });
});
