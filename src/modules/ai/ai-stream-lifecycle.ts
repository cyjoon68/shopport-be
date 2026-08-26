import type {
  ChatMiddleware,
  ChatMiddlewareConfig,
  StreamChunk,
} from '@tanstack/ai';
import { EventType, RUN_CANCEL_REASON } from '@tanstack/ai';

import {
  type DeepModeState,
  nextToolChoice,
  type ProductRecommendationState,
  providerStreamResult,
} from './ai-provider-protocol.js';
import type {
  AiStreamInput,
  AiStreamLifecycle,
  AiStreamResult,
  AskUser,
} from './types.js';

const overallTimeoutMilliseconds = 55_000;
const leaseRenewalIntervalMilliseconds = 15_000;
const timeoutReason = 'shopport:ai-timeout';
const streamClosedReason = 'shopport:stream-closed';
const cancellationCheckFailedReason = 'shopport:cancellation-check-failed';
const leaseRenewalFailedReason = 'shopport:lease-renewal-failed';

type TerminalStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled';

type TerminalState = Readonly<{
  status: () => TerminalStatus;
  complete: (result: AiStreamResult) => Promise<void>;
  fail: () => Promise<void>;
  cancel: () => void;
}>;

type LifecycleMiddleware = ChatMiddleware & Readonly<{ stop: () => void }>;

export const createTerminalState = (
  lifecycle: AiStreamLifecycle,
): TerminalState => {
  let status: TerminalStatus = 'pending';
  return {
    status: () => status,
    complete: async (result): Promise<void> => {
      if (status !== 'pending') return;
      try {
        await lifecycle.onComplete(result);
        status = 'succeeded';
      } catch (error) {
        status = 'failed';
        await lifecycle.onFailure();
        throw error;
      }
    },
    fail: async (): Promise<void> => {
      if (status !== 'pending') return;
      status = 'failed';
      await lifecycle.onFailure();
    },
    cancel: (): void => {
      if (status === 'pending') status = 'cancelled';
    },
  };
};

export const createLifecycleMiddleware = (
  abortController: AbortController,
  lifecycle: AiStreamLifecycle,
  terminal: TerminalState,
  recommendationState: ProductRecommendationState,
  deepModeState: DeepModeState,
  askUserState: () => AskUser | null,
  assistantMessageId: string,
): LifecycleMiddleware => {
  let cancellationInterval: NodeJS.Timeout | undefined;
  let leaseRenewalInterval: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let pollPending = false;
  let renewalPending = false;
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    if (cancellationInterval) clearInterval(cancellationInterval);
    if (leaseRenewalInterval) clearInterval(leaseRenewalInterval);
    if (timeout) clearTimeout(timeout);
  };
  const pollCancellation = (): void => {
    if (pollPending || stopped || abortController.signal.aborted) return;
    pollPending = true;
    void lifecycle
      .isCancelled()
      .then((cancelled) => {
        if (cancelled && !stopped && !abortController.signal.aborted) {
          abortController.abort(RUN_CANCEL_REASON);
        }
      })
      .catch(() => {
        if (!stopped && !abortController.signal.aborted) {
          abortController.abort(cancellationCheckFailedReason);
        }
      })
      .finally(() => {
        pollPending = false;
      });
  };
  const renewLease = (): void => {
    if (renewalPending || stopped || abortController.signal.aborted) return;
    renewalPending = true;
    void lifecycle
      .renewLease()
      .catch(() => {
        if (!stopped && !abortController.signal.aborted) {
          abortController.abort(leaseRenewalFailedReason);
        }
      })
      .finally(() => {
        renewalPending = false;
      });
  };
  return {
    name: 'shopport-ai-lifecycle',
    stop,
    onConfig: (_context, config): Partial<ChatMiddlewareConfig> => {
      const modelOptions = { ...config.modelOptions };
      delete modelOptions.tool_choice;
      const toolChoice = nextToolChoice(
        recommendationState,
        deepModeState,
        askUserState(),
      );
      return {
        modelOptions: toolChoice
          ? { ...modelOptions, tool_choice: toolChoice }
          : modelOptions,
      };
    },
    setup: (): void => {
      cancellationInterval = setInterval(pollCancellation, 250);
      cancellationInterval.unref();
      leaseRenewalInterval = setInterval(
        renewLease,
        leaseRenewalIntervalMilliseconds,
      );
      leaseRenewalInterval.unref();
      timeout = setTimeout(() => {
        if (!abortController.signal.aborted) {
          abortController.abort(timeoutReason);
        }
      }, overallTimeoutMilliseconds);
      timeout.unref();
      pollCancellation();
    },
    onShouldContinue: (): boolean => askUserState() === null,
    onFinish: async (_context, info): Promise<void> => {
      stop();
      const result = providerStreamResult(
        info.finishReason,
        info.content,
        recommendationState,
        deepModeState,
        askUserState(),
        assistantMessageId,
      );
      if (!result) {
        await terminal.fail();
        throw new Error('Command Code returned an incomplete response');
      }
      await terminal.complete(result);
    },
    onAbort: async (_context, info): Promise<void> => {
      stop();
      if (info.cancelRequested) {
        terminal.cancel();
        return;
      }
      await terminal.fail();
    },
    onError: async (): Promise<void> => {
      stop();
      await terminal.fail();
    },
  };
};

