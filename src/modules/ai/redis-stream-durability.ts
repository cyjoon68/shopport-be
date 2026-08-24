import type { StreamChunk, StreamDurability } from '@tanstack/ai';
import { EventType } from '@tanstack/ai';
import { z } from 'zod';

import type { RedisClient } from '../../redis/redis.module.js';

const ttlSeconds = 60 * 60;

type DurableEntry = Readonly<{ offset: string; chunk: StreamChunk }>;

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

const streamReadSchema = z
  .array(
    z.object({
      name: z.string(),
      messages: z.array(
        z.object({
          id: z.string(),
          message: z.record(z.string(), z.string()),
        }),
      ),
    }),
  )
  .nullable();

const parseEntry = (entry: {
  id: string;
  message: Readonly<Record<string, string>>;
}): DurableEntry => {
  const serialized = entry.message.chunk;
  if (!serialized) throw new Error('Durability entry is missing chunk data');
  return {
    offset: entry.id,
    chunk: durableChunkSchema.parse(JSON.parse(serialized)),
  };
};

export class RedisStreamDurability implements StreamDurability {
  readonly #streamKey: string;
  readonly #completeKey: string;

  public constructor(
    private readonly redis: RedisClient,
    runId: string,
    private readonly resumeOffset: string | null,
  ) {
    this.#streamKey = `shopport:ai:run:${runId}`;
    this.#completeKey = `${this.#streamKey}:complete`;
  }

  public resumeFrom = (): string | null => this.resumeOffset;

  public append = async (
    chunks: Array<StreamChunk>,
  ): Promise<Array<string>> => {
    const offsets: Array<string> = [];
    for (const chunk of chunks) {
      const offset = await this.redis.xAdd(this.#streamKey, '*', {
        chunk: JSON.stringify(chunk),
      });
      offsets.push(offset);
    }
    await this.redis.expire(this.#streamKey, ttlSeconds);
    return offsets;
  };

  public read = (offset: string): AsyncIterable<DurableEntry> => {
    let cursor = offset === '-1' ? '0-0' : offset;
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<DurableEntry>> => {
          for (;;) {
            const rawStreams: unknown = await this.redis.xRead(
              { key: this.#streamKey, id: cursor },
              { COUNT: 1, BLOCK: 1_000 },
            );
            const streams = streamReadSchema.parse(rawStreams);
            const entry = streams?.at(0)?.messages.at(0);
            if (entry) {
              const parsed = parseEntry(entry);
              cursor = parsed.offset;
              return { done: false, value: parsed };
            }
            const [complete, stream] = await Promise.all([
              this.redis.exists(this.#completeKey),
              this.redis.exists(this.#streamKey),
            ]);
            if (complete || (cursor !== '0-0' && !stream)) {
              return { done: true, value: undefined };
            }
          }
        },
      }),
    };
  };

  public close = async (): Promise<void> => {
    await this.redis.set(this.#completeKey, '1', { EX: ttlSeconds });
    await this.redis.expire(this.#streamKey, ttlSeconds);
  };

  public snapshot = async (): Promise<Array<DurableEntry>> => {
    const entries = await this.redis.xRange(this.#streamKey, '-', '+');
    return entries.map(parseEntry);
  };
}
