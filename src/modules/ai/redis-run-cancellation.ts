import { Inject, Injectable } from '@nestjs/common';
import { REDIS } from '../../redis/redis.module.js';
import type { RedisClient } from '../../redis/redis.module.js';

const cancellationChannel = 'shopport:ai:cancel';
const cancellationTtlSeconds = 60 * 60;

@Injectable()
export class RedisRunCancellation {
  public constructor(@Inject(REDIS) private readonly redis: RedisClient) {}

  public mark = async (runId: string): Promise<void> => {
    const key = this.key(runId);
    await this.redis
      .multi()
      .set(key, '1', { EX: cancellationTtlSeconds })
      .publish(cancellationChannel, runId)
      .exec();
  };

  public isCancelled = async (runId: string): Promise<boolean> =>
    (await this.redis.exists(this.key(runId))) === 1;

  private readonly key = (runId: string): string =>
    `shopport:ai:run:${runId}:cancelled`;
}
