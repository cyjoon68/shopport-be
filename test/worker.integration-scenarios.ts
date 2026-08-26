import { expect, it } from '@jest/globals';
import type { TestingModule } from '@nestjs/testing';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { DATABASE } from '../src/database/database.module.js';
import type { ArchiveReader } from '../src/modules/archive/archive.reader.js';
import type { ArchiveWriter } from '../src/modules/archive/archive.writer.js';
import type { ObjectStore } from '../src/storage/object-store.js';
import type { StorageBucket } from '../src/storage/storage-buckets.js';
import { OutboxProcessor } from '../src/worker/outbox.processor.js';
import type { OutboxWakeup } from '../src/worker/outbox-wakeup.js';
import type { RetentionCleanup } from '../src/worker/retention-cleanup.js';

type WorkerFixture = Readonly<{
  archiveReader: ArchiveReader;
  archiveWriter: ArchiveWriter;
  conversationId: string;
  integrationSubject: string;
  objectDeleteKeyCalls: Array<readonly [StorageBucket, string]>;
  objectDeletePrefixCalls: Array<readonly [StorageBucket, string]>;
  objectGetCalls: Array<readonly [StorageBucket, string]>;
  objectPutCalls: Array<readonly [StorageBucket, string]>;
  objectStore: ObjectStore;
  outboxProcessor: OutboxProcessor;
  outboxWakeup: OutboxWakeup;
  pool: Pool;
  retentionCleanup: RetentionCleanup;
  storedObjects: Map<string, Buffer>;
  workerModule: TestingModule;
}>;

