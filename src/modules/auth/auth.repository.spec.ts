import { describe, expect, it, jest } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

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
  const sessionId = '0198a122-0c00-7000-8000-000000000002';
  const recursiveLineageSql =
    'with recursive lineage as ( select "auth_sessions"."id" as id, "auth_sessions"."replaced_by_session_id" as next_id from "auth_sessions" where "auth_sessions"."id" = $1 union all select child.id, child.replaced_by_session_id from "auth_sessions" child inner join lineage parent on child.id = parent.next_id ) update "auth_sessions" set revoked_at = coalesce("auth_sessions"."revoked_at", now()), updated_at = now() where "auth_sessions"."id" in (select id from lineage)';

  const createRepository = (
    found = true,
  ): Readonly<{
    executedInTransaction: boolean[];
    repository: AuthRepository;
    statements: SQL[];
  }> => {
    const executedInTransaction: boolean[] = [];
    const statements: SQL[] = [];
    let transactionOpen = false;
    const locked = jest
      .fn<() => Promise<Array<{ id: string }>>>()
      .mockResolvedValue(found ? [{ id: sessionId }] : []);
    const transaction = {
      execute: (statement: SQL): Promise<void> => {
        statements.push(statement);
        executedInTransaction.push(transactionOpen);
        return Promise.resolve();
      },
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            limit: jest.fn(() => ({ for: locked })),
          })),
        })),
      })),
    };
    const database = {
      transaction: async (
        callback: (value: typeof transaction) => Promise<unknown>,
      ): Promise<unknown> => {
        transactionOpen = true;
        try {
          return await callback(transaction);
        } finally {
          transactionOpen = false;
        }
      },
    } as unknown as Database;
    return {
      executedInTransaction,
      repository: new AuthRepository(database),
      statements,
    };
  };

  it.each(['already-replaced', 'active'])(
    'executes recursive lineage SQL inside the transaction for an %s parent',
    async () => {
      const { executedInTransaction, repository, statements } =
        createRepository();

      await expect(
        repository.revokeSession(sessionId, 'stored-hash'),
      ).resolves.toBe(true);

      const statement = statements.at(0);
      if (!statement) throw new Error('Expected recursive lineage statement');
      const query = new PgDialect().sqlToQuery(statement);

      expect(executedInTransaction).toEqual([true]);
      expect(statements).toHaveLength(1);
      expect(query.sql.replace(/\s+/gu, ' ').trim()).toBe(recursiveLineageSql);
      expect(query.params).toEqual([sessionId]);
    },
  );

  it('returns false without revocation when the exact session hash is absent', async () => {
    const { repository, statements } = createRepository(false);

    await expect(
      repository.revokeSession(sessionId, 'wrong-hash'),
    ).resolves.toBe(false);

    expect(statements).toEqual([]);
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
