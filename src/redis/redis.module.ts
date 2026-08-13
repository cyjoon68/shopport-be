import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import type { Environment } from '../config/environment.js';

export const REDIS = Symbol('REDIS');
export type RedisClient = RedisClientType;

const redisProvider = {
  provide: REDIS,
  inject: [ConfigService],
  useFactory: async (
    config: ConfigService<Environment, true>,
  ): Promise<RedisClient> => {
    const logger = new Logger('Redis');
    const client = createClient({
      url: config.get('REDIS_URL', { infer: true }),
    });
    client.on('error', (error: Error) => {
      logger.error(error.message);
    });
    await client.connect();
    return client;
  },
};

@Injectable()
class RedisLifecycle implements OnApplicationShutdown {
  public constructor(@Inject(REDIS) private readonly redis: RedisClient) {}

  public async onApplicationShutdown(): Promise<void> {
    if (this.redis.isOpen) await this.redis.close();
  }
}

@Global()
@Module({
  providers: [redisProvider, RedisLifecycle],
  exports: [REDIS],
})
export class RedisModule {}
