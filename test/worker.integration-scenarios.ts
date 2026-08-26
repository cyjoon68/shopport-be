import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { expect, it, jest } from '@jest/globals';
import type { TestingModule } from '@nestjs/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import { DATABASE } from '../src/database/database.module.js';
import type { ArchiveReader } from '../src/modules/archive/archive.reader.js';
import type { ArchiveWriter } from '../src/modules/archive/archive.writer.js';
import { assetKeysFor } from '../src/modules/assets/keys.js';
import type { ObjectStore } from '../src/storage/object-store.js';
import type { StorageBucket } from '../src/storage/storage-buckets.js';
import type { AssetResultConsumer } from '../src/worker/asset-result.consumer.js';
import { OutboxProcessor } from '../src/worker/outbox.processor.js';
import type { OutboxWakeup } from '../src/worker/outbox-wakeup.js';
import type { RetentionCleanup } from '../src/worker/retention-cleanup.js';

type WorkerFixture = Readonly<{
  archiveReader: ArchiveReader;
  archiveWriter: ArchiveWriter;
  assetResultConsumer: AssetResultConsumer;
  baseUrl: string;
  conversationId: string;
  createAiOwner: () => Promise<AiOwner>;
  integrationSubject: string;
  normalizationResultOrder: string[];
  objectDeleteKeyCalls: Array<readonly [StorageBucket, string]>;
  objectDeletePrefixCalls: Array<readonly [StorageBucket, string]>;
  objectGetCalls: Array<readonly [StorageBucket, string]>;
  objectPutCalls: Array<readonly [StorageBucket, string]>;
  objectStore: ObjectStore;
  outboxProcessor: OutboxProcessor;
  outboxWakeup: OutboxWakeup;
  pool: Pool;
  retentionCleanup: RetentionCleanup;
  setNormalizationDeleteBarrier: (
    barrier: Promise<void> | undefined,
    key?: readonly [StorageBucket, string],
  ) => void;
  setObjectDeleteError: (error: Error | undefined) => void;
  setResolveNormalizationDeleteStarted: (
    resolve: (() => void) | undefined,
  ) => void;
  storedObjects: Map<string, Buffer>;
  workerModule: TestingModule;
}>;

type AiOwner = Readonly<{
  accessToken: string;
  accountId: string;
  conversationId: string;
}>;

