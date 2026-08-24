import { describe, expect, it, jest } from '@jest/globals';
import type { Pool } from 'pg';

import { PostgresThrottlerStorage } from './postgres-throttler.storage.js';

describe('PostgresThrottlerStorage', () => {
  it('maps an active database block to the throttler contract', async () => {
    const query = jest
      .fn<
        (text: string, values?: Array<unknown>) => Promise<{ rows: unknown[] }>
      >()
      .mockResolvedValue({
        rows: [{ hits: 3, time_to_expire: 900, time_to_block_expire: 800 }],
      });
    const storage = new PostgresThrottlerStorage({
      query,
    } as unknown as Pool);

    await expect(
      storage.increment('client', 1_000, 2, 1_000, 'default'),
    ).resolves.toEqual({
      totalHits: 3,
      timeToExpire: 900,
      isBlocked: true,
      timeToBlockExpire: 800,
    });
  });
});
