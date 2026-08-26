import { jest } from '@jest/globals';
import type {
  AbortInfo,
  ChatMiddlewareConfig,
  ChatMiddlewareContext,
  ErrorInfo,
  FinishInfo,
  StreamChunk,
} from '@tanstack/ai';
import { EventType } from '@tanstack/ai';

import {
  type DeepModeState,
  normalizeConversationTitle,
  type ProductRecommendationState,
} from './ai-provider-protocol.js';
import {
  createLifecycleMiddleware,
  createPublicStream,
  createTerminalState,
} from './ai-stream-lifecycle.js';
import type { AiStreamLifecycle } from './types.js';

const context = {} as ChatMiddlewareContext;

const config = (): ChatMiddlewareConfig => ({
  messages: [],
  systemPrompts: [],
  tools: [],
  modelOptions: { tool_choice: 'stale' },
});

const lifecycle = (
  overrides: Partial<AiStreamLifecycle> = {},
): AiStreamLifecycle => ({
  onComplete: () => Promise.resolve(),
  onFailure: () => Promise.resolve(),
  isCancelled: () => Promise.resolve(false),
  renewLease: () => Promise.resolve(),
  ...overrides,
});

const states = (): Readonly<{
  recommendationState: ProductRecommendationState;
  deepModeState: DeepModeState;
}> => ({
  recommendationState: {
    productIds: new Set<string>(),
    aiSummaries: new Map<string, string>(),
  },
  deepModeState: {
    assessment: null,
    assessmentRequired: true,
    searchedProducts: false,
  },
});

const source = (
  chunks: ReadonlyArray<StreamChunk>,
  sourceReturn: jest.Mock<() => Promise<IteratorResult<StreamChunk>>>,
): AsyncIterable<StreamChunk> => ({
  [Symbol.asyncIterator]: (): AsyncIterator<StreamChunk> => {
    let index = 0;
    return {
      next: (): Promise<IteratorResult<StreamChunk>> => {
        const chunk = chunks[index];
        index += 1;
        return Promise.resolve(
          chunk
            ? { done: false, value: chunk }
            : { done: true, value: undefined },
        );
      },
      return: sourceReturn,
    };
  },
});