const isVisibleChunk = (chunk: StreamChunk): boolean =>
  chunk.type === EventType.RUN_STARTED ||
  chunk.type === EventType.TOOL_CALL_START ||
  chunk.type === EventType.TOOL_CALL_ARGS ||
  chunk.type === EventType.TOOL_CALL_END ||
  chunk.type === EventType.TOOL_CALL_RESULT ||
  chunk.type === EventType.TEXT_MESSAGE_START ||
  chunk.type === EventType.TEXT_MESSAGE_CONTENT ||
  chunk.type === EventType.TEXT_MESSAGE_END;

const terminalChunk = (
  input: AiStreamInput,
  terminal: TerminalState,
): StreamChunk | null => {
  if (terminal.status() === 'succeeded') {
    return {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
      outcome: { type: 'success' },
      finishReason: 'stop',
    };
  }
  if (terminal.status() === 'failed') {
    return {
      type: EventType.RUN_ERROR,
      threadId: input.threadId,
      runId: input.runId,
      message: 'AI provider request failed',
      code: 'AI_PROVIDER_ERROR',
    };
  }
  return null;
};

export const createPublicStream = (
  source: AsyncIterable<StreamChunk>,
  input: AiStreamInput,
  abortController: AbortController,
  terminal: TerminalState,
  assistantMessageId: string,
  stop: () => void,
): AsyncIterable<StreamChunk> => {
  const iterator = source[Symbol.asyncIterator]();
  let sourceDone = false;
  let terminalYielded = false;
  let runStarted = false;
  const nextTerminal = (): IteratorResult<StreamChunk> => {
    if (terminalYielded) return { done: true, value: undefined };
    terminalYielded = true;
    const chunk = terminalChunk(input, terminal);
    return chunk
      ? { done: false, value: chunk }
      : { done: true, value: undefined };
  };
  return {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<StreamChunk>> => {
        if (sourceDone) return nextTerminal();
        for (;;) {
          let result: IteratorResult<StreamChunk>;
          try {
            result = await iterator.next();
          } catch {
            sourceDone = true;
            stop();
            await terminal.fail().catch(() => undefined);
            return nextTerminal();
          }
          if (result.done) {
            sourceDone = true;
            stop();
            if (terminal.status() === 'pending') {
              await terminal.fail().catch(() => undefined);
            }
            return nextTerminal();
          }
          const chunk = result.value;
          if (
            chunk.type === EventType.RUN_FINISHED ||
            chunk.type === EventType.RUN_ERROR
          ) {
            continue;
          }
          if (chunk.type === EventType.RUN_STARTED) {
            if (runStarted) continue;
            runStarted = true;
          }
          if (isVisibleChunk(chunk)) {
            if (
              chunk.type === EventType.TEXT_MESSAGE_START ||
              chunk.type === EventType.TEXT_MESSAGE_CONTENT ||
              chunk.type === EventType.TEXT_MESSAGE_END
            ) {
              return {
                done: false,
                value: { ...chunk, messageId: assistantMessageId },
              };
            }
            if (chunk.type === EventType.TOOL_CALL_START) {
              return {
                done: false,
                value: { ...chunk, parentMessageId: assistantMessageId },
              };
            }
            return { done: false, value: chunk };
          }
        }
      },
      return: async (): Promise<IteratorResult<StreamChunk>> => {
        if (!sourceDone) {
          stop();
          abortController.abort(streamClosedReason);
          await iterator.return?.();
          sourceDone = true;
          if (terminal.status() === 'pending') {
            await terminal.fail().catch(() => undefined);
          }
        }
        terminalYielded = true;
        return { done: true, value: undefined };
      },
    }),
  };
};
