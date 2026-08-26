import type {
  AbortInfo,
  ChatMiddlewareConfig,
  ChatMiddlewareContext,
  ErrorInfo,
  FinishInfo,
  StreamChunk,
} from '@tanstack/ai';
import { EventType, RUN_CANCEL_REASON } from '@tanstack/ai';

import {
  ambiguityAssessmentToolChoice,
  askUserToolChoice,
  type DeepModeState,
  type ProductRecommendationState,
  recommendationToolChoice,
  searchProductsToolChoice,
} from './ai-provider-protocol.js';
import type {
  AiProductRecommendation,
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

type LifecycleMiddleware = Readonly<{
  name: string;
  stop: () => void;
  onConfig: (
    context: ChatMiddlewareContext,
    config: ChatMiddlewareConfig,
  ) => Partial<ChatMiddlewareConfig>;
  setup: () => void;
  onShouldContinue: () => boolean;
  onFinish: (context: ChatMiddlewareContext, info: FinishInfo) => Promise<void>;
  onAbort: (context: ChatMiddlewareContext, info: AbortInfo) => Promise<void>;
  onError: (context: ChatMiddlewareContext, info: ErrorInfo) => Promise<void>;
}>;

const expectedProductIds = (
  state: ProductRecommendationState,
): ReadonlyArray<string> => [...state.productIds];

const recommendationsComplete = (state: ProductRecommendationState): boolean =>
  state.productIds.size === 0 ||
  [...state.productIds].every((productId) => state.aiSummaries.has(productId));

const productRecommendations = (
  state: ProductRecommendationState,
): ReadonlyArray<AiProductRecommendation> =>
  expectedProductIds(state).flatMap((productId) => {
    const aiSummary = state.aiSummaries.get(productId);
    return aiSummary ? [{ productId, aiSummary }] : [];
  });

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
      const clarificationDimension =
        deepModeState.assessment?.clarificationDimension ?? null;
      const needsShoppingSearch =
        deepModeState.assessment?.requestKind === 'shopping' &&
        !deepModeState.searchedProducts;
      return {
        modelOptions: askUserState()
          ? modelOptions
          : deepModeState.assessmentRequired && !deepModeState.assessment
            ? {
                ...modelOptions,
                tool_choice: ambiguityAssessmentToolChoice,
              }
            : clarificationDimension
              ? { ...modelOptions, tool_choice: askUserToolChoice }
              : needsShoppingSearch
                ? { ...modelOptions, tool_choice: searchProductsToolChoice }
                : recommendationsComplete(recommendationState)
                  ? modelOptions
                  : { ...modelOptions, tool_choice: recommendationToolChoice },
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
      const text = info.content.trim();
      const askUser = askUserState();
      const needsAssessment =
        deepModeState.assessmentRequired && !deepModeState.assessment;
      const needsClarification =
        deepModeState.assessment !== null &&
        deepModeState.assessment.clarificationDimension !== null;
      const needsSearch =
        deepModeState.assessment?.requestKind === 'shopping' &&
        !needsClarification &&
        !deepModeState.searchedProducts;
      if (
        !askUser &&
        (needsAssessment ||
          needsClarification ||
          needsSearch ||
          info.finishReason !== 'stop' ||
          text.length === 0 ||
          !recommendationsComplete(recommendationState))
      ) {
        await terminal.fail();
        throw new Error('Command Code returned an incomplete response');
      }
      await terminal.complete({
        messageId: assistantMessageId,
        text: askUser ? '' : text,
        productRecommendations: askUser
          ? []
          : productRecommendations(recommendationState),
        askUser,
      });
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