describe('AI stream lifecycle', () => {
  it('normalizes a quoted multiline title to twenty-four characters', () => {
    expect(
      normalizeConversationTitle(
        '  “지성 피부에 맞는\n쿠션 파운데이션 추천입니다. 추가 설명”  ',
      ),
    ).toBe('지성 피부에 맞는 쿠션 파운데이션 추천입니다');
  });

  it('progresses tool choice through assessment, clarification, search, and recommendations', async () => {
    const { recommendationState, deepModeState } = states();
    const terminal = createTerminalState(lifecycle());
    const middleware = createLifecycleMiddleware(
      new AbortController(),
      lifecycle(),
      terminal,
      recommendationState,
      deepModeState,
      () => null,
      'assistant-1',
    );
    const toolChoice = async (): Promise<unknown> => {
      const transformed = await middleware.onConfig?.(context, config());
      return transformed ? transformed.modelOptions?.tool_choice : undefined;
    };

    await expect(toolChoice()).resolves.toEqual({
      type: 'function',
      function: { name: 'assessShoppingAmbiguity' },
    });
    deepModeState.assessment = {
      requestKind: 'shopping',
      ambiguityScore: 0.4,
      clarificationDimension: 'purpose',
    };
    await expect(toolChoice()).resolves.toEqual({
      type: 'function',
      function: { name: 'askUser' },
    });
    deepModeState.assessment = {
      requestKind: 'shopping',
      ambiguityScore: 0,
      clarificationDimension: null,
    };
    await expect(toolChoice()).resolves.toEqual({
      type: 'function',
      function: { name: 'searchProducts' },
    });
    deepModeState.searchedProducts = true;
    recommendationState.productIds.add('product-1');
    await expect(toolChoice()).resolves.toEqual({
      type: 'function',
      function: { name: 'recordProductRecommendations' },
    });
    recommendationState.aiSummaries.set(
      'product-1',
      '상품 특징이 요청한 조건에 잘 맞기 때문에 추천합니다.',
    );
    await expect(toolChoice()).resolves.toBeUndefined();
  });

  it('rejects an incomplete response and records one failure', async () => {
    const onFailure = jest.fn(() => Promise.resolve());
    const currentLifecycle = lifecycle({ onFailure });
    const { recommendationState, deepModeState } = states();
    const terminal = createTerminalState(currentLifecycle);
    const middleware = createLifecycleMiddleware(
      new AbortController(),
      currentLifecycle,
      terminal,
      recommendationState,
      deepModeState,
      () => null,
      'assistant-1',
    );
    const info: FinishInfo = {
      finishReason: 'stop',
      duration: 1,
      content: '완료되지 않은 응답',
    };

    await expect(middleware.onFinish?.(context, info)).rejects.toThrow(
      'Command Code returned an incomplete response',
    );
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(terminal.status()).toBe('failed');
  });

  it('filters duplicate run starts and rewrites assistant message identifiers', async () => {
    const currentLifecycle = lifecycle();
    const terminal = createTerminalState(currentLifecycle);
    await terminal.complete({
      messageId: 'assistant-1',
      text: '완료',
      productRecommendations: [],
      askUser: null,
    });
    const sourceReturn = jest.fn(() =>
      Promise.resolve({ done: true as const, value: undefined }),
    );
    const chunks: ReadonlyArray<StreamChunk> = [
      { type: EventType.RUN_STARTED, threadId: 'thread-1', runId: 'run-1' },
      { type: EventType.RUN_STARTED, threadId: 'thread-1', runId: 'run-1' },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: 'provider-message',
        role: 'assistant',
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'provider-message',
        delta: '완료',
      },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: 'tool-1',
        toolCallName: 'searchProducts',
        toolName: 'searchProducts',
        parentMessageId: 'provider-message',
      },
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: 'provider-message',
      },
    ];
    const stream = createPublicStream(
      source(chunks, sourceReturn),
      {
        threadId: 'thread-1',
        runId: 'run-1',
        text: '질문',
        image: null,
      },
      new AbortController(),
      terminal,
      'assistant-1',
      () => undefined,
    );
    const visible: Array<StreamChunk> = [];

    for await (const chunk of stream) visible.push(chunk);

    expect(
      visible.filter(({ type }) => type === EventType.RUN_STARTED),
    ).toEqual([chunks[0]]);
    expect(
      visible.flatMap((chunk) =>
        chunk.type === EventType.TEXT_MESSAGE_START ||
        chunk.type === EventType.TEXT_MESSAGE_CONTENT ||
        chunk.type === EventType.TEXT_MESSAGE_END
          ? [chunk.messageId]
          : [],
      ),
    ).toEqual(['assistant-1', 'assistant-1', 'assistant-1']);
    expect(
      visible.find(({ type }) => type === EventType.TOOL_CALL_START),
    ).toEqual(expect.objectContaining({ parentMessageId: 'assistant-1' }));
    expect(visible.at(-1)).toEqual(
      expect.objectContaining({ type: EventType.RUN_FINISHED }),
    );
  });

  it('keeps cancellation terminal without recording failure', async () => {
    const onFailure = jest.fn(() => Promise.resolve());
    const currentLifecycle = lifecycle({ onFailure });
    const { recommendationState, deepModeState } = states();
    const terminal = createTerminalState(currentLifecycle);
    const middleware = createLifecycleMiddleware(
      new AbortController(),
      currentLifecycle,
      terminal,
      recommendationState,
      deepModeState,
      () => null,
      'assistant-1',
    );
    const info: AbortInfo = { duration: 1, cancelRequested: true };

    await middleware.onAbort?.(context, info);

    expect(terminal.status()).toBe('cancelled');
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('records provider errors once', async () => {
    const onFailure = jest.fn(() => Promise.resolve());
    const currentLifecycle = lifecycle({ onFailure });
    const { recommendationState, deepModeState } = states();
    const terminal = createTerminalState(currentLifecycle);
    const middleware = createLifecycleMiddleware(
      new AbortController(),
      currentLifecycle,
      terminal,
      recommendationState,
      deepModeState,
      () => null,
      'assistant-1',
    );
    const info: ErrorInfo = { duration: 1, error: new Error('provider') };

    await middleware.onError?.(context, info);
    await middleware.onError?.(context, info);

    expect(terminal.status()).toBe('failed');
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('returns the source iterator and releases a pending run when closed', async () => {
    const onFailure = jest.fn(() => Promise.resolve());
    const abortController = new AbortController();
    const terminal = createTerminalState(lifecycle({ onFailure }));
    const sourceReturn = jest.fn(() =>
      Promise.resolve({ done: true as const, value: undefined }),
    );
    const iterator = createPublicStream(
      source([], sourceReturn),
      {
        threadId: 'thread-1',
        runId: 'run-1',
        text: '질문',
        image: null,
      },
      abortController,
      terminal,
      'assistant-1',
      () => undefined,
    )[Symbol.asyncIterator]();

    await expect(iterator.return?.()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(sourceReturn).toHaveBeenCalledTimes(1);
    expect(abortController.signal.reason).toBe('shopport:stream-closed');
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(terminal.status()).toBe('failed');
  });
});
