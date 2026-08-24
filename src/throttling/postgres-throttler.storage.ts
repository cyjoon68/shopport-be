import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Pool } from 'pg';
import { z } from 'zod';

const resultSchema = z.object({
  hits: z.number().int(),
  time_to_expire: z.number(),
  time_to_block_expire: z.number(),
});

type ThrottleRecord = Readonly<{
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}>;

export class PostgresThrottlerStorage implements ThrottlerStorage {
  public constructor(private readonly pool: Pool) {}

  public async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottleRecord> {
    const result = await this.pool.query(
      `with updated as (
        insert into rate_limits as current (
          key, hits, window_expires_at, blocked_until, updated_at
        ) values (
          $1,
          1,
          clock_timestamp() + $2::double precision * interval '1 millisecond',
          case when 1 > $3 then clock_timestamp() + $4::double precision * interval '1 millisecond' end,
          clock_timestamp()
        )
        on conflict (key) do update set
          hits = case
            when current.window_expires_at <= clock_timestamp() then 1
            else current.hits + 1
          end,
          window_expires_at = case
            when current.window_expires_at <= clock_timestamp()
              then clock_timestamp() + $2::double precision * interval '1 millisecond'
            else current.window_expires_at
          end,
          blocked_until = case
            when current.blocked_until > clock_timestamp() then current.blocked_until
            when (
              case
                when current.window_expires_at <= clock_timestamp() then 1
                else current.hits + 1
              end
            ) > $3
              then clock_timestamp() + $4::double precision * interval '1 millisecond'
            else null
          end,
          updated_at = clock_timestamp()
        returning hits, window_expires_at, blocked_until
      )
      select
        hits,
        greatest(0, extract(epoch from (window_expires_at - clock_timestamp())) * 1000)::double precision as time_to_expire,
        greatest(0, extract(epoch from (blocked_until - clock_timestamp())) * 1000)::double precision as time_to_block_expire
      from updated`,
      [
        `shopport:rate:${throttlerName}:${key}`,
        ttl,
        limit,
        blockDuration || ttl,
      ],
    );
    const row = resultSchema.parse(result.rows.at(0));
    return {
      totalHits: row.hits,
      timeToExpire: row.time_to_expire,
      isBlocked: row.time_to_block_expire > 0,
      timeToBlockExpire: row.time_to_block_expire,
    };
  }
}
