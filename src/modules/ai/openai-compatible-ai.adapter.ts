import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EventType,
  RUN_CANCEL_REASON,
  chat,
  maxIterations,
  toolDefinition,
} from '@tanstack/ai';
import type {
  AnyServerTool,
  ChatMiddleware,
  ChatMiddlewareConfig,
  ContentPart,
  ModelMessage,
  StreamChunk,
} from '@tanstack/ai';
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import type { Environment } from '../../config/environment.js';
import { toAiProductResult } from './ai-tool-result.js';
import type {
  AiStreamAdapter,
  AiStreamInput,
  AiStreamLifecycle,
  AiProductRecommendation,
  AiStreamResult,
} from './ai-stream.adapter.js';
import type { AiToolSession } from './ai-tools.js';

export const AI_PROVIDER_FETCH = Symbol('AI_PROVIDER_FETCH');

const providerBaseUrl = 'https://api.commandcode.ai/provider/v1';
const overallTimeoutMilliseconds = 55_000;
const providerTimeoutMilliseconds = 45_000;
const timeoutReason = 'shopport:ai-timeout';
const streamClosedReason = 'shopport:stream-closed';
const cancellationCheckFailedReason = 'shopport:cancellation-check-failed';

const searchProductsDefinition = toolDefinition({
  name: 'searchProducts',
  description:
    '다이소 또는 올리브영에서 최대 3개 상품을 검색합니다. 판매처를 말하지 않으면 daiso를 사용하고, 위치가 있으면 매장 재고도 확인합니다.',
  inputSchema: z.object({
    query: z.string().trim().min(1).max(200),
    providerId: z.enum(['daiso', 'oliveyoung']).nullish(),
    budgetMax: z.number().int().positive().nullish(),
    location: z.string().trim().min(1).max(100).nullish(),
  }),
});

const getProductDefinition = toolDefinition({
  name: 'getProduct',
  description: '상품 ID로 승인된 provider의 최신 상품 카드를 조회합니다.',
  inputSchema: z.object({ id: z.uuid() }),
});

const recordProductRecommendationsDefinition = toolDefinition({
  name: 'recordProductRecommendations',
  description:
    '검색한 모든 상품의 순서를 유지해 상품별 AI 요약을 기록합니다. 각 aiSummary는 카드에서 확인한 상품 고유 특징과 사용자의 조건을 연결해, 왜 추천하는지 말하는 20~80자 한국어 한 문장이어야 합니다. 가격·판매처·재고만 나열하지 말고 반드시 추천 이유를 써야 합니다. searchProducts 또는 getProduct 뒤, 최종 답변 전에 반드시 호출합니다.',
  inputSchema: z.object({
    recommendations: z
      .array(
        z.object({
          productId: z.uuid(),
          aiSummary: z.string().trim().min(1).max(80),
        }),
      )
      .min(1)
      .max(3),
  }),
});

const hasRecommendationReason = (aiSummary: string): boolean =>
  aiSummary.length >= 20 && aiSummary.includes('추천');

const harnessPath = fileURLToPath(
  new URL('./shopping-ai-harness.md', import.meta.url),
);
const systemPrompt = readFileSync(harnessPath, 'utf8');

type TerminalStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled';

type ProductRecommendationState = {
  productIds: Set<string>;
  aiSummaries: Map<string, string>;
};

const recommendationToolChoice = {
  type: 'function',
  function: { name: 'recordProductRecommendations' },
};

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

const matchesExpectedProducts = (
  recommendations: ReadonlyArray<AiProductRecommendation>,
  state: ProductRecommendationState,
): boolean => {
  const productIds = expectedProductIds(state);
  return (
    recommendations.length === productIds.length &&
    recommendations.every(
      ({ productId, aiSummary }, index) =>
        productId === productIds[index] && hasRecommendationReason(aiSummary),
    )
  );
};

type TerminalState = Readonly<{
  status: () => TerminalStatus;
  complete: (result: AiStreamResult) => Promise<void>;
  fail: () => Promise<void>;
  cancel: () => void;
}>;