export const registerWorkerScenarios = (
  getFixture: () => WorkerFixture,
): void => {
  it('deletes a normalization result after asset deletion before acknowledging it', async () => {
    const {
      assetResultConsumer,
      baseUrl,
      createAiOwner,
      normalizationResultOrder,
      objectDeleteKeyCalls,
      pool,
      setNormalizationDeleteBarrier,
      setResolveNormalizationDeleteStarted,
    } = getFixture();
    const owner = await createAiOwner();
    const uploadResponse = await request(baseUrl)
      .post('/graphql')
      .set('authorization', `Bearer ${owner.accessToken}`)
      .send({
        query:
          'mutation Upload($input: CreateAssetUploadInput!) { createAssetUpload(input: $input) { upload { asset { id } } userErrors { code } } }',
        variables: {
          input: {
            conversationId: owner.conversationId,
            contentType: 'image/jpeg',
            byteSize: 1024,
          },
        },
      })
      .expect(200);
    const assetId = z
      .object({
        data: z.object({
          createAssetUpload: z.object({
            upload: z.object({ asset: z.object({ id: z.uuid() }) }),
          }),
        }),
      })
      .parse(uploadResponse.body).data.createAssetUpload.upload.asset.id;
    const normalizedKey = assetKeysFor(owner.accountId, assetId).normalized;
    await request(baseUrl)
      .post('/graphql')
      .set('authorization', `Bearer ${owner.accessToken}`)
      .send({
        query:
          'mutation Delete($input: DeleteAssetInput!) { deleteAsset(input: $input) { success userErrors { code } } }',
        variables: { input: { id: assetId } },
      })
      .expect(200);
    const purgeBefore = await pool.query<{ published_at: Date | null }>(
      `select published_at
       from outbox
       where topic = 'asset.purge' and payload->>'assetId' = $1`,
      [assetId],
    );
    expect(purgeBefore.rows).toEqual([{ published_at: null }]);
    objectDeleteKeyCalls.length = 0;
    normalizationResultOrder.length = 0;
    let releaseNormalizationDelete = (): void => undefined;
    const normalizationDeleteStarted = new Promise<void>((resolve) => {
      setResolveNormalizationDeleteStarted(resolve);
    });
    setNormalizationDeleteBarrier(
      new Promise<void>((resolve) => {
        releaseNormalizationDelete = resolve;
      }),
    );
    const send = jest
      .spyOn(SQSClient.prototype, 'send')
      .mockImplementation((command: unknown) => {
        if (command instanceof ReceiveMessageCommand) {
          return Promise.resolve({
            Messages: [
              {
                Body: JSON.stringify({
                  assetId,
                  normalizedKey,
                  status: 'ready',
                  width: 640,
                  height: 480,
                }),
                ReceiptHandle: 'normalization-result',
              },
            ],
          }) as never;
        }
        if (command instanceof DeleteMessageCommand) {
          normalizationResultOrder.push(
            `ack:${command.input.ReceiptHandle ?? ''}`,
          );
        }
        return Promise.resolve({}) as never;
      });
    try {
      const consumption = assetResultConsumer.consume();
      await normalizationDeleteStarted;
      expect(normalizationResultOrder).toEqual([
        `delete:normalized:${normalizedKey}`,
      ]);
      releaseNormalizationDelete();
      await expect(consumption).resolves.toBe(true);
    } finally {
      releaseNormalizationDelete();
      setNormalizationDeleteBarrier(undefined);
      setResolveNormalizationDeleteStarted(undefined);
      send.mockRestore();
    }

    expect(objectDeleteKeyCalls).toEqual([['normalized', normalizedKey]]);
    expect(normalizationResultOrder).toEqual([
      `delete:normalized:${normalizedKey}`,
      'ack:normalization-result',
    ]);
    const purgeAfter = await pool.query<{ published_at: Date | null }>(
      `select published_at
       from outbox
       where topic = 'asset.purge' and payload->>'assetId' = $1`,
      [assetId],
    );
    expect(purgeAfter.rows).toEqual([{ published_at: null }]);
  }, 30_000);

  it('preserves a terminal asset when acknowledging a normalization duplicate', async () => {
    const { assetResultConsumer, createAiOwner, objectDeleteKeyCalls, pool } =
      getFixture();
    const owner = await createAiOwner();
    const assetId = uuidv7();
    const keys = assetKeysFor(owner.accountId, assetId);
    await pool.query(
      `insert into assets
       (id, account_id, conversation_id, status, original_key, normalized_key,
        content_type, byte_size, width, height)
       values ($1, $2, $3, 'rejected', $4, null, 'image/jpeg', 1024, null, null)`,
      [assetId, owner.accountId, owner.conversationId, keys.original],
    );
    objectDeleteKeyCalls.length = 0;
    const acknowledged: string[] = [];
    const send = jest
      .spyOn(SQSClient.prototype, 'send')
      .mockImplementation((command: unknown) => {
        if (command instanceof ReceiveMessageCommand) {
          return Promise.resolve({
            Messages: [
              {
                Body: JSON.stringify({
                  assetId,
                  normalizedKey: keys.normalized,
                  status: 'ready',
                  width: 640,
                  height: 480,
                }),
                ReceiptHandle: 'terminal-duplicate',
              },
            ],
          }) as never;
        }
        if (command instanceof DeleteMessageCommand) {
          acknowledged.push(command.input.ReceiptHandle ?? '');
        }
        return Promise.resolve({}) as never;
      });
    try {
      await expect(assetResultConsumer.consume()).resolves.toBe(true);
    } finally {
      send.mockRestore();
    }

    const persisted = await pool.query<{
      height: number | null;
      normalized_key: string | null;
      status: string;
      width: number | null;
    }>(
      `select status, normalized_key, width, height
       from assets
       where id = $1`,
      [assetId],
    );
    expect(persisted.rows).toEqual([
      {
        status: 'rejected',
        normalized_key: null,
        width: null,
        height: null,
      },
    ]);
    expect(objectDeleteKeyCalls).toHaveLength(0);
    expect(acknowledged).toEqual(['terminal-duplicate']);
  }, 30_000);

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

  it('retries an unpublished asset purge until both keys are deleted', async () => {
    const {
      objectDeleteKeyCalls,
      outboxProcessor,
      pool,
      retentionCleanup,
      setNormalizationDeleteBarrier,
      setObjectDeleteError,
      setResolveNormalizationDeleteStarted,
    } = getFixture();
    const eventId = uuidv7();
    const invalidErrorEventId = uuidv7();
    const originalKey = 'uploads/outbox-retry/asset/original';
    const normalizedKey = 'uploads/outbox-retry/asset/normalized.jpg';
    const retryNow = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(retryNow);
    objectDeleteKeyCalls.length = 0;
    let releaseNormalizedDelete = (): void => undefined;

    try {
      setObjectDeleteError(new Error('object store unavailable'));
      await pool.query(
        `insert into outbox
         (id, topic, payload, failed_at, next_attempt_at)
         values ($1, 'asset.purge', $2::jsonb, now() - interval '31 days', now())`,
        [
          eventId,
          JSON.stringify({
            accountId: '0198a122-0c00-7000-8000-000000000040',
            originalKey,
            normalizedKey,
          }),
        ],
      );
      await retentionCleanup.cleanup();
      await expect(
        pool.query('select id from outbox where id = $1', [eventId]),
      ).resolves.toMatchObject({ rows: [{ id: eventId }] });
      await expect(outboxProcessor.nextWakeDelay(60_000)).resolves.toBe(0);
      for (let attempt = 1; attempt <= 11; attempt += 1) {
        await expect(outboxProcessor.process()).resolves.toBe(true);
        const event = await pool.query<{
          attemptCount: number;
          failedAt: Date | null;
          lastError: string | null;
          lockedBy: string | null;
          lockedUntil: Date | null;
          nextAttemptAt: Date;
          publishedAt: Date | null;
        }>(
          `select attempt_count as "attemptCount",
                  failed_at as "failedAt",
                  last_error as "lastError",
                  locked_by as "lockedBy",
                  locked_until as "lockedUntil",
                  next_attempt_at as "nextAttemptAt",
                  published_at as "publishedAt"
           from outbox
           where id = $1`,
          [eventId],
        );
        expect(event.rows).toEqual([
          {
            attemptCount: attempt,
            failedAt: null,
            lastError: 'object store unavailable',
            lockedBy: null,
            lockedUntil: null,
            nextAttemptAt: new Date(
              retryNow + Math.min(2 ** attempt, 3_600) * 1_000,
            ),
            publishedAt: null,
          },
        ]);
        await retentionCleanup.cleanup();
        await expect(
          pool.query('select id from outbox where id = $1', [eventId]),
        ).resolves.toMatchObject({ rows: [{ id: eventId }] });
        await pool.query(
          'update outbox set next_attempt_at = now() where id = $1',
          [eventId],
        );
      }

      objectDeleteKeyCalls.length = 0;
      setObjectDeleteError(undefined);
      const normalizedDeleteStarted = new Promise<void>((resolve) => {
        setResolveNormalizationDeleteStarted(resolve);
      });
      setNormalizationDeleteBarrier(
        new Promise<void>((resolve) => {
          releaseNormalizedDelete = resolve;
        }),
        ['normalized', normalizedKey],
      );
      const processing = outboxProcessor.process();
      await normalizedDeleteStarted;

      const unpublished = await pool.query<{ publishedAt: Date | null }>(
        `select published_at as "publishedAt"
         from outbox
         where id = $1`,
        [eventId],
      );
      expect(unpublished.rows).toEqual([{ publishedAt: null }]);

      releaseNormalizedDelete();
      await expect(processing).resolves.toBe(true);

      expect(objectDeleteKeyCalls).toEqual([
        ['raw', originalKey],
        ['normalized', normalizedKey],
      ]);
      const published = await pool.query<{
        attemptCount: number;
        failedAt: Date | null;
        publishedAt: Date | null;
      }>(
        `select attempt_count as "attemptCount",
                failed_at as "failedAt",
                published_at as "publishedAt"
         from outbox
         where id = $1`,
        [eventId],
      );
      expect(published.rows).toHaveLength(1);
      expect(published.rows.at(0)).toMatchObject({
        attemptCount: 11,
        failedAt: null,
      });
      expect(published.rows.at(0)?.publishedAt).toBeInstanceOf(Date);

      const invalidMessage = `invalid\0${'x'.repeat(600)}`;
      setObjectDeleteError(new Error(invalidMessage));
      await pool.query(
        `insert into outbox (id, topic, payload, next_attempt_at)
         values ($1, 'asset.purge', $2::jsonb, now())`,
        [
          invalidErrorEventId,
          JSON.stringify({
            accountId: '0198a122-0c00-7000-8000-000000000040',
            originalKey: 'uploads/outbox-retry/invalid/original',
            normalizedKey: null,
          }),
        ],
      );
      await expect(outboxProcessor.process()).resolves.toBe(true);
      const sanitized = await pool.query<{
        attemptCount: number;
        lastError: string | null;
      }>(
        `select attempt_count as "attemptCount", last_error as "lastError"
         from outbox
         where id = $1`,
        [invalidErrorEventId],
      );
      expect(sanitized.rows).toEqual([
        {
          attemptCount: 1,
          lastError: `invalid${'x'.repeat(600)}`.slice(0, 500),
        },
      ]);
    } finally {
      releaseNormalizedDelete();
      setNormalizationDeleteBarrier(undefined);
      setResolveNormalizationDeleteStarted(undefined);
      setObjectDeleteError(undefined);
      now.mockRestore();
      await pool.query('delete from outbox where id = any($1::uuid[])', [
        [eventId, invalidErrorEventId],
      ]);
    }
  }, 30_000);

  it('maintenance advisory locks serialize archive and retention across connections', async () => {
    const {
      archiveWriter,
      createAiOwner,
      objectPutCalls,
      pool,
      retentionCleanup,
    } = getFixture();
    const owner = await createAiOwner();
    const archivedMessageId = uuidv7();
    const publishedOutboxId = uuidv7();
    const oldMessage = new Date(Date.now() - 100 * 86_400_000);
    const oldOutbox = new Date(Date.now() - 8 * 86_400_000);
    await pool.query(
      `insert into messages
       (id, conversation_id, role, status, created_at)
       values ($1, $2, 'user', 'completed', $3)`,
      [archivedMessageId, owner.conversationId, oldMessage],
    );
    await pool.query(
      `insert into outbox (id, topic, payload, published_at)
       values ($1, 'asset.purge', '{}'::jsonb, $2)`,
      [publishedOutboxId, oldOutbox],
    );
    objectPutCalls.length = 0;
    const archiveBlocker = await pool.connect();
    try {
      await archiveBlocker.query('begin');
      await archiveBlocker.query(
        "select pg_advisory_xact_lock(hashtextextended('shopport.archive', 0))",
      );

      await expect(archiveWriter.archive()).resolves.toBe(false);
      await expect(
        pool.query('select id from messages where id = $1', [
          archivedMessageId,
        ]),
      ).resolves.toMatchObject({ rows: [{ id: archivedMessageId }] });
      expect(objectPutCalls).toHaveLength(0);

      await archiveBlocker.query('commit');
      await expect(archiveWriter.archive()).resolves.toBe(true);
      await expect(
        pool.query('select id from messages where id = $1', [
          archivedMessageId,
        ]),
      ).resolves.toMatchObject({ rows: [] });
    } finally {
      await archiveBlocker.query('rollback');
      archiveBlocker.release();
    }

    const retentionBlocker = await pool.connect();
    try {
      await retentionBlocker.query('begin');
      await retentionBlocker.query(
        "select pg_advisory_xact_lock(hashtextextended('shopport.retention', 0))",
      );

      await retentionCleanup.cleanup();
      await expect(
        pool.query('select id from outbox where id = $1', [publishedOutboxId]),
      ).resolves.toMatchObject({ rows: [{ id: publishedOutboxId }] });

      await retentionBlocker.query('commit');
      await retentionCleanup.cleanup();
      await expect(
        pool.query('select id from outbox where id = $1', [publishedOutboxId]),
      ).resolves.toMatchObject({ rows: [] });
    } finally {
      await retentionBlocker.query('rollback');
      retentionBlocker.release();
    }
  }, 30_000);

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
    expect(events.rows.map(({ id }) => id).sort()).toEqual(
      [failedId, retainedId].sort(),
    );
  });
};
