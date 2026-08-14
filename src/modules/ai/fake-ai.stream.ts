import { EventType } from '@tanstack/ai';
import type { StreamChunk } from '@tanstack/ai';
import { v7 as uuidv7 } from 'uuid';
import { toAiProductResult } from './ai-tool-result.js';
import type {
  AskUser,
  AiStreamInput,
  AiStreamLifecycle,
  AiStreamResult,
} from './ai-stream.adapter.js';
import type { AiToolSession } from './ai-tools.js';

const clarification = {
  question: '어디에서 주로 사용할 건가요?',
  options: [
    { id: 'commute', label: '출퇴근' },
    { id: 'exercise', label: '운동' },
    { id: 'calls', label: '통화' },
  ],
  allowFreeText: false,
} as const satisfies AskUser;

const needsClarification = (input: AiStreamInput): boolean =>
  input.text.includes('이어폰') &&
  !input.history?.some(
    ({ role, text }) =>
      role === 'assistant' && text.includes(clarification.question),
  );

const searchQuery = (input: AiStreamInput): string => {
  const askedAboutEarbuds = input.history?.some(
    ({ role, text }) =>
      role === 'assistant' && text.includes(clarification.question),
  );
  return askedAboutEarbuds ? '이어폰' : input.text || '추천 상품';
};

const clarificationChunks = (
  input: AiStreamInput,
  messageId: string,
  toolCallId: string,
): Array<StreamChunk> => [
  {
    type: EventType.RUN_STARTED,
    threadId: input.threadId,
    runId: input.runId,
  },
  {
    type: EventType.TOOL_CALL_START,
    toolCallId,
    toolCallName: 'askUser',
    toolName: 'askUser',
    parentMessageId: messageId,
  },
  {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId,
    delta: JSON.stringify(clarification),
  },
  { type: EventType.TOOL_CALL_END, toolCallId },
  {
    type: EventType.RUN_FINISHED,
    threadId: input.threadId,
    runId: input.runId,
    outcome: { type: 'success' },
    finishReason: 'stop',
  },
];

const chunksFor = (
  input: AiStreamInput,
  messageId: string,
  toolCallId: string,
  query: string,
  message: string,
  productResult: ReturnType<typeof toAiProductResult>,
): Array<StreamChunk> => {
  const textChunks = message.match(/.{1,18}/gu) ?? [message];
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
      delta: JSON.stringify({ query }),
    },
    { type: EventType.TOOL_CALL_END, toolCallId },
    {
      type: EventType.TOOL_CALL_RESULT,
      messageId: uuidv7(),
      toolCallId,
      content: JSON.stringify(productResult),
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
  input: AiStreamInput,
  tools: AiToolSession,
  lifecycle: AiStreamLifecycle,
): AsyncIterable<StreamChunk> => {
  let chunks: Array<StreamChunk> | null = null;
  let completion: AiStreamResult | null = null;
  let index = 0;
  let terminalized = false;
  const initialize = async (): Promise<void> => {
    const messageId = uuidv7();
    if (needsClarification(input)) {
      chunks = clarificationChunks(input, messageId, uuidv7());
      completion = {
        messageId,
        text: '',
        productIds: [],
        askUser: clarification,
      };
      return;
    }
    const query = searchQuery(input);
    const result = await tools.searchProducts(query);
    const productResult = toAiProductResult(result.items);
    const message =
      result.items.length > 0
        ? '조건에 맞는 상품을 가격과 배송 기준으로 정리했어요. 카드를 눌러 상세 조건을 확인해 보세요.'
        : '조건에 맞는 상품을 찾지 못했어요. 용도나 예산을 조금 더 알려주세요.';
    chunks = chunksFor(
      input,
      messageId,
      uuidv7(),
      query,
      message,
      productResult,
    );
    completion = {
      messageId,
      text: message,
      productIds: result.items.map(({ id }) => id),
      askUser: null,
    };
  };
  return {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<StreamChunk>> => {
        try {
          if (await lifecycle.isCancelled()) {
            terminalized = true;
            return { done: true, value: undefined };
          }
          if (!chunks) await initialize();
          if (!chunks || index >= chunks.length) {
            return { done: true, value: undefined };
          }
          const value = chunks.at(index);
          if (index === chunks.length - 1 && !terminalized) {
            if (!completion) {
              throw new Error('Fake AI stream is incomplete');
            }
            await lifecycle.onComplete(completion);
            terminalized = true;
          }
          index += 1;
          return value
            ? { done: false, value }
            : { done: true, value: undefined };
        } catch (error) {
          if (!terminalized) {
            terminalized = true;
            await lifecycle.onFailure();
          }
          throw error;
        }
      },
      return: async (): Promise<IteratorResult<StreamChunk>> => {
        if (!terminalized) {
          terminalized = true;
          await lifecycle.onFailure();
        }
        return { done: true, value: undefined };
      },
    }),
  };
};
