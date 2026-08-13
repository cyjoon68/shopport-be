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

describe('Shopport API vertical flow', () => {
  let app: INestApplication;
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedTestContainer;
  let accessToken: string;
  let refreshToken: string;
  let conversationId: string;
  let baseUrl: string;

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
    process.env.DATABASE_URL = postgres.getConnectionUri();
    process.env.REDIS_URL = `redis://${redis.getHost()}:${String(redis.getMappedPort(6379))}`;
    process.env.JWT_SECRET = 'integration-test-secret-at-least-32-bytes';
    process.env.ALLOW_DEMO_AUTH = 'true';
    process.env.CATALOG_MODE = 'fake';
    const pool = new Pool({ connectionString: postgres.getConnectionUri() });
    await migrate(drizzle(pool), { migrationsFolder: './migrations' });
    await migrate(drizzle(pool), { migrationsFolder: './migrations' });
    await pool.end();
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
    await Promise.all([postgres.stop(), redis.stop()]);
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

    const runId = uuidv7();
    const chatResponse = await request(baseUrl)
      .post('/v1/ai/chat')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        threadId: conversationId,
        runId,
        messages: [{ id: uuidv7(), role: 'user', content: '텀블러' }],
        forwardedProps: {},
      })
      .expect(200);
    expect(chatResponse.text).toContain('TOOL_CALL_RESULT');
    expect(chatResponse.text).toContain('RUN_FINISHED');

    const replay = await request(baseUrl)
      .get(`/v1/ai/chat?runId=${runId}&offset=0-0`)
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

    await request(baseUrl)
      .post('/graphql')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        query:
          'query Conversation($id: UUID!) { conversation(id: $id) { id messages { role status parts { __typename ... on TextMessagePart { text } ... on ProductReferenceMessagePart { product { id } } } } } }',
        variables: { id: conversationId },
      })
      .expect(200)
      .expect(({ text }) => {
        expect(text).toContain('조건에 맞는 상품');
        expect(text).toContain(product.id);
      });
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
