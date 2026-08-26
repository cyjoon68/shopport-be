import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { jest } from '@jest/globals';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

type Journal = Readonly<{
  dialect: string;
  entries: ReadonlyArray<
    Readonly<{
      breakpoints: boolean;
      idx: number;
      tag: string;
      version: string;
      when: number;
    }>
  >;
  version: string;
}>;

type ConstraintRow = Readonly<{
  definition: string;
  name: string;
  tableName: string;
  type: string;
}>;

type IndexRow = Readonly<{
  columns: string[];
  name: string;
  predicate: string | null;
  tableName: string;
}>;

type WaitingLock = Readonly<{
  applicationName: string;
  granted: boolean;
  mode: string;
  relationName: string;
}>;

const waitForWaitingAccessExclusiveLock = async (
  pool: Pool,
  applicationName: string,
  relationName: string,
): Promise<WaitingLock> => {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const waitingLock = await pool.query<WaitingLock>(
      `
        SELECT
          activity.application_name AS "applicationName",
          lock.mode,
          lock.granted,
          relation.relname AS "relationName"
        FROM pg_locks AS lock
        JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
        JOIN pg_class AS relation ON relation.oid = lock.relation
        WHERE activity.application_name = $1
          AND relation.relname = $2
          AND lock.locktype = 'relation'
          AND lock.mode = 'AccessExclusiveLock'
          AND NOT lock.granted
        ORDER BY relation.relname
        LIMIT 1
      `,
      [applicationName, relationName],
    );
    const row = waitingLock.rows[0];
    if (row) return row;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(
    `Migration did not wait for an ACCESS EXCLUSIVE lock on ${relationName}`,
  );
};

jest.setTimeout(120_000);

