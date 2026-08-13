import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import request from 'supertest';
import { GenericContainer } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { ArchiveReader } from '../src/modules/archive/archive.reader.js';
import { ArchiveWriter } from '../src/modules/archive/archive.writer.js';
import { ObjectStore } from '../src/storage/object-store.js';
import type { StorageBucket } from '../src/storage/storage-buckets.js';
import { OutboxProcessor } from '../src/worker/outbox.processor.js';
import { StaleRunRecovery } from '../src/worker/stale-run-recovery.js';
import { WorkerModule } from '../src/worker/worker.module.js';

const storedObjects = new Map<string, Buffer>();
const objectPutCalls: Array<readonly [StorageBucket, string]> = [];
const objectGetCalls: Array<readonly [StorageBucket, string]> = [];
const objectDeleteKeyCalls: Array<readonly [StorageBucket, string]> = [];
const objectDeletePrefixCalls: Array<readonly [StorageBucket, string]> = [];
const objectStore = {
  put: (bucket: StorageBucket, key: string, body: Buffer): Promise<void> => {
    objectPutCalls.push([bucket, key]);
    storedObjects.set(`${bucket}:${key}`, body);
    return Promise.resolve();
  },
  get: (bucket: StorageBucket, key: string): Promise<Buffer> => {
    objectGetCalls.push([bucket, key]);
    const body = storedObjects.get(`${bucket}:${key}`);
    return body
      ? Promise.resolve(body)
      : Promise.reject(new Error('Object not found'));
  },
  deleteKey: (bucket: StorageBucket, key: string): Promise<void> => {
    objectDeleteKeyCalls.push([bucket, key]);
    return Promise.resolve();
  },
  deletePrefix: (bucket: StorageBucket, prefix: string): Promise<void> => {
    objectDeletePrefixCalls.push([bucket, prefix]);
    return Promise.resolve();
  },
};

const loginSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.literal(900),
});

const conversationSchema = z.object({
  data: z.object({
    createConversation: z.object({
      conversation: z.object({ id: z.uuid() }),
      userErrors: z.array(z.unknown()),
    }),
  }),
});

const searchSchema = z.object({
  data: z.object({
    searchProducts: z.object({
      edges: z.array(
        z.object({ node: z.object({ id: z.uuid(), title: z.string() }) }),
      ),
    }),
  }),
});

const streamChunkSchema = z.union([
  z.object({
    type: z.string(),
    messageId: z.uuid().optional(),
  }),
  z
    .object({
      chunk: z.object({
        type: z.string(),
        messageId: z.uuid().optional(),
      }),
    })
    .transform(({ chunk }) => chunk),
]);

const historySchema = z.object({
  data: z.object({
    conversation: z.object({
      messages: z.array(
        z.object({
          id: z.uuid(),
          role: z.enum(['USER', 'ASSISTANT']),
        }),
      ),
    }),
  }),
});

const parseStreamChunks = (
  body: string,
): ReadonlyArray<z.infer<typeof streamChunkSchema>> =>
  body
    .trim()
    .split('\n')
    .map((line) => streamChunkSchema.parse(JSON.parse(line)));

