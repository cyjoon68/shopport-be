import { EventType } from '@tanstack/ai';
import type { StreamChunk } from '@tanstack/ai';
import { v7 as uuidv7 } from 'uuid';
import type { ProductGraphql } from '../catalog/catalog.mapper.js';

type FakeStreamInput = Readonly<{
  threadId: string;
  runId: string;
  message: string;
  products: ReadonlyArray<ProductGraphql>;
}>;

const chunksFor = (input: FakeStreamInput): Array<StreamChunk> => {
  const messageId = uuidv7();
  const toolCallId = uuidv7();
  const productResult = JSON.stringify({
    kind: 'product_cards',
    rankingPolicy: 'neutral-v1',
    products: input.products,
  });
  const textChunks = input.message.match(/.{1,18}/gu) ?? [input.message];
  const textEvents = textChunks.map((delta): StreamChunk => ({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId,
    delta,
  }));
  return [
    {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    },
    {
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: 'searchProducts',
      toolName: 'searchProducts',
      parentMessageId: messageId,
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: JSON.stringify({ query: 'structured-request' }),
    },
    { type: EventType.TOOL_CALL_END, toolCallId },
    {
      type: EventType.TOOL_CALL_RESULT,
      messageId: uuidv7(),
      toolCallId,
      content: productResult,
      role: 'tool',
    },
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: 'assistant',
    },
    ...textEvents,
    { type: EventType.TEXT_MESSAGE_END, messageId },
    {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
      outcome: { type: 'success' },
      finishReason: 'stop',
    },
  ];
};

export const createFakeAiStream = (
  input: FakeStreamInput,
  onComplete: () => Promise<void>,
  onFailure: () => Promise<void>,
  isCancelled: () => Promise<boolean>,
): AsyncIterable<StreamChunk> => {
  const chunks = chunksFor(input);
  let index = 0;
  let terminalized = false;
  return {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<StreamChunk>> => {
        try {
          if (index >= chunks.length) return { done: true, value: undefined };
          if (await isCancelled()) {
            terminalized = true;
            return { done: true, value: undefined };
          }
          if (index === chunks.length - 1 && !terminalized) {
            await onComplete();
            terminalized = true;
          }
          const value = chunks.at(index);
          index += 1;
          return value
            ? { done: false, value }
            : { done: true, value: undefined };
        } catch (error) {
          if (!terminalized) {
            terminalized = true;
            await onFailure();
          }
          throw error;
        }
      },
      return: async (): Promise<IteratorResult<StreamChunk>> => {
        if (!terminalized) {
          terminalized = true;
          await onFailure();
        }
        return { done: true, value: undefined };
      },
    }),
  };
};