describe('database integrity migration', () => {
  const repositoryMigrationsDirectory = join(process.cwd(), 'migrations');
  const accountId = '0198a122-0c00-7000-8000-000000000001';
  const conversationId = '0198a122-0c00-7000-8000-000000000002';
  const messageId = '0198a122-0c00-7000-8000-000000000003';
  const validPartId = '0198a122-0c00-7000-8000-000000000004';
  const orphanPartId = '0198a122-0c00-7000-8000-000000000005';
  const orphanMessageId = '0198a122-0c00-7000-8000-000000000006';
  const outboxId = '0198a122-0c00-7000-8000-000000000007';
  const concurrentMessageId = '0198a122-0c00-7000-8000-000000000008';
  const concurrentPartId = '0198a122-0c00-7000-8000-000000000009';
  const concurrentOrphanPartId = '0198a122-0c00-7000-8000-000000000010';
  const concurrentOrphanMessageId = '0198a122-0c00-7000-8000-000000000011';
  const messageCreatedAt = '2026-08-26T00:00:00.000Z';
  const duplicateCreatedAt = '2026-08-27T00:00:00.000Z';
  const concurrentCreatedAt = '2026-08-28T00:00:00.000Z';
  let pool: Pool | undefined;
  let postgres: StartedPostgreSqlContainer | undefined;
  let temporaryMigrationDirectory: string | undefined;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16.8-alpine')
      .withCommand([
        'postgres',
        '-c',
        'shared_preload_libraries=pg_stat_statements',
      ])
      .withDatabase('shopport')
      .withUsername('shopport')
      .withPassword('shopport')
      .start();
    pool = new Pool({ connectionString: postgres.getConnectionUri() });
  });

  afterEach(async () => {
    if (temporaryMigrationDirectory) {
      await rm(temporaryMigrationDirectory, { recursive: true, force: true });
      temporaryMigrationDirectory = undefined;
    }
  });

  afterAll(async () => {
    await pool?.end();
    await postgres?.stop();
  });

  it('preserves valid and concurrent writes, removes orphans, and enforces integrity', async () => {
    if (!pool) throw new Error('PostgreSQL test pool was not initialized');

    const journalPath = join(
      repositoryMigrationsDirectory,
      'meta',
      '_journal.json',
    );
    const completeJournalText = await readFile(journalPath, 'utf8');
    const completeJournal = JSON.parse(completeJournalText) as Journal;
    const legacyJournal = {
      ...completeJournal,
      entries: completeJournal.entries.filter((entry) => entry.idx <= 8),
    };
    temporaryMigrationDirectory = await mkdtemp(
      join(tmpdir(), 'shopport-migrations-'),
    );

    for (const entry of legacyJournal.entries) {
      await cp(
        join(repositoryMigrationsDirectory, `${entry.tag}.sql`),
        join(temporaryMigrationDirectory, `${entry.tag}.sql`),
      );
    }
    await cp(
      join(repositoryMigrationsDirectory, 'meta'),
      join(temporaryMigrationDirectory, 'meta'),
      { recursive: true },
    );
    await rm(join(temporaryMigrationDirectory, 'meta', '0009_snapshot.json'), {
      force: true,
    });
    await writeFile(
      join(temporaryMigrationDirectory, 'meta', '_journal.json'),
      `${JSON.stringify(legacyJournal, null, 2)}\n`,
    );

    const database = drizzle(pool);
    await migrate(database, {
      migrationsFolder: temporaryMigrationDirectory,
    });
    await pool.query(
      "INSERT INTO accounts (id, display_name) VALUES ($1, 'Migration account')",
      [accountId],
    );
    await pool.query(
      `
        INSERT INTO conversations (id, account_id, title)
        VALUES ($1, $2, 'Migration conversation')
      `,
      [conversationId, accountId],
    );
    await pool.query(
      `
        INSERT INTO messages (id, conversation_id, role, status, created_at)
        VALUES ($1, $2, 'assistant', 'completed', $3)
      `,
      [messageId, conversationId, messageCreatedAt],
    );
    await pool.query(
      `
        INSERT INTO message_parts (id, message_id, kind, position, payload)
        VALUES
          ($1, $2, 'ask_user', 0, '{"question":"continue?"}'::jsonb),
          ($3, $4, 'text', 0, '{"text":"orphan"}'::jsonb)
      `,
      [validPartId, messageId, orphanPartId, orphanMessageId],
    );
    await pool.query(
      `
        INSERT INTO outbox (id, topic, payload, next_attempt_at, failed_at)
        VALUES ($1, 'migration.test', '{}'::jsonb, now() + interval '1 day', now())
      `,
      [outboxId],
    );

    await cp(
      join(repositoryMigrationsDirectory, '0009_message_integrity.sql'),
      join(temporaryMigrationDirectory, '0009_message_integrity.sql'),
    );
    await cp(
      join(repositoryMigrationsDirectory, 'meta', '0009_snapshot.json'),
      join(temporaryMigrationDirectory, 'meta', '0009_snapshot.json'),
    );
    await writeFile(
      join(temporaryMigrationDirectory, 'meta', '_journal.json'),
      completeJournalText,
    );

    await pool.query(
      `
        INSERT INTO messages (id, conversation_id, role, status, created_at)
        VALUES ($1, $2, 'assistant', 'completed', $3)
      `,
      [messageId, conversationId, duplicateCreatedAt],
    );
    await expect(
      migrate(database, { migrationsFolder: temporaryMigrationDirectory }),
    ).rejects.toMatchObject({
      cause: { code: '23505', constraint: 'messages_v2_pkey' },
    });
    await pool.query('DELETE FROM messages WHERE id = $1 AND created_at = $2', [
      messageId,
      duplicateCreatedAt,
    ]);

    if (!postgres) throw new Error('PostgreSQL test container was not started');
    const migrationApplicationName = 'database-integrity-migration';
    const migrationPool = new Pool({
      application_name: migrationApplicationName,
      connectionString: postgres.getConnectionUri(),
      max: 1,
    });
    const messageWriter = await pool.connect();
    const partsWriter = await pool.connect();
    let migrationPromise: Promise<void> | undefined;
    let messageWriterTransactionOpen = false;
    let partsWriterTransactionOpen = false;
    try {
      await messageWriter.query('BEGIN');
      messageWriterTransactionOpen = true;
      await messageWriter.query(
        `
          INSERT INTO messages (id, conversation_id, role, status, created_at)
          VALUES ($1, $2, 'assistant', 'completed', $3)
        `,
        [concurrentMessageId, conversationId, concurrentCreatedAt],
      );
      await partsWriter.query('BEGIN');
      partsWriterTransactionOpen = true;
      await partsWriter.query(
        `
          INSERT INTO message_parts (id, message_id, kind, position, payload)
          VALUES
            ($1, $2, 'text', 0, '{"text":"concurrent"}'::jsonb),
            ($3, $4, 'text', 0, '{"text":"concurrent orphan"}'::jsonb)
        `,
        [
          concurrentPartId,
          concurrentMessageId,
          concurrentOrphanPartId,
          concurrentOrphanMessageId,
        ],
      );

      migrationPromise = migrate(drizzle(migrationPool), {
        migrationsFolder: temporaryMigrationDirectory,
      });
      const waitingMessageLock = await waitForWaitingAccessExclusiveLock(
        pool,
        migrationApplicationName,
        'messages',
      );
      expect(waitingMessageLock).toEqual({
        applicationName: migrationApplicationName,
        granted: false,
        mode: 'AccessExclusiveLock',
        relationName: 'messages',
      });

      await messageWriter.query('COMMIT');
      messageWriterTransactionOpen = false;
      const waitingPartsLock = await waitForWaitingAccessExclusiveLock(
        pool,
        migrationApplicationName,
        'message_parts',
      );
      expect(waitingPartsLock).toEqual({
        applicationName: migrationApplicationName,
        granted: false,
        mode: 'AccessExclusiveLock',
        relationName: 'message_parts',
      });
      const messagesHierarchyLocks = await pool.query<{
        relationName: string;
      }>(
        `
          SELECT relation.relname AS "relationName"
          FROM pg_locks AS lock
          JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
          JOIN pg_class AS relation ON relation.oid = lock.relation
          WHERE activity.application_name = $1
            AND relation.relname IN ('messages', 'messages_default')
            AND lock.mode = 'AccessExclusiveLock'
            AND lock.granted
          ORDER BY relation.relname
        `,
        [migrationApplicationName],
      );
      expect(messagesHierarchyLocks.rows).toEqual([
        { relationName: 'messages' },
        { relationName: 'messages_default' },
      ]);

      await partsWriter.query('COMMIT');
      partsWriterTransactionOpen = false;
      await migrationPromise;
    } finally {
      if (messageWriterTransactionOpen) await messageWriter.query('ROLLBACK');
      if (partsWriterTransactionOpen) await partsWriter.query('ROLLBACK');
      messageWriter.release();
      partsWriter.release();
      await migrationPromise?.catch(() => undefined);
      await migrationPool.end();
    }

    const concurrentMessageCount = await pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM messages WHERE id = $1',
      [concurrentMessageId],
    );
    const concurrentPartCount = await pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM message_parts WHERE id = $1',
      [concurrentPartId],
    );
    const concurrentOrphanPartCount = await pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM message_parts WHERE id = $1',
      [concurrentOrphanPartId],
    );
    expect(concurrentMessageCount.rows[0]?.count).toBe(1);
    expect(concurrentPartCount.rows[0]?.count).toBe(1);
    expect(concurrentOrphanPartCount.rows[0]?.count).toBe(0);

    const messageCount = await pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM messages WHERE id = $1',
      [messageId],
    );
    const validPartCount = await pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM message_parts WHERE id = $1',
      [validPartId],
    );
    const orphanPartCount = await pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM message_parts WHERE id = $1',
      [orphanPartId],
    );
    const primaryKey = await pool.query<{ columns: string[] }>(`
      SELECT array_agg(attribute.attname ORDER BY key.ordinality)::text[] AS columns
      FROM pg_constraint AS constraint_record
      CROSS JOIN LATERAL unnest(constraint_record.conkey)
        WITH ORDINALITY AS key(attnum, ordinality)
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = constraint_record.conrelid
        AND attribute.attnum = key.attnum
      WHERE constraint_record.conrelid = 'messages'::regclass
        AND constraint_record.contype = 'p'
    `);
    const messagePartsForeignKey = await pool.query<{ deleteRule: string }>(`
      SELECT CASE constraint_record.confdeltype
        WHEN 'c' THEN 'CASCADE'
        WHEN 'n' THEN 'SET NULL'
        WHEN 'd' THEN 'SET DEFAULT'
        WHEN 'r' THEN 'RESTRICT'
        ELSE 'NO ACTION'
      END AS "deleteRule"
      FROM pg_constraint AS constraint_record
      WHERE constraint_record.conrelid = 'message_parts'::regclass
        AND constraint_record.conname = 'message_parts_message_id_messages_id_fk'
    `);

    expect(messageCount.rows[0]?.count).toBe(1);
    expect(validPartCount.rows[0]?.count).toBe(1);
    expect(orphanPartCount.rows[0]?.count).toBe(0);
    expect(primaryKey.rows[0]?.columns).toEqual(['id']);
    expect(messagePartsForeignKey.rows[0]?.deleteRule).toBe('CASCADE');

    const constraints = await pool.query<ConstraintRow>(`
      SELECT
        relation.relname AS "tableName",
        constraint_record.conname AS name,
        constraint_record.contype AS type,
        pg_get_constraintdef(constraint_record.oid) AS definition
      FROM pg_constraint AS constraint_record
      JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
      WHERE constraint_record.conrelid IN (
        'messages'::regclass,
        'message_parts'::regclass
      )
      ORDER BY relation.relname, constraint_record.conname
    `);
    expect(constraints.rows).toEqual([
      {
        definition:
          "CHECK ((kind = ANY (ARRAY['text'::text, 'image'::text, 'product_reference'::text, 'tool_status'::text, 'ask_user'::text])))",
        name: 'message_parts_kind_check',
        tableName: 'message_parts',
        type: 'c',
      },
      {
        definition:
          'FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE',
        name: 'message_parts_message_id_messages_id_fk',
        tableName: 'message_parts',
        type: 'f',
      },
      {
        definition: 'UNIQUE (message_id, "position")',
        name: 'message_parts_message_id_position_key',
        tableName: 'message_parts',
        type: 'u',
      },
      {
        definition: 'PRIMARY KEY (id)',
        name: 'message_parts_pkey',
        tableName: 'message_parts',
        type: 'p',
      },
      {
        definition: 'CHECK (("position" >= 0))',
        name: 'message_parts_position_check',
        tableName: 'message_parts',
        type: 'c',
      },
      {
        definition:
          'FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE',
        name: 'messages_conversation_id_conversations_id_fk',
        tableName: 'messages',
        type: 'f',
      },
      {
        definition: 'PRIMARY KEY (id)',
        name: 'messages_pkey',
        tableName: 'messages',
        type: 'p',
      },
      {
        definition:
          "CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text])))",
        name: 'messages_role_check',
        tableName: 'messages',
        type: 'c',
      },
      {
        definition:
          "CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text])))",
        name: 'messages_status_check',
        tableName: 'messages',
        type: 'c',
      },
    ]);

    const indexNames = [
      'ai_runs_account_id_idx',
      'ai_runs_conversation_id_idx',
      'archive_manifests_account_id_idx',
      'assets_conversation_id_idx',
      'auth_identities_account_id_idx',
      'auth_sessions_account_id_idx',
      'message_parts_message_id_idx',
      'messages_conversation_created_idx',
      'messages_created_id_idx',
      'outbox_ready_idx',
      'saved_products_account_saved_product_idx',
    ];
    const indexes = await pool.query<IndexRow>(
      `
        SELECT
          index_relation.relname AS name,
          table_relation.relname AS "tableName",
          ARRAY(
            SELECT pg_get_indexdef(
              index_record.indexrelid,
              key_position,
              true
            ) || CASE
              WHEN index_record.indoption[key_position - 1] & 1 = 1
                THEN ' DESC' || CASE
                  WHEN index_record.indoption[key_position - 1] & 2 = 2
                    THEN ' NULLS FIRST'
                  ELSE ' NULLS LAST'
                END
              ELSE ''
            END
            FROM generate_series(1, index_record.indnkeyatts) AS key_position
          ) AS columns,
          pg_get_expr(index_record.indpred, index_record.indrelid) AS predicate
        FROM pg_index AS index_record
        JOIN pg_class AS index_relation
          ON index_relation.oid = index_record.indexrelid
        JOIN pg_class AS table_relation
          ON table_relation.oid = index_record.indrelid
        WHERE index_relation.relname = ANY($1::text[])
        ORDER BY index_relation.relname
      `,
      [indexNames],
    );
    expect(indexes.rows).toEqual([
      {
        columns: ['account_id'],
        name: 'ai_runs_account_id_idx',
        predicate: null,
        tableName: 'ai_runs',
      },
      {
        columns: ['conversation_id'],
        name: 'ai_runs_conversation_id_idx',
        predicate: null,
        tableName: 'ai_runs',
      },
      {
        columns: ['account_id'],
        name: 'archive_manifests_account_id_idx',
        predicate: null,
        tableName: 'archive_manifests',
      },
      {
        columns: ['conversation_id'],
        name: 'assets_conversation_id_idx',
        predicate: null,
        tableName: 'assets',
      },
      {
        columns: ['account_id'],
        name: 'auth_identities_account_id_idx',
        predicate: null,
        tableName: 'auth_identities',
      },
      {
        columns: ['account_id'],
        name: 'auth_sessions_account_id_idx',
        predicate: null,
        tableName: 'auth_sessions',
      },
      {
        columns: ['message_id'],
        name: 'message_parts_message_id_idx',
        predicate: null,
        tableName: 'message_parts',
      },
      {
        columns: ['conversation_id', 'created_at DESC NULLS LAST', 'id'],
        name: 'messages_conversation_created_idx',
        predicate: null,
        tableName: 'messages',
      },
      {
        columns: ['created_at', 'id'],
        name: 'messages_created_id_idx',
        predicate: null,
        tableName: 'messages',
      },
      {
        columns: ['next_attempt_at', 'created_at', 'id'],
        name: 'outbox_ready_idx',
        predicate: '(published_at IS NULL)',
        tableName: 'outbox',
      },
      {
        columns: [
          'account_id',
          'saved_at DESC NULLS LAST',
          'product_id DESC NULLS LAST',
        ],
        name: 'saved_products_account_saved_product_idx',
        predicate: null,
        tableName: 'saved_products',
      },
    ]);

    const removedObjects = await pool.query<{
      failedRetentionIndex: string | null;
      messagesDefault: string | null;
    }>(`
      SELECT
        to_regclass('public.messages_default')::text AS "messagesDefault",
        to_regclass('public.outbox_failed_retention_idx')::text AS "failedRetentionIndex"
    `);
    expect(removedObjects.rows[0]).toEqual({
      failedRetentionIndex: null,
      messagesDefault: null,
    });

    const reactivatedOutbox = await pool.query<{
      failedAt: Date | null;
      ready: boolean;
    }>(
      `
        SELECT failed_at AS "failedAt", next_attempt_at <= now() AS ready
        FROM outbox
        WHERE id = $1
      `,
      [outboxId],
    );
    expect(reactivatedOutbox.rows[0]).toEqual({ failedAt: null, ready: true });

    await pool.query('DELETE FROM messages WHERE id = $1', [messageId]);
    const cascadedPartCount = await pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM message_parts WHERE id = $1',
      [validPartId],
    );
    expect(cascadedPartCount.rows[0]?.count).toBe(0);

    const migrationCountBeforeRerun = await pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations',
    );
    await migrate(database, {
      migrationsFolder: temporaryMigrationDirectory,
    });
    const migrationCountAfterRerun = await pool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations',
    );
    expect(migrationCountAfterRerun.rows[0]?.count).toBe(
      migrationCountBeforeRerun.rows[0]?.count,
    );
  });
});
