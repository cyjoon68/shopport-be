import { Inject, Injectable } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { z } from 'zod';

import type { RedisClient } from './redis.module.js';
import { REDIS } from './redis.module.js';

const resultSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const incrementScript = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
local blocked = redis.call('EXISTS', KEYS[2])
if hits > tonumber(ARGV[2]) and blocked == 0 then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  blocked = 1
end
local blockTtl = blocked == 1 and redis.call('PTTL', KEYS[2]) or 0
return { hits, ttl, blocked, blockTtl }
`;

type ThrottleRecord = Readonly<{
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}>;

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  public constructor(@Inject(REDIS) private readonly redis: RedisClient) {}

  public async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottleRecord> {
    const result = resultSchema.parse(
      await this.redis.eval(incrementScript, {
        keys: [
          `shopport:rate:${throttlerName}:${key}`,
          `shopport:rate-block:${throttlerName}:${key}`,
        ],
        arguments: [String(ttl), String(limit), String(blockDuration || ttl)],
      }),
    );
    return {
      totalHits: result[0],
      timeToExpire: result[1],
      isBlocked: result[2] === 1,
      timeToBlockExpire: result[3],
    };
  }
}
