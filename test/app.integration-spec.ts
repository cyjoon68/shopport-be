import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
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
    pool = new Pool({ connectionString: postgres.getConnectionUri() });
    await migrate(drizzle(pool), { migrationsFolder: './migrations' });
    await migrate(drizzle(pool), { migrationsFolder: './migrations' });
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