describe('Shopport API vertical flow', () => {
  let app: INestApplication;
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedTestContainer;
  let accessToken: string;
  let refreshToken: string;
  let conversationId: string;
  let completedRunId: string;
  let baseUrl: string;
  let pool: Pool;
  let workerModule: TestingModule;
  let staleRunRecovery: StaleRunRecovery;
  let archiveWriter: ArchiveWriter;
  let archiveReader: ArchiveReader;
  let outboxProcessor: OutboxProcessor;

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine')
        .withDatabase('shopport')
        .withUsername('shopport')
        .withPassword('shopport')
        .start(),
      new GenericContainer('redis:7.4-alpine').withExposedPorts(6379).start(),
    ]);
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'dev';
    process.env.DATABASE_URL = postgres.getConnectionUri();
    process.env.REDIS_URL = `redis://${redis.getHost()}:${String(redis.getMappedPort(6379))}`;
    process.env.JWT_SECRET = 'integration-test-secret-at-least-32-bytes';
    process.env.ALLOW_DEMO_AUTH = 'true';
    process.env.AI_MODE = 'fake';
    process.env.CATALOG_MODE = 'fake';
    process.env.PERSISTED_OPERATION_MANIFEST = '';
    process.env.AWS_ENDPOINT_URL = 'http://localhost:4566';
    process.env.RAW_ASSET_BUCKET = 'integration-raw';
    process.env.NORMALIZED_ASSET_BUCKET = 'integration-normalized';
    process.env.ARCHIVE_BUCKET = 'integration-archive';
    pool = new Pool({ connectionString: postgres.getConnectionUri() });
    await migrate(drizzle(pool), { migrationsFolder: './migrations' });
    await migrate(drizzle(pool), { migrationsFolder: './migrations' });
    workerModule = await Test.createTestingModule({
      imports: [WorkerModule],
    })
      .overrideProvider(ObjectStore)
      .useValue(objectStore)
      .compile();
    staleRunRecovery = workerModule.get(StaleRunRecovery);
    archiveWriter = workerModule.get(ArchiveWriter);
    archiveReader = workerModule.get(ArchiveReader);
    outboxProcessor = workerModule.get(OutboxProcessor);
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await workerModule.close();
    await pool.end();
    await Promise.all([postgres.stop(), redis.stop()]);
  });

  it('applies additive migrations idempotently', async () => {
    const columns = await pool.query<{ column_name: string }>(
      `select column_name
       from information_schema.columns
       where table_name = 'ai_runs'
         and column_name in ('deadline_at', 'heartbeat_at')`,
    );
    const constraint = await pool.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition
       from pg_constraint
       where conname = 'ai_runs_status_check'`,
    );

    expect(columns.rows).toHaveLength(2);
    expect(constraint.rows.at(0)?.definition).toContain('cancelled');
  });

  it('creates one identity and account under concurrent first login', async () => {
    const responses = await Promise.all([
      request(baseUrl).post('/v1/auth/apple').send({
        identityToken: 'demo',
        nonce: 'concurrent-login-a',
        displayName: '동시 가입 사용자',
      }),
      request(baseUrl).post('/v1/auth/apple').send({
        identityToken: 'demo',
        nonce: 'concurrent-login-b',
        displayName: '동시 가입 사용자',
      }),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    const result = await pool.query<{ count: string; display_name: string }>(
      `select count(*) over () as count, a.display_name
       from auth_identities i
       join accounts a on a.id = i.account_id
       where i.provider = 'apple' and i.provider_subject = 'demo-apple'`,
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows.at(0)).toMatchObject({
      count: '1',
      display_name: '동시 가입 사용자',
    });
  });

  it('logs in, chats, replays, saves a product, and reads history', async () => {
    const loginResponse = await request(baseUrl)
      .post('/v1/auth/apple')
      .send({ identityToken: 'demo', nonce: 'integration-nonce' })
      .expect(200);
    const login = loginSchema.parse(loginResponse.body);
    accessToken = login.accessToken;
    refreshToken = login.refreshToken;

    const conversationResponse = await request(baseUrl)
      .post('/graphql')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        query:
          'mutation Create($input: CreateConversationInput!) { createConversation(input: $input) { conversation { id } userErrors { code } } }',
        variables: { input: { title: '텀블러 찾기' } },
      })
      .expect(200);
    conversationId = conversationSchema.parse(conversationResponse.body).data
      .createConversation.conversation.id;

    await request(baseUrl)
      .post('/graphql')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        query:
          'mutation Upload($input: CreateAssetUploadInput!) { createAssetUpload(input: $input) { upload { uploadUrl } userErrors { code } } }',
        variables: {
          input: {
            conversationId,
            contentType: 'image/jpeg',
            byteSize: 1024,
          },
        },
      })
      .expect(200)
      .expect(({ text }) => {
        expect(text).toContain('/integration-raw/');
        expect(text).not.toContain('/integration-normalized/');
      });

    completedRunId = uuidv7();
    const userMessageId = uuidv7();
    const chatResponse = await request(baseUrl)
      .post('/v1/ai/chat')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        threadId: conversationId,
        runId: completedRunId,
        messages: [{ id: userMessageId, role: 'user', content: '텀블러' }],
        forwardedProps: {},
      })
      .expect(200);
    expect(chatResponse.text).toContain('TOOL_CALL_RESULT');
    expect(chatResponse.text).toContain('RUN_FINISHED');
    const assistantMessageId = parseStreamChunks(chatResponse.text).find(
      ({ type }) => type === 'TEXT_MESSAGE_START',
    )?.messageId;
    expect(assistantMessageId).toBeDefined();
    if (!assistantMessageId) throw new Error('Expected assistant message ID');

    const replay = await request(baseUrl)
      .get(`/v1/ai/chat?runId=${completedRunId}&offset=0-0`)
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(replay.text).toContain('RUN_FINISHED');

    const searchResponse = await request(baseUrl)
      .post('/graphql')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        query:
          '{ searchProducts(input: { query: "텀블러" }, first: 4) { edges { node { id title } } } }',
      })
      .expect(200);
    const product = searchSchema
      .parse(searchResponse.body)
      .data.searchProducts.edges.at(0)?.node;
    expect(product).toBeDefined();
    if (!product) throw new Error('Expected fake product');

    await request(baseUrl)
      .post('/graphql')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        query:
          'mutation Save($input: ProductSelectionInput!) { saveProduct(input: $input) { product { id isSaved } userErrors { code } } }',
        variables: { input: { productId: product.id } },
      })
      .expect(200)
      .expect(({ text }) => {
        expect(text).toContain('"isSaved":true');
      });

    const historyResponse = await request(baseUrl)
      .post('/graphql')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        query:
          'query Conversation($id: UUID!) { conversation(id: $id) { id messages { id role status parts { __typename ... on TextMessagePart { text } ... on ProductReferenceMessagePart { product { id } } } } } }',
        variables: { id: conversationId },
      })
      .expect(200);
    expect(historyResponse.text).toContain('조건에 맞는 상품');
    expect(historyResponse.text).toContain(product.id);
    const history = historySchema.parse(historyResponse.body).data.conversation
      .messages;
    expect(history).toEqual([
      expect.objectContaining({ id: userMessageId, role: 'USER' }),
      expect.objectContaining({ id: assistantMessageId, role: 'ASSISTANT' }),
    ]);

    await request(baseUrl)
      .post('/v1/ai/chat')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        threadId: conversationId,
        runId: uuidv7(),
        messages: [{ id: userMessageId, role: 'user', content: '중복 요청' }],
        forwardedProps: {},
      })
      .expect(409);
  }, 30_000);

  it('hides cross-account replay and cancel, then cancels idempotently', async () => {
    const secondLoginResponse = await request(baseUrl)
      .post('/v1/auth/kakao')
      .send({ identityToken: 'demo', nonce: 'second-account' })
      .expect(200);
    const secondLogin = loginSchema.parse(secondLoginResponse.body);

    await request(baseUrl)
      .get(`/v1/ai/chat?runId=${completedRunId}&offset=0-0`)
      .set('authorization', `Bearer ${secondLogin.accessToken}`)
      .expect(404);
    await request(baseUrl)
      .post('/v1/ai/chat')
      .set('authorization', `Bearer ${secondLogin.accessToken}`)
      .set('last-event-id', '0-0')
      .send({
        threadId: conversationId,
        runId: completedRunId,
        messages: [{ id: uuidv7(), role: 'user', content: 'resume' }],
        forwardedProps: {},
      })
      .expect(404);
    await request(baseUrl)
      .post('/v1/ai/chat/cancel')
      .set('authorization', `Bearer ${secondLogin.accessToken}`)
      .send({ threadId: conversationId, runId: completedRunId })
      .expect(404);

    const account = await pool.query<{ account_id: string }>(
      `select account_id
       from auth_identities
       where provider = 'apple' and provider_subject = 'demo-apple'`,
    );
    const accountId = account.rows.at(0)?.account_id;
    if (!accountId) throw new Error('Expected Apple account');
    const usage = await pool.query<{ usage_date: string; text_count: number }>(
      `select usage_date::text, text_count
       from daily_usage
       where account_id = $1`,
      [accountId],
    );
    const before = usage.rows.at(0);
    if (!before) throw new Error('Expected daily usage');
    const reservedRunId = uuidv7();
    const now = new Date();
    await pool.query(
      `update daily_usage
       set text_count = text_count + 1
       where account_id = $1 and usage_date = $2`,
      [accountId, before.usage_date],
    );
    await pool.query(
      `insert into ai_runs
       (id, account_id, conversation_id, usage_date, usage_kind, status,
        started_at, deadline_at, heartbeat_at)
       values ($1, $2, $3, $4, 'text', 'reserved', $5, $6, $5)`,
      [
        reservedRunId,
        accountId,
        conversationId,
        before.usage_date,
        now,
        new Date(now.getTime() + 60_000),
      ],
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await request(baseUrl)
        .post('/v1/ai/chat/cancel')
        .set('authorization', `Bearer ${accessToken}`)
        .send({ threadId: conversationId, runId: reservedRunId })
        .expect(204);
    }
    const cancelled = await pool.query<{
      status: string;
      text_count: number;
      assistant_count: number;
    }>(
      `select r.status, u.text_count,
              count(m.id) filter (where m.role = 'assistant')::int as assistant_count
       from ai_runs r
       join daily_usage u
         on u.account_id = r.account_id and u.usage_date = r.usage_date
       left join messages m on m.run_id = r.id
       where r.id = $1
       group by r.status, u.text_count`,
      [reservedRunId],
    );

    expect(cancelled.rows.at(0)).toEqual({
      status: 'cancelled',
      text_count: before.text_count,
      assistant_count: 0,
    });

    await request(baseUrl)
      .post('/v1/ai/chat/cancel')
      .set('authorization', `Bearer ${accessToken}`)
      .send({ threadId: conversationId, runId: completedRunId })
      .expect(204);

    const refreshResponses = await Promise.all([
      request(baseUrl)
        .post('/v1/auth/refresh')
        .send({ refreshToken: secondLogin.refreshToken }),
      request(baseUrl)
        .post('/v1/auth/refresh')
        .send({ refreshToken: secondLogin.refreshToken }),
    ]);
    expect(refreshResponses.map(({ status }) => status).sort()).toEqual([
      200, 401,
    ]);
    await request(baseUrl)
      .post('/v1/auth/refresh')
      .send({ refreshToken: secondLogin.refreshToken })
      .expect(401);
    const successors = await pool.query<{ count: string }>(
      `select count(*)::text as count
       from auth_sessions parent
       join auth_sessions child on child.id = parent.replaced_by_session_id
       join auth_identities identity on identity.account_id = parent.account_id
       where identity.provider = 'kakao'
         and identity.provider_subject = 'demo-kakao'`,
    );
    expect(successors.rows.at(0)?.count).toBe('1');
  }, 30_000);

  it('recovers only stale reserved runs and refunds quota once', async () => {
    const account = await pool.query<{ account_id: string }>(
      `select account_id
       from auth_identities
       where provider = 'apple' and provider_subject = 'demo-apple'`,
    );
    const accountId = account.rows.at(0)?.account_id;
    if (!accountId) throw new Error('Expected Apple account');
    const usage = await pool.query<{ usage_date: string; text_count: number }>(
      `select usage_date::text, text_count
       from daily_usage
       where account_id = $1`,
      [accountId],
    );
    const before = usage.rows.at(0);
    if (!before) throw new Error('Expected daily usage');
    const now = new Date();
    const overdue = new Date(now.getTime() - 180_000);
    const future = new Date(now.getTime() + 180_000);
    const staleRunId = uuidv7();
    const freshRunId = uuidv7();
    const completedRunId = uuidv7();
    const cancelledRunId = uuidv7();

    await pool.query(
      `update daily_usage
       set text_count = text_count + 2
       where account_id = $1 and usage_date = $2`,
      [accountId, before.usage_date],
    );
    await pool.query(
      `insert into ai_runs
       (id, account_id, conversation_id, usage_date, usage_kind, status,
        started_at, deadline_at, heartbeat_at, completed_at)
       values
       ($1, $5, $6, $7, 'text', 'reserved', $8, $8, $8, null),
       ($2, $5, $6, $7, 'text', 'reserved', $9, $9, $9, null),
       ($3, $5, $6, $7, 'text', 'completed', $8, $8, $8, $9),
       ($4, $5, $6, $7, 'text', 'cancelled', $8, $8, $8, $9)`,
      [
        staleRunId,
        freshRunId,
        completedRunId,
        cancelledRunId,
        accountId,
        conversationId,
        before.usage_date,
        overdue,
        future,
      ],
    );

    await expect(staleRunRecovery.recover()).resolves.toBe(1);
    await expect(staleRunRecovery.recover()).resolves.toBe(0);

    const runs = await pool.query<{ id: string; status: string }>(
      `select id, status
       from ai_runs
       where id = any($1::uuid[])
       order by id`,
      [[staleRunId, freshRunId, completedRunId, cancelledRunId]],
    );
    const statuses = new Map(runs.rows.map(({ id, status }) => [id, status]));
    const after = await pool.query<{ text_count: number }>(
      `select text_count
       from daily_usage
       where account_id = $1 and usage_date = $2`,
      [accountId, before.usage_date],
    );

    expect(statuses.get(staleRunId)).toBe('failed');
    expect(statuses.get(freshRunId)).toBe('reserved');
    expect(statuses.get(completedRunId)).toBe('completed');
    expect(statuses.get(cancelledRunId)).toBe('cancelled');
    expect(after.rows.at(0)?.text_count).toBe(before.text_count + 1);
  }, 30_000);

  it('uses archive storage and purges each split bucket', async () => {
    const account = await pool.query<{ account_id: string }>(
      `select account_id
       from auth_identities
       where provider = 'apple' and provider_subject = 'demo-apple'`,
    );
    const accountId = account.rows.at(0)?.account_id;
    if (!accountId) throw new Error('Expected Apple account');
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

    const purgeAccountId = uuidv7();
    const originalKey = `uploads/${purgeAccountId}/${uuidv7()}/original`;
    const normalizedKey = originalKey.replace(
      /\/original$/u,
      '/normalized.jpg',
    );
    const now = new Date();
    await pool.query(
      `insert into accounts
       (id, display_name, trial_started_at, trial_ends_at)
       values ($1, 'purge', $2, $3)`,
      [purgeAccountId, now, new Date(now.getTime() + 60_000)],
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

  it('revokes the access session on logout', async () => {
    await request(baseUrl)
      .post('/v1/auth/logout')
      .send({ refreshToken })
      .expect(204);
    await request(baseUrl)
      .post('/graphql')
      .set('authorization', `Bearer ${accessToken}`)
      .send({ query: '{ viewer { id } }' })
      .expect(200)
      .expect(({ text }) => {
        expect(text).toContain('UNAUTHENTICATED');
      });
  });
});
