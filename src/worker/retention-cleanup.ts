import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { Database } from '../database/database.module.js';
import { DATABASE } from '../database/database.module.js';

const dayMilliseconds = 86_400_000;
const sessionRetentionMilliseconds = 35 * dayMilliseconds;
const publishedOutboxRetentionMilliseconds = 7 * dayMilliseconds;
const failedOutboxRetentionMilliseconds = 30 * dayMilliseconds;
const cleanupBatchSize = 500;

@Injectable()
export class RetentionCleanup {
  public constructor(@Inject(DATABASE) private readonly database: Database) {}

  public cleanup = async (now = new Date()): Promise<void> => {
    const sessionCutoff = new Date(
      now.getTime() - sessionRetentionMilliseconds,
    );
    const publishedOutboxCutoff = new Date(
      now.getTime() - publishedOutboxRetentionMilliseconds,
    );
    const failedOutboxCutoff = new Date(
      now.getTime() - failedOutboxRetentionMilliseconds,
    );
    await this.database.execute(sql`
      WITH RECURSIVE active_lineage AS (
        SELECT id, replaced_by_session_id
        FROM auth_sessions
        WHERE expires_at >= ${sessionCutoff}
        UNION
        SELECT parent.id, parent.replaced_by_session_id
        FROM auth_sessions AS parent
        INNER JOIN active_lineage AS child
          ON parent.replaced_by_session_id = child.id
      ), expired AS (
        SELECT session.id
        FROM auth_sessions AS session
        WHERE session.expires_at < ${sessionCutoff}
          AND NOT EXISTS (
            SELECT 1
            FROM active_lineage
            WHERE active_lineage.id = session.id
          )
        ORDER BY session.expires_at
        LIMIT ${cleanupBatchSize}
      )
      DELETE FROM auth_sessions AS session
      USING expired
      WHERE session.id = expired.id
    `);
    await this.database.execute(sql`
      WITH expired AS (
        SELECT id
        FROM outbox
        WHERE published_at < ${publishedOutboxCutoff}
        ORDER BY published_at
        LIMIT ${cleanupBatchSize}
      )
      DELETE FROM outbox
      USING expired
      WHERE outbox.id = expired.id
    `);
    await this.database.execute(sql`
      WITH expired AS (
        SELECT id
        FROM outbox
        WHERE failed_at < ${failedOutboxCutoff}
        ORDER BY failed_at
        LIMIT ${cleanupBatchSize}
      )
      DELETE FROM outbox
      USING expired
      WHERE outbox.id = expired.id
    `);
  };
}
