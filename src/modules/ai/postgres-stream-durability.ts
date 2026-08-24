import type { StreamChunk, StreamDurability } from '@tanstack/ai';
import { EventType } from '@tanstack/ai';
import type { Pool } from 'pg';
import { z } from 'zod';

const durableChunkSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(EventType.RUN_STARTED),
    threadId: z.string(),
    runId: z.string(),
  }),
  z.object({
    type: z.literal(EventType.TOOL_CALL_START),
    toolCallId: z.string(),
    toolCallName: z.string(),
    toolName: z.string(),
    parentMessageId: z.string(),
  }),
  z.object({
    type: z.literal(EventType.TOOL_CALL_ARGS),
    toolCallId: z.string(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal(EventType.TOOL_CALL_END),
    toolCallId: z.string(),
  }),
  z.object({
    type: z.literal(EventType.TOOL_CALL_RESULT),
    messageId: z.string(),
    toolCallId: z.string(),
    content: z.string(),
    role: z.literal('tool'),
  }),
  z.object({
    type: z.literal(EventType.TEXT_MESSAGE_START),
    messageId: z.string(),
    role: z.literal('assistant'),
  }),
  z.object({
    type: z.literal(EventType.TEXT_MESSAGE_CONTENT),
    messageId: z.string(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal(EventType.TEXT_MESSAGE_END),
    messageId: z.string(),
  }),
  z.object({
    type: z.literal(EventType.RUN_FINISHED),
    threadId: z.string(),
    runId: z.string(),
    outcome: z.object({ type: z.literal('success') }),
    finishReason: z.literal('stop'),
  }),
  z.object({
    type: z.literal(EventType.RUN_ERROR),
    message: z.string(),
    code: z.string().default('AI_PROVIDER_ERROR'),
  }),
]);

const eventRowSchema = z.object({
  id: z.string(),
  chunk: durableChunkSchema,
});

type DurableEntry = Readonly<{ offset: string; chunk: StreamChunk }>;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const offsetFor = (offset: string): bigint | null => {
  if (offset === '-1') return 0n;
  return /^\d{1,20}$/u.test(offset) ? BigInt(offset) : null;
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

  public read = (offset: string): AsyncIterable<DurableEntry> => {
    let cursor = offsetFor(offset);
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<DurableEntry>> => {
          if (cursor === null) return { done: true, value: undefined };
          for (;;) {
            const events = await this.pool.query<{
              id: string;
              chunk: unknown;
            }>(
              `select id::text, chunk
               from ai_run_events
               where run_id = $1 and id > $2 and expires_at > now()
               order by id
               limit 1`,
              [this.runId, cursor.toString()],
            );
            const event = events.rows.at(0);
            if (event) {
              const parsed = eventRowSchema.parse(event);
              cursor = BigInt(parsed.id);
              return {
                done: false,
                value: { offset: parsed.id, chunk: parsed.chunk },
              };
            }
            const run = await this.pool.query<{
              stream_closed_at: Date | null;
            }>('select stream_closed_at from ai_runs where id = $1', [
              this.runId,
            ]);
            if (!run.rows.at(0) || run.rows.at(0)?.stream_closed_at) {
              return { done: true, value: undefined };
            }
            await delay(250);
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
