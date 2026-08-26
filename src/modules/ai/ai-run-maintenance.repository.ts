import { Inject, Injectable } from '@nestjs/common';
import { and, eq, lte, or, sql } from 'drizzle-orm';

import type { Database } from '../../database/database.module.js';
import { DATABASE } from '../../database/database.module.js';
import { aiRuns } from '../../database/schema.js';

const cleanupBatchSize = 500;

@Injectable()
export class AiRunMaintenanceRepository {
  public constructor(@Inject(DATABASE) private readonly database: Database) {}

  public recoverStaleReservedRuns = (now = new Date()): Promise<number> =>
    this.database.transaction(async (transaction) => {
      const lock = await transaction.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended('shopport.ai-maintenance', 0)) as locked`,
      );
      if (!lock.rows.at(0)?.locked) return 0;
      const heartbeatCutoff = new Date(now.getTime() - 120_000);
      const staleRuns = await transaction
        .select({ id: aiRuns.id })
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.status, 'reserved'),
            or(
              lte(aiRuns.deadlineAt, now),
              lte(aiRuns.heartbeatAt, heartbeatCutoff),
            ),
          ),
        )
        .for('update', { skipLocked: true });
      let recovered = 0;
      for (const stale of staleRuns) {
        const runs = await transaction
          .update(aiRuns)
          .set({
            status: 'failed',
            completedAt: now,
            streamClosedAt: now,
          })
          .where(and(eq(aiRuns.id, stale.id), eq(aiRuns.status, 'reserved')))
          .returning({ id: aiRuns.id });
        if (runs.length === 1) recovered += 1;
      }
      return recovered;
    });

  public cleanupRuntimeState = (now = new Date()): Promise<void> =>
    this.database.transaction(async (transaction) => {
      const lock = await transaction.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended('shopport.ai-maintenance', 0)) as locked`,
      );
      if (!lock.rows.at(0)?.locked) return;
      await transaction.execute(sql`
        WITH expired AS (
          SELECT id
          FROM ai_run_events
          WHERE expires_at <= ${now}
          ORDER BY expires_at
          LIMIT ${cleanupBatchSize}
        )
        DELETE FROM ai_run_events
        USING expired
        WHERE ai_run_events.id = expired.id
      `);
      await transaction.execute(sql`
        WITH expired AS (
          SELECT key
          FROM rate_limits
          WHERE window_expires_at <= ${now}
            AND (blocked_until IS NULL OR blocked_until <= ${now})
          ORDER BY window_expires_at
          LIMIT ${cleanupBatchSize}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM rate_limits
        USING expired
        WHERE rate_limits.key = expired.key
      `);
    });
}
