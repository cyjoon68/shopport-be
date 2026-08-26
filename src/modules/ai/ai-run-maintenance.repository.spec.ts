import { describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Database } from '../../database/database.module.js';
import { AiRunMaintenanceRepository } from './ai-run-maintenance.repository.js';

describe('AiRunMaintenanceRepository', () => {
  it('does no recovery when another worker owns maintenance', async () => {
    const execute = jest.fn<(statement: unknown) => Promise<unknown>>(() =>
      Promise.resolve({ rows: [{ locked: false }] }),
    );
    const transaction = { execute, select: jest.fn(), update: jest.fn() };
    const database = {
      transaction: (
        callback: (value: typeof transaction) => Promise<number>,
      ): Promise<number> => callback(transaction),
    } as unknown as Database;
    const repository = new AiRunMaintenanceRepository(database);

    await expect(repository.recoverStaleReservedRuns()).resolves.toBe(0);

    expect(transaction.select).not.toHaveBeenCalled();
    expect(transaction.update).not.toHaveBeenCalled();
  });

  it('locks stale selection and leaves genuinely fresh leases untouched', async () => {
    const returning = jest
      .fn<() => Promise<Array<{ id: string }>>>()
      .mockResolvedValue([{ id: 'stale-run' }]);
    const update = jest.fn(() => ({
      set: jest.fn(() => ({ where: jest.fn(() => ({ returning })) })),
    }));
    const forUpdate = jest
      .fn<
        (
          strength: string,
          config: { skipLocked: boolean },
        ) => Promise<Array<{ id: string }>>
      >()
      .mockResolvedValue([{ id: 'stale-run' }]);
    const transaction = {
      execute: jest.fn<(statement: unknown) => Promise<unknown>>(() =>
        Promise.resolve({ rows: [{ locked: true }] }),
      ),
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn(() => ({ for: forUpdate })) })),
      })),
      update,
    };
    const database = {
      transaction: (
        callback: (value: typeof transaction) => Promise<number>,
      ): Promise<number> => callback(transaction),
    } as unknown as Database;
    const repository = new AiRunMaintenanceRepository(database);

    await expect(
      repository.recoverStaleReservedRuns(new Date('2026-08-27T00:00:00.000Z')),
    ).resolves.toBe(1);

    expect(forUpdate).toHaveBeenCalledWith('update', { skipLocked: true });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('deletes expired events and unblocked rate limits in bounded batches', async () => {
    const execute = jest.fn<(statement: unknown) => Promise<unknown>>(() =>
      Promise.resolve({ rows: [{ locked: true }] }),
    );
    const transaction = { execute };
    const database = {
      transaction: (
        callback: (value: typeof transaction) => Promise<void>,
      ): Promise<void> => callback(transaction),
    } as unknown as Database;
    const repository = new AiRunMaintenanceRepository(database);

    await repository.cleanupRuntimeState(new Date('2026-08-27T00:00:00.000Z'));

    const queries = execute.mock.calls.map(
      ([statement]) =>
        new PgDialect().sqlToQuery(
          statement as Parameters<PgDialect['sqlToQuery']>[0],
        ).sql,
    );
    expect(queries[1]).toContain('FROM ai_run_events');
    expect(queries[1]).toContain('LIMIT $2');
    expect(queries[2]).toContain('FROM rate_limits');
    expect(queries[2]).toContain('blocked_until IS NULL');
    expect(queries[2]).toContain('LIMIT $3');
  });
});
