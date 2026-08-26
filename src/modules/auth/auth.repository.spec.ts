import { describe, expect, it, jest } from '@jest/globals';
import { ConflictException } from '@nestjs/common';

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

describe('AuthRepository session revocation', () => {
  const createRepository = (
    revokedAt: Date | null,
    found = true,
  ): Readonly<{
    repository: AuthRepository;
    transaction: Readonly<{ execute: () => Promise<void> }>;
  }> => {
    const locked = jest.fn(() =>
      Promise.resolve(
        found
          ? [
              {
                id: '0198a122-0c00-7000-8000-000000000002',
                replacedBySessionId: revokedAt
                  ? '0198a122-0c00-7000-8000-000000000003'
                  : null,
                revokedAt,
              },
            ]
          : [],
      ),
    );
    const transaction = {
      execute: jest.fn(() => Promise.resolve()),
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            limit: jest.fn(() => ({ for: locked })),
          })),
        })),
      })),
    };
    const database = {
      transaction: (
        callback: (value: typeof transaction) => Promise<unknown>,
      ): Promise<unknown> => callback(transaction),
      update: jest.fn(() => ({
        set: jest.fn(() => ({ where: jest.fn(() => Promise.resolve()) })),
      })),
    } as unknown as Database;
    return { repository: new AuthRepository(database), transaction };
  };

  it('revokes a replaced parent and its replacement descendants atomically', async () => {
    const { repository, transaction } = createRepository(
      new Date('2026-08-27T00:00:00.000Z'),
    );

    await expect(
      repository.revokeSession(
        '0198a122-0c00-7000-8000-000000000002',
        'stored-hash',
      ),
    ).resolves.toBe(true);

    expect(transaction.execute).toHaveBeenCalledTimes(1);
  });

  it('revokes an active parent and any replacement descendants atomically', async () => {
    const { repository, transaction } = createRepository(null);

    await expect(
      repository.revokeSession(
        '0198a122-0c00-7000-8000-000000000002',
        'stored-hash',
      ),
    ).resolves.toBe(true);

    expect(transaction.execute).toHaveBeenCalledTimes(1);
  });

  it('returns false without revocation when the exact session hash is absent', async () => {
    const { repository, transaction } = createRepository(null, false);

    await expect(
      repository.revokeSession(
        '0198a122-0c00-7000-8000-000000000002',
        'wrong-hash',
      ),
    ).resolves.toBe(false);

    expect(transaction.execute).not.toHaveBeenCalled();
  });
});

describe('AuthRepository account creation', () => {
  it('rejects a deletion-pending identity without inserts', async () => {
    const locked = jest
      .fn<
        () => Promise<
          Array<{
            accountId: string;
            deletedAt: Date;
            displayName: string;
            profileImageUrl: string | null;
          }>
        >
      >()
      .mockResolvedValue([
        {
          accountId: '0198a122-0c00-7000-8000-000000000001',
          deletedAt: new Date('2026-08-26T00:00:00.000Z'),
          displayName: '탈퇴 대기 사용자',
          profileImageUrl: null,
        },
      ]);
    const transaction = {
      execute: jest.fn(() => Promise.resolve()),
      insert: jest.fn(),
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          innerJoin: jest.fn(() => ({
            where: jest.fn(() => ({ limit: locked })),
          })),
        })),
      })),
    };
    const database = {
      transaction: (
        callback: (value: typeof transaction) => Promise<unknown>,
      ): Promise<unknown> => callback(transaction),
    } as unknown as Database;
    const repository = new AuthRepository(database);

    await expect(
      repository.findOrCreateAccount({
        displayName: '통합 테스트 사용자',
        profileImageUrl: null,
        provider: 'kakao',
        subject: 'deletion-pending-subject',
      }),
    ).rejects.toEqual(new ConflictException('Account deletion is pending'));

    expect(transaction.insert).not.toHaveBeenCalled();
  });
});