export const registerWorkerScenarios = (
  getFixture: () => WorkerFixture,
): void => {
  it('uses archive storage and purges each split bucket', async () => {
    const {
      archiveReader,
      archiveWriter,
      conversationId,
      integrationSubject,
      objectDeleteKeyCalls,
      objectDeletePrefixCalls,
      objectGetCalls,
      objectPutCalls,
      outboxProcessor,
      pool,
      storedObjects,
    } = getFixture();
    const account = await pool.query<{ account_id: string }>(
      `select account_id
       from auth_identities
       where provider = 'kakao' and provider_subject = '${integrationSubject}'`,
    );
    const accountId = account.rows.at(0)?.account_id;
    if (!accountId) throw new Error('Expected Kakao account');
    const archivedMessageId = uuidv7();
    const archivedPartId = uuidv7();
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1_000);
    objectPutCalls.length = 0;
    objectGetCalls.length = 0;
    storedObjects.clear();
    await pool.query(
      `insert into messages
       (id, conversation_id, role, status, created_at)
       values ($1, $2, 'user', 'completed', $3)`,
      [archivedMessageId, conversationId, old],
    );
    await pool.query(
      `insert into message_parts
       (id, message_id, kind, position, payload)
       values ($1, $2, 'text', 0, $3::jsonb)`,
      [archivedPartId, archivedMessageId, JSON.stringify({ text: 'archive' })],
    );

    await expect(archiveWriter.archive()).resolves.toBe(true);
    const archiveKey = objectPutCalls.at(0)?.at(1);
    if (!archiveKey) throw new Error('Expected archive object key');
    expect(objectPutCalls.at(0)?.at(0)).toBe('archive');
    expect(archiveKey).toEqual(expect.stringMatching(/^archives\//u));
    expect(objectGetCalls).toContainEqual(['archive', archiveKey]);

    const archives = await archiveReader.forConversations([conversationId]);
    expect(archives.get(conversationId)?.messages).toEqual([
      expect.objectContaining({ id: archivedMessageId }),
    ]);
    expect(objectGetCalls.at(-1)).toEqual(['archive', archiveKey]);
    await expect(
      pool.query('select id from message_parts where id = $1', [
        archivedPartId,
      ]),
    ).resolves.toMatchObject({ rows: [] });

    const purgeAccountId = uuidv7();
    const originalKey = `uploads/${purgeAccountId}/${uuidv7()}/original`;
    const normalizedKey = originalKey.replace(
      /\/original$/u,
      '/normalized.jpg',
    );
    await pool.query(
      `insert into accounts
       (id, display_name)
       values ($1, 'purge')`,
      [purgeAccountId],
    );
    await pool.query(
      `insert into outbox (id, topic, payload)
       values
       ($1, 'asset.purge', $2::jsonb),
       ($3, 'account.purge', $4::jsonb)`,
      [
        uuidv7(),
        JSON.stringify({
          accountId: purgeAccountId,
          originalKey,
          normalizedKey,
        }),
        uuidv7(),
        JSON.stringify({ accountId: purgeAccountId }),
      ],
    );
    objectDeleteKeyCalls.length = 0;
    objectDeletePrefixCalls.length = 0;

    await expect(outboxProcessor.process()).resolves.toBe(true);

    expect(objectDeleteKeyCalls).toContainEqual(['raw', originalKey]);
    expect(objectDeleteKeyCalls).toContainEqual(['normalized', normalizedKey]);
    expect(objectDeletePrefixCalls).toContainEqual([
      'raw',
      `uploads/${purgeAccountId}/`,
    ]);
    expect(objectDeletePrefixCalls).toContainEqual([
      'normalized',
      `uploads/${purgeAccountId}/`,
    ]);
    expect(objectDeletePrefixCalls).toContainEqual([
      'archive',
      `archives/${purgeAccountId}/`,
    ]);
  }, 30_000);

  it('claims an outbox event once across competing workers', async () => {
    const {
      integrationSubject,
      objectDeleteKeyCalls,
      objectStore,
      outboxProcessor,
      pool,
      workerModule,
    } = getFixture();
    const account = await pool.query<{ account_id: string }>(
      `select account_id
       from auth_identities
       where provider = 'kakao' and provider_subject = '${integrationSubject}'`,
    );
    const accountId = account.rows.at(0)?.account_id;
    if (!accountId) throw new Error('Expected Kakao account');
    const eventId = uuidv7();
    const originalKey = `uploads/${accountId}/${uuidv7()}/original`;
    objectDeleteKeyCalls.length = 0;
    await pool.query(
      `insert into outbox (id, topic, payload)
       values ($1, 'asset.purge', $2::jsonb)`,
      [
        eventId,
        JSON.stringify({ accountId, originalKey, normalizedKey: null }),
      ],
    );
    const competingProcessor = new OutboxProcessor(
      workerModule.get(DATABASE),
      objectStore,
    );

    const results = await Promise.all([
      outboxProcessor.process(),
      competingProcessor.process(),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      objectDeleteKeyCalls.filter(
        ([bucket, key]) => bucket === 'raw' && key === originalKey,
      ),
    ).toHaveLength(1);
    const event = await pool.query<{
      locked_by: string | null;
      published_at: Date | null;
    }>('select locked_by, published_at from outbox where id = $1', [eventId]);
    expect(event.rows.at(0)?.locked_by).toBeNull();
    expect(event.rows.at(0)?.published_at).toBeInstanceOf(Date);
  });

  it('wakes the outbox worker only for committed changes', async () => {
    const { outboxWakeup, pool } = getFixture();
    const committedId = uuidv7();
    const rolledBackId = uuidv7();
    const signal = new AbortController().signal;
    const client = await pool.connect();
    await outboxWakeup.listen();
    try {
      await client.query('begin');
      await client.query(
        `insert into outbox (id, topic, payload)
         values ($1, 'test.wakeup', '{}'::jsonb)`,
        [committedId],
      );
      await expect(outboxWakeup.wait(200, signal)).resolves.toBe(false);
      await client.query('commit');
      await expect(outboxWakeup.wait(2_000, signal)).resolves.toBe(true);

      await client.query('begin');
      await client.query(
        `insert into outbox (id, topic, payload)
         values ($1, 'test.wakeup', '{}'::jsonb)`,
        [rolledBackId],
      );
      await client.query('rollback');
      await expect(outboxWakeup.wait(200, signal)).resolves.toBe(false);
    } finally {
      await client.query('rollback');
      client.release();
    }
    await pool.query('delete from outbox where id = $1', [committedId]);
  });

  it('retains active refresh-token lineage while pruning expired runtime rows', async () => {
    const { integrationSubject, pool, retentionCleanup } = getFixture();
    const account = await pool.query<{ account_id: string }>(
      `select account_id
       from auth_identities
       where provider = 'kakao' and provider_subject = '${integrationSubject}'`,
    );
    const accountId = account.rows.at(0)?.account_id;
    if (!accountId) throw new Error('Expected Kakao account');
    const now = new Date();
    const parentId = uuidv7();
    const childId = uuidv7();
    const expiredId = uuidv7();
    const publishedId = uuidv7();
    const failedId = uuidv7();
    const retainedId = uuidv7();
    await pool.query(
      `insert into auth_sessions
       (id, account_id, token_hash, expires_at, replaced_by_session_id)
       values
       ($1, $4, $5, $6, $2),
       ($2, $4, $7, $8, null),
       ($3, $4, $9, $6, null)`,
      [
        parentId,
        childId,
        expiredId,
        accountId,
        `parent-${parentId}`,
        new Date(now.getTime() - 40 * 86_400_000),
        `child-${childId}`,
        new Date(now.getTime() + 30 * 86_400_000),
        `expired-${expiredId}`,
      ],
    );
    await pool.query(
      `insert into outbox (id, topic, payload, published_at, failed_at)
       values
       ($1, 'asset.purge', '{}'::jsonb, $4, null),
       ($2, 'asset.purge', '{}'::jsonb, null, $5),
       ($3, 'asset.purge', '{}'::jsonb, $6, null)`,
      [
        publishedId,
        failedId,
        retainedId,
        new Date(now.getTime() - 8 * 86_400_000),
        new Date(now.getTime() - 31 * 86_400_000),
        new Date(now.getTime() - 86_400_000),
      ],
    );

    await retentionCleanup.cleanup(now);

    const sessions = await pool.query<{ id: string }>(
      'select id from auth_sessions where id = any($1::uuid[]) order by id',
      [[parentId, childId, expiredId]],
    );
    expect(sessions.rows.map(({ id }) => id).sort()).toEqual(
      [parentId, childId].sort(),
    );
    const events = await pool.query<{ id: string }>(
      'select id from outbox where id = any($1::uuid[]) order by id',
      [[publishedId, failedId, retainedId]],
    );
    expect(events.rows.map(({ id }) => id)).toEqual([retainedId]);
  });
};
