import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { LoggerModule } from 'nestjs-pino';

import type { Environment } from './config/environment.js';
import { validateEnvironment } from './config/environment.js';
import { DatabaseModule } from './database/database.module.js';
import { formatGraphqlError } from './graphql/error-formatter.js';
import { PersistedOperationsMiddleware } from './graphql/persisted-operations.middleware.js';
import { queryLimitRule } from './graphql/query-limits.js';
import {
  bigIntScalar,
  dateTimeScalar,
  urlScalar,
  uuidScalar,
} from './graphql/scalars.js';
import { HealthModule } from './health/health.module.js';
import { AiModule } from './modules/ai/ai.module.js';
import { AssetsModule } from './modules/assets/assets.module.js';
import { AuthGuard } from './modules/auth/auth.guard.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { ConversationModule } from './modules/conversations/conversation.module.js';
import { FavoritesModule } from './modules/favorites/favorites.module.js';
import { ProfileModule } from './modules/profile/profile.module.js';
import type { RedisClient } from './redis/redis.module.js';
import { REDIS, RedisModule } from './redis/redis.module.js';
import { RedisThrottlerStorage } from './redis/redis-throttler.storage.js';
import { ShopportThrottlerGuard } from './redis/shopport-throttler.guard.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) => ({
        pinoHttp: {
          level:
            config.get('APP_ENV', { infer: true }) === 'prod'
              ? 'info'
              : 'debug',
          autoLogging: false,
          redact: {
            paths: [
              'req.headers.authorization',
              'req.body',
              'res.headers.set-cookie',
            ],
            censor: '[Redacted]',
          },
        },
      }),
    }),
    DatabaseModule,
    RedisModule,
    ThrottlerModule.forRootAsync({
      imports: [RedisModule],
      inject: [REDIS],
      useFactory: (redis: RedisClient) => ({
        storage: new RedisThrottlerStorage(redis),
        throttlers: [
          { name: 'default', ttl: 60_000, limit: 120, blockDuration: 60_000 },
        ],
      }),
    }),
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<Environment, true>,
      ): ApolloDriverConfig => {
        const production = config.get('APP_ENV', { infer: true }) === 'prod';
        return {
          driver: ApolloDriver,
          typePaths: ['./schema.graphql'],
          introspection: !production,
          includeStacktraceInErrorResponses: !production,
          context: ({ req, res }: { req: Request; res: Response }) => ({
            req,
            res,
          }),
          validationRules: [queryLimitRule(9, 30_000)],
          formatError: formatGraphqlError,
          resolvers: {
            BigInt: bigIntScalar,
            DateTime: dateTimeScalar,
            URL: urlScalar,
            UUID: uuidScalar,
          },
        };
      },
    }),
    AuthModule,
    CatalogModule,
    ConversationModule,
    FavoritesModule,
    ProfileModule,
    AssetsModule,
    AiModule,
    HealthModule,
  ],
  providers: [
    PersistedOperationsMiddleware,
    { provide: APP_GUARD, useClass: ShopportThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(PersistedOperationsMiddleware)
      .forRoutes({ path: 'graphql', method: RequestMethod.ALL });
  }
}
