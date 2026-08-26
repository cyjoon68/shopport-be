import { describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { Database } from '../database/database.module.js';
import { RetentionCleanup } from './retention-cleanup.js';

describe('RetentionCleanup', () => {
  it('lets one concurrent caller delete bounded sessions and published outbox rows', async () => {
    const loserExecute = jest.fn<(statement: unknown) => Promise<unknown>>(() =>
      Promise.resolve({ rows: [{ locked: false }] }),
    );
    const winnerExecute = jest.fn<(statement: unknown) => Promise<unknown>>(
      () => Promise.resolve({ rows: [{ locked: true }] }),
    );
    const transactions = [
      { execute: loserExecute },
      { execute: winnerExecute },
    ];
    const transaction = jest.fn(
      (callback: (value: (typeof transactions)[number]) => Promise<void>) => {
        const client = transactions.shift();
        if (!client) throw new Error('Unexpected transaction');
        return callback(client);
      },
    );
    const execute = jest.fn<(statement: unknown) => Promise<unknown>>(() =>
      Promise.resolve({ rows: [] }),
    );
    const cleanup = new RetentionCleanup({
      execute,
      transaction,
    } as unknown as Database);

    await Promise.all([
      cleanup.cleanup(new Date('2026-08-27T00:00:00.000Z')),
      cleanup.cleanup(new Date('2026-08-27T00:00:00.000Z')),
    ]);

    const queries = winnerExecute.mock.calls.map(([statement]) =>
      new PgDialect().sqlToQuery(
        statement as Parameters<PgDialect['sqlToQuery']>[0],
      ),
    );
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    expect(loserExecute).toHaveBeenCalledTimes(1);
    expect(winnerExecute).toHaveBeenCalledTimes(3);
    expect(queries[0]?.sql).toBe(
      "select pg_try_advisory_xact_lock(hashtextextended('shopport.retention', 0)) as locked",
    );
    expect(queries[1]?.sql).toContain('FROM auth_sessions');
    expect(queries[1]?.sql).toContain('active_lineage');
    expect(queries[1]?.sql).toContain('LIMIT $3');
    expect(queries[1]?.params.at(-1)).toBe(500);
    expect(queries[2]?.sql).toContain('FROM outbox');
    expect(queries[2]?.sql).toContain('published_at < $1');
    expect(queries[2]?.sql).toContain('LIMIT $2');
    expect(queries[2]?.params.at(-1)).toBe(500);
    expect(queries.map(({ sql }) => sql).join('\n')).not.toContain('failed_at');
  });
});