const createTerminalState = (lifecycle: AiStreamLifecycle): TerminalState => {
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

const createLifecycleMiddleware = (
  abortController: AbortController,
  lifecycle: AiStreamLifecycle,
  terminal: TerminalState,
  recommendationState: ProductRecommendationState,
  assistantMessageId: string,
): ChatMiddleware => {
  let cancellationInterval: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let pollPending = false;
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    if (cancellationInterval) clearInterval(cancellationInterval);
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
  return {
    name: 'shopport-ai-lifecycle',
    onConfig: (_context, config): Partial<ChatMiddlewareConfig> => {
      const modelOptions = { ...config.modelOptions };
      delete modelOptions.tool_choice;
      return {
        modelOptions: recommendationsComplete(recommendationState)
          ? modelOptions
          : { ...modelOptions, tool_choice: recommendationToolChoice },
      };
    },
    setup: (): void => {
      cancellationInterval = setInterval(pollCancellation, 250);
      cancellationInterval.unref();
      timeout = setTimeout(() => {
        if (!abortController.signal.aborted) {
          abortController.abort(timeoutReason);
        }
      }, overallTimeoutMilliseconds);
      timeout.unref();
      pollCancellation();
    },
    onFinish: async (_context, info): Promise<void> => {
      stop();
      const text = info.content.trim();
      if (
        info.finishReason !== 'stop' ||
        text.length === 0 ||
        !recommendationsComplete(recommendationState)
      ) {
        await terminal.fail();
        throw new Error('Command Code returned an incomplete response');
      }
      await terminal.complete({
        messageId: assistantMessageId,
        text,
        productRecommendations: productRecommendations(recommendationState),
        askUser: null,
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

const createPublicStream = (
  source: AsyncIterable<StreamChunk>,
  input: AiStreamInput,
  abortController: AbortController,
  terminal: TerminalState,
  assistantMessageId: string,
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
            await terminal.fail().catch(() => undefined);
            return nextTerminal();
          }
          if (result.done) {
            sourceDone = true;
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

@Injectable()
export class OpenAiCompatibleAiStreamAdapter implements AiStreamAdapter {
  public readonly requiresImageData = true;

  readonly #apiKey: string | undefined;
  readonly #model: string;
  readonly #maxOutputTokens: number;

  public constructor(
    config: ConfigService<Environment, true>,
    @Inject(AI_PROVIDER_FETCH) private readonly providerFetch: typeof fetch,
  ) {
    this.#apiKey = config.get('COMMAND_CODE_API_KEY', { infer: true });
    this.#model = config.get('COMMAND_CODE_MODEL', { infer: true });
    this.#maxOutputTokens = config.get('COMMAND_CODE_MAX_OUTPUT_TOKENS', {
      infer: true,
    });
  }

  public createStream = (
    input: AiStreamInput,
    tools: AiToolSession,
    lifecycle: AiStreamLifecycle,
  ): AsyncIterable<StreamChunk> => {
    if (!this.#apiKey) {
      throw new Error('COMMAND_CODE_API_KEY is required');
    }
    const recommendationState: ProductRecommendationState = {
      productIds: new Set<string>(),
      aiSummaries: new Map<string, string>(),
    };
    const abortController = new AbortController();
    const assistantMessageId = uuidv7();
    const commandCodeTools = this.createTools(tools, recommendationState);
    const terminal = createTerminalState(lifecycle);
    const adapter = openaiCompatibleText(this.#model, {
      name: 'commandcode',
      apiKey: this.#apiKey,
      baseURL: providerBaseUrl,
      defaultHeaders: { 'x-cmd-zdr': '1' },
      fetch: this.providerFetch,
      maxRetries: 1,
      timeout: providerTimeoutMilliseconds,
    });
    const source = chat({
      adapter,
      messages: this.modelMessages(input),
      systemPrompts: [systemPrompt],
      tools: commandCodeTools,
      modelOptions: {
        max_completion_tokens: this.#maxOutputTokens,
      },
      abortController,
      agentLoopStrategy: maxIterations(5),
      threadId: input.threadId,
      runId: input.runId,
      middleware: [
        createLifecycleMiddleware(
          abortController,
          lifecycle,
          terminal,
          recommendationState,
          assistantMessageId,
        ),
      ],
      debug: false,
    });
    return createPublicStream(
      source,
      input,
      abortController,
      terminal,
      assistantMessageId,
    );
  };

  private readonly modelMessages = (input: AiStreamInput): ModelMessage[] => {
    const history = (input.history ?? []).map(
      ({ role, text }): ModelMessage => ({ role, content: text }),
    );
    const prompt = input.text || '첨부 이미지를 설명해 주세요.';
    if (!input.image) {
      return history.length > 0 ? history : [{ role: 'user', content: prompt }];
    }
    const content: Array<ContentPart> = [
      { type: 'text', content: prompt },
      {
        type: 'image',
        source: {
          type: 'data',
          value: input.image.base64,
          mimeType: input.image.mimeType,
        },
        metadata: { detail: 'low' },
      },
    ];
    if (history.at(-1)?.role === 'user') history.pop();
    return [...history, { role: 'user', content }];
  };

  private readonly createTools = (
    session: AiToolSession,
    recommendationState: ProductRecommendationState,
  ): ReadonlyArray<AnyServerTool> => [
    searchProductsDefinition.server(
      async ({ query, providerId, budgetMax, location }) => {
        const result = await session.searchProducts({
          query,
          providerId: providerId ?? 'daiso',
          ...(budgetMax == null ? {} : { budgetMax }),
          ...(location == null ? {} : { location }),
        });
        result.items.forEach(({ id }) =>
          recommendationState.productIds.add(id),
        );
        return toAiProductResult(result.items);
      },
    ),
    getProductDefinition.server(async ({ id }) => {
      const product = await session.getProduct(id);
      return toAiProductResult(product ? [product] : []);
    }),
    recordProductRecommendationsDefinition.server(({ recommendations }) => {
      if (!matchesExpectedProducts(recommendations, recommendationState)) {
        return {
          kind: 'invalid_product_recommendations' as const,
          expectedProductIds: expectedProductIds(recommendationState),
          reason:
            '각 aiSummary에는 확인된 상품 고유 특징과 사용자 조건에 맞아 추천하는 이유를 20~80자로 작성해야 합니다.',
        };
      }
      recommendationState.aiSummaries.clear();
      recommendations.forEach(({ productId, aiSummary }) => {
        recommendationState.aiSummaries.set(productId, aiSummary);
      });
      return { kind: 'product_recommendations' as const, recommendations };
    }),
  ];
}
