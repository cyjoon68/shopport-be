import type { StreamChunk, StreamDurability } from '@tanstack/ai';
import { EventType } from '@tanstack/ai';
import type { Pool } from 'pg';
import { z } from 'zod';

const eventTypes = new Set<string>(Object.values(EventType));

const isStreamChunk = (value: unknown): value is StreamChunk =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  'type' in value &&
  typeof value.type === 'string' &&
  eventTypes.has(value.type);

const eventRowSchema = z.object({
  id: z.string(),
  chunk: z.custom<StreamChunk>(isStreamChunk),
});

type DurableEntry = Readonly<{ offset: string; chunk: StreamChunk }>;
type EventRow = Readonly<{ id: string; chunk: unknown }>;

const readPageSize = 128;
const maximumSignedBigint = 9_223_372_036_854_775_807n;

const delay = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timeout = setTimeout(done, milliseconds);
    signal?.addEventListener('abort', done, { once: true });
  });

const offsetFor = (offset: string, internal: boolean): bigint | null => {
  if (offset === '-1' && internal) return 0n;
  const parsed = /^\d{1,19}$/u.test(offset) ? BigInt(offset) : null;
  return parsed !== null && parsed <= maximumSignedBigint ? parsed : null;
};

export class PostgresStreamDurability implements StreamDurability {
  public constructor(
    private readonly pool: Pool,
    private readonly runId: string,
    private readonly resumeOffset: string | null,
  ) {}

  public resumeFrom = (): string | null => this.resumeOffset;

  public append = async (
    chunks: Array<StreamChunk>,
  ): Promise<Array<string>> => {
    if (chunks.length === 0) return [];
    const result = await this.pool.query<{ id: string }>(
      `insert into ai_run_events (run_id, chunk)
       select $1, chunk
       from jsonb_array_elements($2::jsonb) as chunk
       returning id::text`,
      [this.runId, JSON.stringify(chunks)],
    );
    return result.rows.map(({ id }) => id);
  };

  public read = (
    offset: string,
    signal?: AbortSignal,
  ): AsyncIterable<DurableEntry> => {
    let cursor = offsetFor(offset, this.resumeOffset === null);
    let buffered: Array<DurableEntry> = [];
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<DurableEntry>> => {
          if (cursor === null || signal?.aborted)
            return { done: true, value: undefined };
          for (;;) {
            const entry = buffered.shift();
            if (entry) {
              cursor = BigInt(entry.offset);
              return { done: false, value: entry };
            }
            const events = await this.pool.query<EventRow>(
              `select id::text, chunk
               from ai_run_events
               where run_id = $1 and id > $2 and expires_at > now()
               order by id
               limit $3`,
              [this.runId, cursor.toString(), readPageSize],
            );
            if (signal?.aborted) return { done: true, value: undefined };
            buffered = events.rows.map((event) => {
              const parsed = eventRowSchema.parse(event);
              return { offset: parsed.id, chunk: parsed.chunk };
            });
            if (buffered.length > 0) continue;
            const run = await this.pool.query<{
              stream_closed_at: Date | null;
            }>('select stream_closed_at from ai_runs where id = $1', [
              this.runId,
            ]);
            if (!run.rows.at(0) || run.rows.at(0)?.stream_closed_at) {
              return { done: true, value: undefined };
            }
            await delay(250, signal);
            if (signal?.aborted) return { done: true, value: undefined };
          }
        },
      }),
    };
  };

  public close = async (): Promise<void> => {
    await this.pool.query(
      'update ai_runs set stream_closed_at = now() where id = $1',
      [this.runId],
    );
  };

  public snapshot = async (): Promise<Array<DurableEntry>> => {
    const result = await this.pool.query<{ id: string; chunk: unknown }>(
      `select id::text, chunk
       from ai_run_events
       where run_id = $1 and expires_at > now()
       order by id`,
      [this.runId],
    );
    return result.rows.map((row) => {
      const parsed = eventRowSchema.parse(row);
      return { offset: parsed.id, chunk: parsed.chunk };
    });
  };
}
