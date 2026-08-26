import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { EventType, type StreamChunk } from '@tanstack/ai';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import request from 'supertest';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import { decodePageCursor } from '../src/common/cursor.js';
import { DATABASE, DATABASE_POOL } from '../src/database/database.module.js';
import type {
  AiStreamAdapter,
  AiStreamInput,
  AiStreamLifecycle,
} from '../src/modules/ai/ai-stream.adapter.js';
import { AI_STREAM_ADAPTER } from '../src/modules/ai/ai-stream.adapter.js';
import type { AiToolSession } from '../src/modules/ai/ai-tools.js';
import { ArchiveReader } from '../src/modules/archive/archive.reader.js';
import { ArchiveWriter } from '../src/modules/archive/archive.writer.js';
import type {
  AuthProvider,
  VerifiedIdentity,
} from '../src/modules/auth/auth.types.js';
import { ProviderTokenVerifier } from '../src/modules/auth/provider-token-verifier.js';
import { CATALOG_PROVIDER } from '../src/modules/catalog/catalog.tokens.js';
import type {
  CatalogProduct,
  CatalogProvider,
} from '../src/modules/catalog/types.js';
import { ObjectStore } from '../src/storage/object-store.js';
import type { StorageBucket } from '../src/storage/storage-buckets.js';
import { OutboxProcessor } from '../src/worker/outbox.processor.js';
import { OutboxWakeup } from '../src/worker/outbox-wakeup.js';
import { RetentionCleanup } from '../src/worker/retention-cleanup.js';
import { StaleRunRecovery } from '../src/worker/stale-run-recovery.js';

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

const integrationProduct: CatalogProduct = {
  id: '0198a122-0c00-7000-8000-000000000099',
  providerId: 'daiso',
  productCode: 'integration-tumbler',
  title: '통합 테스트 텀블러',
  imageUrl: 'https://images.example.com/tumbler.jpg',
  affiliate: false,
  relevanceBucket: 2,
  inStock: true,
  totalAmountMinor: '5000',
  deliveryEstimateDays: 1,
  ratingConfidence: 1,
  freshnessEpochMs: Date.UTC(2026, 7, 24),
  outboundUrl: 'https://www.daisomall.co.kr/ds/prd/detail?pdNo=integration',
  store: null,
  inventory: null,
  evidence: [{ operation: 'products', fetchedAt: Date.UTC(2026, 7, 24) }],
};

const integrationCatalogProvider: CatalogProvider = {
  providerId: 'integration',
  capabilities: ['LIVE_QUERY'],
  outboundHosts: ['www.daisomall.co.kr'],
  search: ({ after }) => {
    decodePageCursor(after ?? null);
    return Promise.resolve({
      items: [integrationProduct],
      endCursor: null,
      hasNextPage: false,
    });
  },
};

const createIntegrationStream = async function* (
  input: AiStreamInput,
  tools: AiToolSession,
  lifecycle: AiStreamLifecycle,
): AsyncGenerator<StreamChunk> {
  const search = await tools.searchProducts({
    query: input.text,
    providerId: 'daiso',
  });
  const messageId = uuidv7();
  const text = '조건에 맞는 상품을 찾았어요.';
  yield {
    type: EventType.RUN_STARTED,
    threadId: input.threadId,
    runId: input.runId,
  };
  yield {
    type: EventType.TOOL_CALL_RESULT,
    messageId,
    toolCallId: 'integration-search',
    content: JSON.stringify({ rankingPolicy: 'neutral-v1' }),
  };
  yield { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' };
  yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text };
  yield { type: EventType.TEXT_MESSAGE_END, messageId };
  await lifecycle.onComplete({
    messageId,
    text,
    productRecommendations: search.items.slice(0, 1).map(({ id }) => ({
      productId: id,
      aiSummary: '통합 테스트 추천 상품',
    })),
    askUser: null,
  });
  yield {
    type: EventType.RUN_FINISHED,
    threadId: input.threadId,
    runId: input.runId,
    outcome: { type: 'success' },
  };
};

