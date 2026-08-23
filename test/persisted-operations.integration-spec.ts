import { createHash } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import {
  Controller,
  HttpCode,
  MiddlewareConsumer,
  Module,
  NestModule,
  Post,
  RequestMethod,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { stripIgnoredCharacters } from 'graphql';
import request from 'supertest';

import type { Environment } from '../src/config/environment.js';
import { PersistedOperationsMiddleware } from '../src/graphql/persisted-operations.middleware.js';

const document = 'query Viewer { viewer { id } }';
const documentHash = createHash('sha256')
  .update(stripIgnoredCharacters(document))
  .digest('hex');

@Controller()
class GraphqlTestController {
  @Post('graphql')
  @HttpCode(200)
  public execute(): Readonly<{ data: { accepted: true } }> {
    return { data: { accepted: true } };
  }
}

@Module({
  controllers: [GraphqlTestController],
  providers: [
    PersistedOperationsMiddleware,
    {
      provide: ConfigService,
      useValue: new ConfigService<Environment, true>({
        APP_ENV: 'prod',
        PERSISTED_OPERATION_MANIFEST: JSON.stringify({
          [documentHash]: document,
        }),
      }),
    },
  ],
})
class PersistedOperationsTestModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(PersistedOperationsMiddleware)
      .forRoutes({ path: 'graphql', method: RequestMethod.POST });
  }
}

describe('persisted operations HTTP contract', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [PersistedOperationsTestModule],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts a standard manifest hash for its normalized document', async () => {
    await request(baseUrl)
      .post('/graphql')
      .set('x-shopport-operation-id', documentHash)
      .send({ query: '\n query Viewer { viewer { id } }\n' })
      .expect(200, { data: { accepted: true } });
  });

  it.each([
    ['a missing header', undefined, document],
    ['an unknown hash', 'a'.repeat(64), document],
    [
      'a tampered document',
      documentHash,
      'query Viewer { viewer { displayName } }',
    ],
  ])('rejects %s', async (_scenario, operationHash, query) => {
    const pending = request(baseUrl).post('/graphql').send({ query });
    if (operationHash) pending.set('x-shopport-operation-id', operationHash);

    await pending.expect(403, {
      code: 'FORBIDDEN',
      message: 'Persisted operation required',
    });
  });
});
