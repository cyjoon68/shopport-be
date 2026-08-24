import { describe, expect, it, jest } from '@jest/globals';

import type { RedisClient } from '../../redis/redis.module.js';
import { RedisStreamDurability } from './redis-stream-durability.js';

describe('RedisStreamDurability replay expiry', () => {
  it('ends a resumed replay after both durability keys have expired', async () => {
    const xRead = jest
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('Expired stream was polled again'));
    const exists = jest
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    const durability = new RedisStreamDurability(
      { exists, xRead } as unknown as RedisClient,
      '0198a122-0c00-7000-8000-000000000001',
      '42-0',
    );
    const iterator = durability.read('42-0')[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(xRead).toHaveBeenCalledTimes(1);
  });
});