const integrationAiStream: AiStreamAdapter = {
  requiresImageData: false,
  generateTitle: () => Promise.resolve('통합 테스트 대화'),
  createStream: createIntegrationStream,
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

const integrationIdentityToken = 'integration-kakao-token';
const integrationSubject = 'integration-kakao';
const secondIntegrationSubject = 'integration-kakao-second';
const deletionPendingIntegrationSubject = 'integration-kakao-deletion-pending';

type AuthBarrierWait = Readonly<{
  clear: () => void;
  promise: Promise<void>;
}>;

describe('Shopport API vertical flow', () => {
  let app: INestApplication;
  let postgres: StartedPostgreSqlContainer;
  let accessToken: string;
  let conversationId: string;
  let completedRunId: string;
  let baseUrl: string;
  let pool: Pool;
  let appPool: Pool;
  let resolveAuthBarrier: ((message: string) => void) | undefined;
  let workerModule: TestingModule;
  let staleRunRecovery: StaleRunRecovery;
  let archiveWriter: ArchiveWriter;
  let archiveReader: ArchiveReader;
  let outboxProcessor: OutboxProcessor;
  let outboxWakeup: OutboxWakeup;
  let retentionCleanup: RetentionCleanup;
  let postgresStarted = false;
  let poolInitialized = false;
  let workerModuleInitialized = false;
  let appInitialized = false;

  const waitForAuthBarrier = (
    expectedMessage: string,
    timeoutMilliseconds = 5_000,
  ): AuthBarrierWait => {
    let clear = (): void => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        clear();
        reject(new Error(`Timed out waiting for ${expectedMessage}`));
      }, timeoutMilliseconds);
      clear = (): void => {
        clearTimeout(timeout);
        resolveAuthBarrier = undefined;
      };
      resolveAuthBarrier = (message): void => {
        if (message !== expectedMessage) return;
        clear();
        resolve();
      };
    });
    return { clear, promise };
  };

  const createAiOwner = async (): Promise<
    Readonly<{
      accessToken: string;
      accountId: string;
      conversationId: string;
    }>
  > => {
    const loginResponse = await request(baseUrl)
      .post('/v1/auth/kakao')
      .send({
        identityToken: integrationIdentityToken,
        nonce: 'task-five-owner',
      })
      .expect(200);
    const ownerAccessToken = loginSchema.parse(loginResponse.body).accessToken;
    const conversationResponse = await request(baseUrl)
      .post('/graphql')
      .set('authorization', `Bearer ${ownerAccessToken}`)
      .send({
        query:
          'mutation Create($input: CreateConversationInput!) { createConversation(input: $input) { conversation { id } userErrors { code } } }',
        variables: { input: { title: 'AI 실행 복구' } },
      })
      .expect(200);
    const ownerConversationId = conversationSchema.parse(
      conversationResponse.body,
    ).data.createConversation.conversation.id;
    const account = await pool.query<{ account_id: string }>(
      `select account_id
       from auth_identities
       where provider = 'kakao' and provider_subject = '${integrationSubject}'`,
    );
    const accountId = account.rows.at(0)?.account_id;
    if (!accountId) throw new Error('Expected Kakao account');
    return {
      accessToken: ownerAccessToken,
      accountId,
      conversationId: ownerConversationId,
    };
  };

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
    postgresStarted = true;
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'dev';
    process.env.DATABASE_URL = postgres.getConnectionUri();
    process.env.JWT_SECRET = 'integration-test-secret-at-least-32-bytes';
    process.env.PROVIDER_API_KEY = 'integration-provider-key';
    process.env.PERSISTED_OPERATION_MANIFEST = '';
    process.env.AWS_ENDPOINT_URL = 'http://localhost:4566';
    process.env.RAW_ASSET_BUCKET = 'integration-raw';
    process.env.NORMALIZED_ASSET_BUCKET = 'integration-normalized';
    process.env.ARCHIVE_BUCKET = 'integration-archive';
    pool = new Pool({ connectionString: postgres.getConnectionUri() });
    appPool = new Pool({ connectionString: postgres.getConnectionUri() });
    appPool.on('connect', (client) => {
      client.on('notice', ({ message }) => {
        if (message) resolveAuthBarrier?.(message);
      });
    });
    poolInitialized = true;
    await migrate(drizzle(pool), { migrationsFolder: './migrations' });
    await migrate(drizzle(pool), { migrationsFolder: './migrations' });
    const { WorkerModule } = await import('../src/worker/worker.module.js');
    workerModule = await Test.createTestingModule({
      imports: [WorkerModule],
    })
      .overrideProvider(ObjectStore)
      .useValue(objectStore)
      .compile();
    workerModuleInitialized = true;
    staleRunRecovery = workerModule.get(StaleRunRecovery);
    archiveWriter = workerModule.get(ArchiveWriter);
    archiveReader = workerModule.get(ArchiveReader);
    outboxProcessor = workerModule.get(OutboxProcessor);
    outboxWakeup = workerModule.get(OutboxWakeup);
    retentionCleanup = workerModule.get(RetentionCleanup);
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DATABASE_POOL)
      .useValue(appPool)
      .overrideProvider(ProviderTokenVerifier)
      .useValue({
        verify: (
          provider: AuthProvider,
          _idToken: string,
          nonce: string,
        ): Promise<VerifiedIdentity> =>
          Promise.resolve({
            provider,
            subject:
              nonce === 'second-account'
                ? secondIntegrationSubject
                : nonce === 'deletion-pending identity'
                  ? deletionPendingIntegrationSubject
                  : integrationSubject,
            displayName: '통합 테스트 사용자',
            profileImageUrl: null,
          }),
      })
      .overrideProvider(CATALOG_PROVIDER)
      .useValue(integrationCatalogProvider)
      .overrideProvider(AI_STREAM_ADAPTER)
      .useValue(integrationAiStream)
      .compile();
    app = module.createNestApplication();
    appInitialized = true;
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  }, 120_000);

  afterAll(async () => {
    if (appInitialized) await app.close();
    if (workerModuleInitialized) await workerModule.close();
    if (poolInitialized) await pool.end();
    if (postgresStarted) await postgres.stop();
  });

  it('applies additive migrations idempotently', async () => {
    const columns = await pool.query<{ column_name: string }>(
      `select column_name
       from information_schema.columns
       where table_name = 'ai_runs'
         and column_name in ('deadline_at', 'heartbeat_at', 'stream_closed_at')`,
    );
    const constraint = await pool.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition
       from pg_constraint
       where conname = 'ai_runs_status_check'`,
    );
    const [extension, outboxColumns, statementStatistics] = await Promise.all([
      pool.query<{ extname: string }>(
        "select extname from pg_extension where extname = 'pg_stat_statements'",
      ),
      pool.query<{ column_name: string }>(
        `select column_name
           from information_schema.columns
           where table_name = 'outbox'
             and column_name in ('locked_by', 'locked_until')`,
      ),
      pool.query<{ count: string }>(
        'select count(*)::text as count from pg_stat_statements',
      ),
    ]);

    expect(columns.rows).toHaveLength(3);
    expect(constraint.rows.at(0)?.definition).toContain('cancelled');
    expect(extension.rows).toHaveLength(1);
    expect(outboxColumns.rows).toHaveLength(2);
    expect(statementStatistics.rows).toHaveLength(1);
  });

  it('creates one identity and account under concurrent first login', async () => {
    const responses = await Promise.all([
      request(baseUrl).post('/v1/auth/kakao').send({
        identityToken: integrationIdentityToken,
        nonce: 'concurrent-login-a',
      }),
      request(baseUrl).post('/v1/auth/kakao').send({
        identityToken: integrationIdentityToken,
        nonce: 'concurrent-login-b',
      }),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    const result = await pool.query<{ count: string; display_name: string }>(
      `select count(*) over () as count, a.display_name
       from auth_identities i
       join accounts a on a.id = i.account_id
       where i.provider = 'kakao' and i.provider_subject = '${integrationSubject}'`,
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows.at(0)).toMatchObject({
      count: '1',
      display_name: '통합 테스트 사용자',
    });
  });

  it('rejects a deletion-pending identity without creating a duplicate', async () => {
    await request(baseUrl)
      .post('/v1/auth/kakao')
      .send({
        identityToken: integrationIdentityToken,
        nonce: 'deletion-pending identity',
      })
      .expect(200);
    const accountCountBefore = await pool.query<{ count: string }>(
      'select count(*)::text as count from accounts',
    );
    const account = await pool.query<{ account_id: string }>(
      `select account_id
       from auth_identities
       where provider = 'kakao' and provider_subject = $1`,
      [deletionPendingIntegrationSubject],
    );
    const accountId = account.rows.at(0)?.account_id;
    if (!accountId) throw new Error('Expected deletion-pending account');
    await pool.query('update accounts set deleted_at = now() where id = $1', [
      accountId,
    ]);

    await request(baseUrl)
      .post('/v1/auth/kakao')
      .send({
        identityToken: integrationIdentityToken,
        nonce: 'deletion-pending identity',
      })
      .expect(409);

    const identities = await pool.query<{ account_id: string }>(
      `select account_id
       from auth_identities
       where provider = 'kakao' and provider_subject = $1`,
      [deletionPendingIntegrationSubject],
    );
    const accountCountAfter = await pool.query<{ count: string }>(
      'select count(*)::text as count from accounts',
    );
    expect(identities.rows).toEqual([{ account_id: accountId }]);
    expect(accountCountAfter.rows.at(0)?.count).toBe(
      accountCountBefore.rows.at(0)?.count,
    );
  });

  it('rejects a malformed access token without exposing JWT errors', async () => {
    const httpResponse = await request(baseUrl)
      .post('/v1/ai/chat')
      .set('authorization', 'Bearer not-a-jwt')
      .send({})
      .expect(401);
    expect(
      z.object({ message: z.string() }).parse(httpResponse.body).message,
    ).toBe('Invalid access token');

    const response = await request(baseUrl)
      .post('/graphql')
      .set('authorization', 'Bearer not-a-jwt')
      .send({ query: '{ viewer { id } }' })
      .expect(200);

    const graphqlResponse = z
      .object({
        errors: z.array(
          z.object({
            message: z.string(),
            extensions: z.object({ code: z.string() }),
          }),
        ),
      })
      .parse(response.body);
    const graphqlError = graphqlResponse.errors.at(0);
    expect(graphqlError).toBeDefined();
    if (!graphqlError) throw new Error('Expected GraphQL authentication error');
    expect(graphqlError.message).toBe('Invalid access token');
    expect(graphqlError.extensions.code).toBe('UNAUTHENTICATED');
    expect(response.text).not.toContain('jwt malformed');
  });

  it('logs in, chats, replays, saves a product, and reads history', async () => {
    const loginResponse = await request(baseUrl)
      .post('/v1/auth/kakao')
      .send({
        identityToken: integrationIdentityToken,
        nonce: 'integration-nonce',
      })
      .expect(200);
    const login = loginSchema.parse(loginResponse.body);
    accessToken = login.accessToken;

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
    await request(baseUrl)
      .post('/v1/ai/chat')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        threadId: conversationId,
        runId: uuidv7(),
        messages: [{ id: uuidv4(), role: 'user', content: '거부 대상' }],
        forwardedProps: {},
      })
      .expect(400);
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
      .get(`/v1/ai/chat?runId=${completedRunId}&offset=0`)
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200);
    const replayChunks = parseStreamChunks(replay.text);
    expect(replayChunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: EventType.CUSTOM }),
      ]),
    );
    expect(replayChunks.some(({ type }) => type === 'RUN_ERROR')).toBe(false);
    expect(replayChunks.at(-1)?.type).toBe('RUN_FINISHED');

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
    if (!product) throw new Error('Expected catalog product');

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

  it('surfaces invalid cursors as GraphQL validation errors', async () => {
    const loginResponse = await request(baseUrl)
      .post('/v1/auth/kakao')
      .send({
        identityToken: integrationIdentityToken,
        nonce: 'invalid-cursor-nonce',
      })
      .expect(200);
    const invalidCursorAccessToken = loginSchema.parse(
      loginResponse.body,
    ).accessToken;

    for (const query of [
      '{ conversations(first: 1, after: "MA") { edges { cursor } } }',
      '{ savedProducts(first: 1, after: "MA") { edges { cursor } } }',
      '{ searchProducts(input: { query: "텀블러" }, first: 1, after: "MA") { edges { cursor } } }',
    ]) {
      const response = await request(baseUrl)
        .post('/graphql')
        .set('authorization', `Bearer ${invalidCursorAccessToken}`)
        .send({ query })
        .expect(200);
      const result = z
        .object({
          errors: z.array(
            z.object({
              message: z.string(),
              extensions: z.object({ code: z.string() }),
            }),
          ),
        })
        .parse(response.body);

      const error = result.errors.at(0);
      expect(error).toBeDefined();
      if (!error) throw new Error('Expected GraphQL validation error');
      expect(error.message).toBe('Invalid cursor');
      expect(error.extensions.code).toBe('VALIDATION_FAILED');
    }
  });

  it('hides cross-account replay and cancel, then cancels idempotently', async () => {
    const secondLoginResponse = await request(baseUrl)
      .post('/v1/auth/kakao')
      .send({
        identityToken: integrationIdentityToken,
        nonce: 'second-account',
      })
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
       where provider = 'kakao' and provider_subject = '${integrationSubject}'`,
    );
    const accountId = account.rows.at(0)?.account_id;
    if (!accountId) throw new Error('Expected Kakao account');
    const reservedRunId = uuidv7();
    const now = new Date();
    await pool.query(
      `insert into ai_runs
       (id, account_id, conversation_id, status, started_at, deadline_at, heartbeat_at)
       values ($1, $2, $3, 'reserved', $4, $5, $4)`,
      [
        reservedRunId,
        accountId,
        conversationId,
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
      assistant_count: number;
    }>(
      `select r.status,
              count(m.id) filter (where m.role = 'assistant')::int as assistant_count
       from ai_runs r
       left join messages m on m.run_id = r.id
       where r.id = $1
       group by r.status`,
      [reservedRunId],
    );

    expect(cancelled.rows.at(0)).toEqual({
      status: 'cancelled',
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
         and identity.provider_subject = '${secondIntegrationSubject}'`,
    );
    expect(successors.rows.at(0)?.count).toBe('1');
  }, 30_000);

  it('terminates producerless cancellation replay', async () => {
    const owner = await createAiOwner();
    const runId = uuidv7();
    const now = new Date();
    await pool.query(
      `insert into ai_runs
       (id, account_id, conversation_id, status, started_at, deadline_at, heartbeat_at)
       values ($1, $2, $3, 'reserved', $4, $5, $4)`,
      [
        runId,
        owner.accountId,
        owner.conversationId,
        now,
        new Date(now.getTime() + 60_000),
      ],
    );

    await request(baseUrl)
      .post('/v1/ai/chat/cancel')
      .set('authorization', `Bearer ${owner.accessToken}`)
      .send({ threadId: owner.conversationId, runId })
      .expect(204);
    const replay = await request(baseUrl)
      .get(`/v1/ai/chat?runId=${runId}&offset=0`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    const cancelled = await pool.query<{
      status: string;
      completed_at: Date | null;
      stream_closed_at: Date | null;
    }>(
      `select status, completed_at, stream_closed_at
       from ai_runs
       where id = $1`,
      [runId],
    );

    expect(replay.text.trim()).toBe('');
    expect(cancelled.rows.at(0)?.status).toBe('cancelled');
    expect(cancelled.rows.at(0)?.completed_at).toBeInstanceOf(Date);
    expect(cancelled.rows.at(0)?.stream_closed_at).toBeInstanceOf(Date);
  }, 30_000);

  it('recovers stale reserved runs once', async () => {
    const owner = await createAiOwner();
    const now = new Date();
    const overdue = new Date(now.getTime() - 180_000);
    const future = new Date(now.getTime() + 180_000);
    const staleRunId = uuidv7();
    const freshRunId = uuidv7();
    const completedRunId = uuidv7();
    const cancelledRunId = uuidv7();

    await pool.query(
      `insert into ai_runs
       (id, account_id, conversation_id, status, started_at, deadline_at,
        heartbeat_at, completed_at)
       values
       ($1, $5, $6, 'reserved', $7, $7, $7, null),
       ($2, $5, $6, 'reserved', $8, $8, $8, null),
       ($3, $5, $6, 'completed', $7, $7, $7, $8),
       ($4, $5, $6, 'cancelled', $7, $7, $7, $8)`,
      [
        staleRunId,
        freshRunId,
        completedRunId,
        cancelledRunId,
        owner.accountId,
        owner.conversationId,
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

    expect(statuses.get(staleRunId)).toBe('failed');
    expect(statuses.get(freshRunId)).toBe('reserved');
    expect(statuses.get(completedRunId)).toBe('completed');
    expect(statuses.get(cancelledRunId)).toBe('cancelled');
  }, 30_000);

  it('uses archive storage and purges each split bucket', async () => {
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
      objectStore as unknown as ObjectStore,
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

  it('rejects every token when refresh and logout contend in either lock order', async () => {
    const refreshWinnerLogin = loginSchema.parse(
      (
        await request(baseUrl).post('/v1/auth/kakao').send({
          identityToken: integrationIdentityToken,
          nonce: 'refresh-wins',
        })
      ).body,
    );
    const logoutWinnerLogin = loginSchema.parse(
      (
        await request(baseUrl).post('/v1/auth/kakao').send({
          identityToken: integrationIdentityToken,
          nonce: 'logout-wins',
        })
      ).body,
    );
    const unrelatedLogin = loginSchema.parse(
      (
        await request(baseUrl).post('/v1/auth/kakao').send({
          identityToken: integrationIdentityToken,
          nonce: 'second-account',
        })
      ).body,
    );
    const [refreshWinnerSessionId] = refreshWinnerLogin.refreshToken.split('.');
    const [logoutWinnerSessionId] = logoutWinnerLogin.refreshToken.split('.');
    const [unrelatedSessionId] = unrelatedLogin.refreshToken.split('.');
    if (
      !refreshWinnerSessionId ||
      !logoutWinnerSessionId ||
      !unrelatedSessionId
    ) {
      throw new Error('Expected refresh token session IDs');
    }
    const account = await pool.query<{ account_id: string }>(
      'select account_id from auth_sessions where id = $1',
      [refreshWinnerSessionId],
    );
    const accountId = account.rows.at(0)?.account_id;
    if (!accountId) throw new Error('Expected refresh winner account');

    const refreshWins = await (async (): Promise<
      Readonly<{
        logoutStatus: number;
        refreshStatus: number;
        tokens: z.infer<typeof loginSchema>;
      }>
    > => {
      const blocker = await pool.connect();
      let barrier: AuthBarrierWait | undefined;
      try {
        await pool.query(`
          create or replace function auth_session_refresh_barrier()
          returns trigger language plpgsql as $$
          begin
            raise notice 'refresh-lock-held';
            perform pg_advisory_xact_lock(73001);
            return new;
          end
          $$;
          create trigger auth_session_refresh_barrier
          before insert on auth_sessions
          for each row
          when (new.account_id = '${accountId}'::uuid)
          execute function auth_session_refresh_barrier()
        `);
        await blocker.query('select pg_advisory_lock(73001)');
        barrier = waitForAuthBarrier('refresh-lock-held');
        const refreshRequest = request(baseUrl)
          .post('/v1/auth/refresh')
          .send({ refreshToken: refreshWinnerLogin.refreshToken })
          .then((response) => response);
        await barrier.promise;
        const logoutRequest = request(baseUrl)
          .post('/v1/auth/logout')
          .send({ refreshToken: refreshWinnerLogin.refreshToken })
          .then((response) => response);
        await blocker.query('select pg_advisory_unlock(73001)');
        const [refreshResponse, logoutResponse] = await Promise.all([
          refreshRequest,
          logoutRequest,
        ]);
        return {
          logoutStatus: logoutResponse.status,
          refreshStatus: refreshResponse.status,
          tokens: loginSchema.parse(refreshResponse.body),
        };
      } finally {
        barrier?.clear();
        try {
          await blocker.query('select pg_advisory_unlock(73001)');
        } finally {
          blocker.release();
          await pool.query(`
            drop trigger if exists auth_session_refresh_barrier on auth_sessions;
            drop function if exists auth_session_refresh_barrier()
          `);
        }
      }
    })();

    const logoutWins = await (async (): Promise<
      Readonly<{ logoutStatus: number; refreshStatus: number }>
    > => {
      const blocker = await pool.connect();
      let barrier: AuthBarrierWait | undefined;
      try {
        await pool.query(`
          create or replace function auth_session_logout_barrier()
          returns trigger language plpgsql as $$
          begin
            raise notice 'logout-lock-held';
            perform pg_advisory_xact_lock(73002);
            return new;
          end
          $$;
          create trigger auth_session_logout_barrier
          before update on auth_sessions
          for each row
          when (
            old.id = '${logoutWinnerSessionId}'::uuid
            and old.revoked_at is null
            and new.revoked_at is not null
          )
          execute function auth_session_logout_barrier()
        `);
        await blocker.query('select pg_advisory_lock(73002)');
        barrier = waitForAuthBarrier('logout-lock-held');
        const logoutRequest = request(baseUrl)
          .post('/v1/auth/logout')
          .send({ refreshToken: logoutWinnerLogin.refreshToken })
          .then((response) => response);
        await barrier.promise;
        const refreshRequest = request(baseUrl)
          .post('/v1/auth/refresh')
          .send({ refreshToken: logoutWinnerLogin.refreshToken })
          .then((response) => response);
        await blocker.query('select pg_advisory_unlock(73002)');
        const [logoutResponse, refreshResponse] = await Promise.all([
          logoutRequest,
          refreshRequest,
        ]);
        return {
          logoutStatus: logoutResponse.status,
          refreshStatus: refreshResponse.status,
        };
      } finally {
        barrier?.clear();
        try {
          await blocker.query('select pg_advisory_unlock(73002)');
        } finally {
          blocker.release();
          await pool.query(`
            drop trigger if exists auth_session_logout_barrier on auth_sessions;
            drop function if exists auth_session_logout_barrier()
          `);
        }
      }
    })();

    expect(refreshWins.refreshStatus).toBe(200);
    expect(refreshWins.logoutStatus).toBe(204);
    expect(logoutWins.logoutStatus).toBe(204);
    expect(logoutWins.refreshStatus).toBe(401);

    const [refreshWinnerChildId] = refreshWins.tokens.refreshToken.split('.');
    if (!refreshWinnerChildId) {
      throw new Error('Expected refresh winner child session ID');
    }
    const racedSessions = await pool.query<{
      id: string;
      revoked_at: Date | null;
    }>(
      `select id, revoked_at
       from auth_sessions
       where id = any($1::uuid[])`,
      [
        [
          refreshWinnerSessionId,
          refreshWinnerChildId,
          logoutWinnerSessionId,
          unrelatedSessionId,
        ],
      ],
    );
    const racedSessionStates = new Map(
      racedSessions.rows.map(({ id, revoked_at }) => [id, revoked_at]),
    );
    expect(racedSessionStates.size).toBe(4);
    expect(racedSessionStates.get(refreshWinnerSessionId)).toBeInstanceOf(Date);
    expect(racedSessionStates.get(refreshWinnerChildId)).toBeInstanceOf(Date);
    expect(racedSessionStates.get(logoutWinnerSessionId)).toBeInstanceOf(Date);
    expect(racedSessionStates.get(unrelatedSessionId)).toBeNull();

    const rejectedAccessTokens = [
      refreshWinnerLogin.accessToken,
      refreshWins.tokens.accessToken,
      logoutWinnerLogin.accessToken,
    ];
    for (const token of rejectedAccessTokens) {
      await request(baseUrl)
        .post('/graphql')
        .set('authorization', `Bearer ${token}`)
        .send({ query: '{ viewer { id } }' })
        .expect(200)
        .expect(({ text }) => {
          expect(text).toContain('UNAUTHENTICATED');
        });
    }
    const rejectedRefreshTokens = [
      refreshWinnerLogin.refreshToken,
      refreshWins.tokens.refreshToken,
      logoutWinnerLogin.refreshToken,
    ];
    for (const token of rejectedRefreshTokens) {
      await request(baseUrl)
        .post('/v1/auth/refresh')
        .send({ refreshToken: token })
        .expect(401);
    }

    await request(baseUrl)
      .post('/graphql')
      .set('authorization', `Bearer ${unrelatedLogin.accessToken}`)
      .send({ query: '{ viewer { id } }' })
      .expect(200)
      .expect(({ text }) => {
        expect(text).not.toContain('UNAUTHENTICATED');
      });
  }, 30_000);

  it('bounds auth barrier notice waits', async () => {
    const barrier = waitForAuthBarrier('missing-notice', 0);

    await expect(barrier.promise).rejects.toThrow(
      'Timed out waiting for missing-notice',
    );
    expect(resolveAuthBarrier).toBeUndefined();
  });

  it('revokes the access session on logout', async () => {
    const logoutLogin = loginSchema.parse(
      (
        await request(baseUrl).post('/v1/auth/kakao').send({
          identityToken: integrationIdentityToken,
          nonce: 'logout-idempotency',
        })
      ).body,
    );
    const [sessionId, secret] = logoutLogin.refreshToken.split('.');
    if (!sessionId || !secret) throw new Error('Expected refresh token parts');
    const wrongSecret = `${secret.startsWith('A') ? 'B' : 'A'}${secret.slice(1)}`;

    await request(baseUrl)
      .post('/v1/auth/refresh')
      .send({ refreshToken: `not-a-uuid.${'A'.repeat(43)}` })
      .expect(401);
    await request(baseUrl)
      .post('/v1/auth/logout')
      .send({ refreshToken: `not-a-uuid.${'A'.repeat(43)}` })
      .expect(204);
    await request(baseUrl)
      .post('/v1/auth/logout')
      .send({ refreshToken: `${sessionId}.${wrongSecret}` })
      .expect(204);
    await request(baseUrl)
      .post('/graphql')
      .set('authorization', `Bearer ${logoutLogin.accessToken}`)
      .send({ query: '{ viewer { id } }' })
      .expect(200)
      .expect(({ text }) => {
        expect(text).not.toContain('UNAUTHENTICATED');
      });

    await request(baseUrl)
      .post('/v1/auth/logout')
      .send({ refreshToken: logoutLogin.refreshToken })
      .expect(204);
    await request(baseUrl)
      .post('/graphql')
      .set('authorization', `Bearer ${logoutLogin.accessToken}`)
      .send({ query: '{ viewer { id } }' })
      .expect(200)
      .expect(({ text }) => {
        expect(text).toContain('UNAUTHENTICATED');
      });
  });
});
