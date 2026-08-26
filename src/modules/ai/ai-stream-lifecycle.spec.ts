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
  type ProductRecommendationState,
} from './ai-provider-protocol.js';
import {
  completionChunk,
  deferred,
  emptyTools,
  pendingStream,
  streamResponse,
  testConfig,
} from '../../../test/openai-compatible-ai.adapter-test-support.js';
import { OpenAiCompatibleAiStreamAdapter } from './openai-compatible-ai.adapter.js';
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
    const stop = jest.fn();
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
      stop,
    )[Symbol.asyncIterator]();

    await expect(iterator.return?.()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(sourceReturn).toHaveBeenCalledTimes(1);
    expect(abortController.signal.reason).toBe('shopport:stream-closed');
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(terminal.status()).toBe('failed');
  });

  describe('renewable run lifecycle', () => {
    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    it('does not overlap lease renewals', async () => {
      jest.useFakeTimers();
      const renewal = deferred<undefined>();
      const renewLease = jest
        .fn<() => Promise<void>>()
        .mockReturnValue(renewal.promise);
      let cancelled = false;
      const stream = pendingStream({
        onComplete: () => Promise.resolve(),
        onFailure: () => Promise.resolve(),
        isCancelled: () => Promise.resolve(cancelled),
        renewLease,
      });

      const pendingNext = stream.iterator.next();
      await jest.advanceTimersByTimeAsync(15_000);
      expect(renewLease).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(15_000);
      expect(renewLease).toHaveBeenCalledTimes(1);

      renewal.resolve(undefined);
      cancelled = true;
      await jest.advanceTimersByTimeAsync(250);
      await pendingNext;
      await expect(stream.iterator.next()).resolves.toEqual({
        done: true,
        value: undefined,
      });
      expect(stream.providerSignal()?.aborted).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('renews the lease every fifteen seconds', async () => {
      jest.useFakeTimers();
      const renewLease = jest.fn<() => Promise<void>>().mockResolvedValue();
      let cancelled = false;
      const stream = pendingStream({
        onComplete: () => Promise.resolve(),
        onFailure: () => Promise.resolve(),
        isCancelled: () => Promise.resolve(cancelled),
        renewLease,
      });
      const pendingNext = stream.iterator.next();

      await jest.advanceTimersByTimeAsync(30_000);
      expect(renewLease).toHaveBeenCalledTimes(2);

      cancelled = true;
      await jest.advanceTimersByTimeAsync(250);
      await pendingNext;
      await expect(stream.iterator.next()).resolves.toEqual({
        done: true,
        value: undefined,
      });
      expect(jest.getTimerCount()).toBe(0);
    });

    it('aborts provider work and emits only RUN_ERROR when renewal fails', async () => {
      jest.useFakeTimers();
      const renewLease = jest
        .fn<() => Promise<void>>()
        .mockRejectedValue(new Error('lease lost'));
      const onFailure = jest.fn(() => Promise.resolve());
      const stream = pendingStream({
        onComplete: () => Promise.resolve(),
        onFailure,
        isCancelled: () => Promise.resolve(false),
        renewLease,
      });
      const chunks: Array<StreamChunk> = [];
      const pendingNext = stream.iterator.next();

      await jest.advanceTimersByTimeAsync(15_000);
      const started = await pendingNext;
      if (!started.done) chunks.push(started.value);
      for (;;) {
        const result = await stream.iterator.next();
        if (result.done) break;
        chunks.push(result.value);
      }

      expect(stream.providerSignal()?.aborted).toBe(true);
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(chunks.some(({ type }) => type === EventType.RUN_FINISHED)).toBe(
        false,
      );
      expect(chunks.at(-1)).toEqual(
        expect.objectContaining({ type: EventType.RUN_ERROR }),
      );
      expect(jest.getTimerCount()).toBe(0);
    });

    it('keeps database cancellation authoritative when renewal loses the lease', async () => {
      jest.useFakeTimers();
      const cancellationPoll = deferred<boolean>();
      const isCancelled = jest
        .fn<() => Promise<boolean>>()
        .mockReturnValueOnce(cancellationPoll.promise)
        .mockResolvedValue(true);
      const onFailure = jest.fn(() => Promise.resolve());
      const stream = pendingStream({
        onComplete: () => Promise.resolve(),
        onFailure,
        isCancelled,
        renewLease: () => Promise.reject(new Error('lease lost')),
      });
      const chunks: Array<StreamChunk> = [];
      const pendingNext = stream.iterator.next();

      await jest.advanceTimersByTimeAsync(15_000);
      const started = await pendingNext;
      if (!started.done) chunks.push(started.value);
      for (;;) {
        const result = await stream.iterator.next();
        if (result.done) break;
        chunks.push(result.value);
      }
      cancellationPoll.resolve(false);
      await Promise.resolve();

      expect(isCancelled).toHaveBeenCalledTimes(2);
      expect(onFailure).not.toHaveBeenCalled();
      expect(chunks.some(({ type }) => type === EventType.RUN_ERROR)).toBe(
        false,
      );
      expect(jest.getTimerCount()).toBe(0);
    });

    it('reports completion persistence rejection as RUN_ERROR', async () => {
      jest.useFakeTimers();
      const onFailure = jest.fn(() => Promise.resolve());
      const chunks: Array<StreamChunk> = [];

      for await (const chunk of new OpenAiCompatibleAiStreamAdapter(
        testConfig(),
        jest
          .fn<typeof fetch>()
          .mockResolvedValue(
            streamResponse([
              completionChunk(
                'chatcmpl-answer',
                { role: 'assistant', content: '완료 응답' },
                null,
              ),
              completionChunk('chatcmpl-answer', {}, 'stop'),
            ]),
          ),
      ).createStream(
        {
          threadId: 'thread-1',
          runId: 'run-1',
          text: '이미지 설명',
          image: { base64: 'aW1hZ2U=', mimeType: 'image/jpeg' },
        },
        emptyTools,
        {
          onComplete: () => Promise.reject(new Error('lease lost')),
          onFailure,
          isCancelled: () => Promise.resolve(false),
          renewLease: () => Promise.resolve(),
        },
      )) {
        chunks.push(chunk);
      }

      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(chunks.some(({ type }) => type === EventType.RUN_FINISHED)).toBe(
        false,
      );
      expect(chunks.at(-1)).toEqual(
        expect.objectContaining({ type: EventType.RUN_ERROR }),
      );
      expect(jest.getTimerCount()).toBe(0);
    });

    it('clears lifecycle timers after a provider error', async () => {
      jest.useFakeTimers();
      const chunks: Array<StreamChunk> = [];
      const stream = new OpenAiCompatibleAiStreamAdapter(
        testConfig(),
        jest
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(null, { status: 500 })),
      ).createStream(
        {
          threadId: 'thread-1',
          runId: 'run-1',
          text: '이미지 설명',
          image: { base64: 'aW1hZ2U=', mimeType: 'image/jpeg' },
        },
        emptyTools,
        {
          onComplete: () => Promise.resolve(),
          onFailure: () => Promise.resolve(),
          isCancelled: () => Promise.resolve(false),
          renewLease: () => Promise.resolve(),
        },
      );
      const consume = (async (): Promise<void> => {
        for await (const chunk of stream) chunks.push(chunk);
      })();

      await jest.advanceTimersByTimeAsync(46_000);
      await consume;

      expect(chunks.at(-1)).toEqual(
        expect.objectContaining({ type: EventType.RUN_ERROR }),
      );
      expect(jest.getTimerCount()).toBe(0);
    });

    it('clears lifecycle timers after a successful finish', async () => {
      jest.useFakeTimers();
      const chunks: Array<StreamChunk> = [];

      for await (const chunk of new OpenAiCompatibleAiStreamAdapter(
        testConfig(),
        jest
          .fn<typeof fetch>()
          .mockResolvedValue(
            streamResponse([
              completionChunk(
                'chatcmpl-answer',
                { role: 'assistant', content: '완료 응답' },
                null,
              ),
              completionChunk('chatcmpl-answer', {}, 'stop'),
            ]),
          ),
      ).createStream(
        {
          threadId: 'thread-1',
          runId: 'run-1',
          text: '이미지 설명',
          image: { base64: 'aW1hZ2U=', mimeType: 'image/jpeg' },
        },
        emptyTools,
        {
          onComplete: () => Promise.resolve(),
          onFailure: () => Promise.resolve(),
          isCancelled: () => Promise.resolve(false),
          renewLease: () => Promise.resolve(),
        },
      )) {
        chunks.push(chunk);
      }

      expect(chunks.at(-1)).toEqual(
        expect.objectContaining({ type: EventType.RUN_FINISHED }),
      );
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
