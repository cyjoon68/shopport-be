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
  AskUser,
} from './ai-stream.adapter.js';
import type { AiProviderId } from './ai-request.js';
import { clarificationDimensions } from './ai-stream.adapter.js';
import type { AiToolSession } from './ai-tools.js';
import {
  evaluateShoppingDeepMode,
  shoppingAmbiguityThreshold,
  shoppingRequestKinds,
} from './shopping-deep-mode.js';
import type { ShoppingDeepModeAssessment } from './shopping-deep-mode.js';

export const AI_PROVIDER_FETCH = Symbol('AI_PROVIDER_FETCH');

const providerBaseUrl = 'https://api.commandcode.ai/provider/v1';
const overallTimeoutMilliseconds = 55_000;
const providerTimeoutMilliseconds = 45_000;
const timeoutReason = 'shopport:ai-timeout';
const streamClosedReason = 'shopport:stream-closed';
const cancellationCheckFailedReason = 'shopport:cancellation-check-failed';
const clarificationSkipMessage = '질문을 건너뛰고 현재 정보로 계속 진행해줘.';

export const askUserSchema = z
  .object({
    dimension: z.enum(clarificationDimensions),
    question: z.string().trim().min(1).max(160),
    options: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(64),
          label: z.string().trim().min(1).max(30),
        }),
      )
      .min(2)
      .max(4),
    allowFreeText: z.boolean(),
  })
  .superRefine(({ options }, context) => {
    if (new Set(options.map(({ id }) => id)).size !== options.length) {
      context.addIssue({
        code: 'custom',
        message: 'Option ids must be unique',
        path: ['options'],
      });
    }
  });

const askUserDefinition = toolDefinition({
  name: 'askUser',
  description:
    '추천 결과를 크게 바꾸는 지정된 조건 하나를 dimension에 기록하고, 짧은 한국어 질문과 2~4개 선택지로 확인합니다. 사용자가 선택하거나 자유 입력으로 답할 때까지 상품을 검색하거나 추천하지 않습니다.',
  inputSchema: askUserSchema,
});

const assessShoppingAmbiguityDefinition = toolDefinition({
  name: 'assessShoppingAmbiguity',
  description:
    '모든 텍스트 대화의 첫 단계에서 요청이 상품 탐색인지 분류하고, 상품 탐색이면 Deep Mode 방식으로 목표, 제약, 성공 기준 명확도를 각각 0~1로 평가합니다. 상품 탐색이 아니면 requestKind를 other로 하고 nextDimension은 null로 둡니다. 상품 탐색의 모호성 점수가 0.20보다 크면 가장 중요한 다음 질문 축을 nextDimension에 지정합니다. 내부 평가이며 사용자에게 보여주지 않습니다.',
  inputSchema: z.object({
    requestKind: z.enum(shoppingRequestKinds),
    goalClarity: z.number().min(0).max(1),
    constraintClarity: z.number().min(0).max(1),
    successCriteriaClarity: z.number().min(0).max(1),
    nextDimension: z.enum(clarificationDimensions).nullable(),
  }),
});

const searchProductsDefinition = toolDefinition({
  name: 'searchProducts',
  description:
    '다이소 또는 올리브영에서 최대 10개 상품을 검색합니다. 판매처를 말하지 않으면 daiso를 사용하고, 위치가 있으면 매장 재고도 확인합니다.',
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
      .max(10),
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

type DeepModeState = {
  assessment: ShoppingDeepModeAssessment | null;
  assessmentRequired: boolean;
  searchedProducts: boolean;
};

const recommendationToolChoice = {
  type: 'function',
  function: { name: 'recordProductRecommendations' },
};

const providerConstraintPrompt = (
  providerIds: ReadonlyArray<AiProviderId>,
): string | null => {
  if (providerIds.length === 0) return null;
  const names = providerIds
    .map((providerId) => (providerId === 'oliveyoung' ? '올리브영' : '다이소'))
    .join(', ');
  return `이번 요청의 판매처 조건은 ${names}이며 이미 확인된 조건입니다. 이 조건으로 추가 질문하지 말고, 상품 검색은 이 판매처 범위에서만 진행하세요.`;
};

const askUserToolChoice = {
  type: 'function',
  function: { name: 'askUser' },
};

const searchProductsToolChoice = {
  type: 'function',
  function: { name: 'searchProducts' },
};

const ambiguityAssessmentToolChoice = {
  type: 'function',
  function: { name: 'assessShoppingAmbiguity' },
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
  deepModeState: DeepModeState,
  askUserState: () => AskUser | null,
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
    const deepModeState: DeepModeState = {
      assessment: null,
      assessmentRequired: input.image === null,
      searchedProducts: false,
    };
    let askUser: AskUser | null = null;
    const abortController = new AbortController();
    const assistantMessageId = uuidv7();
    const commandCodeTools = this.createTools(
      tools,
      recommendationState,
      deepModeState,
      input.image === null,
      input.text.trim() === clarificationSkipMessage,
      (value) => {
        askUser = value;
      },
    );
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
    const providerPrompt = providerConstraintPrompt(input.providerIds ?? []);
    const source = chat({
      adapter,
      messages: this.modelMessages(input),
      systemPrompts: providerPrompt
        ? [systemPrompt, providerPrompt]
        : [systemPrompt],
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
          deepModeState,
          () => askUser,
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
    deepModeState: DeepModeState,
    requiresDeepModeAssessment: boolean,
    skipsClarification: boolean,
    setAskUser: (askUser: AskUser) => void,
  ): ReadonlyArray<AnyServerTool> => [
    assessShoppingAmbiguityDefinition.server((input) => {
      const assessment = evaluateShoppingDeepMode(input);
      if (
        assessment.requestKind === 'shopping' &&
        assessment.ambiguityScore !== null &&
        assessment.ambiguityScore > shoppingAmbiguityThreshold &&
        assessment.clarificationDimension === null &&
        !skipsClarification
      ) {
        deepModeState.assessmentRequired = true;
        return {
          kind: 'invalid_ambiguity_assessment' as const,
          ambiguityScore: assessment.ambiguityScore,
          reason:
            '모호성 점수가 임계값보다 높으면 nextDimension으로 다음 질문 축을 지정해야 합니다.',
        };
      }
      deepModeState.assessment = {
        ...assessment,
        clarificationDimension: skipsClarification
          ? null
          : assessment.clarificationDimension,
      };
      return {
        kind: 'shopping_ambiguity_assessment' as const,
        requestKind: deepModeState.assessment.requestKind,
        ambiguityScore: deepModeState.assessment.ambiguityScore,
        clarificationDimension: deepModeState.assessment.clarificationDimension,
      };
    }),
    askUserDefinition.server((input) => {
      if (requiresDeepModeAssessment && !deepModeState.assessment) {
        deepModeState.assessmentRequired = true;
        return {
          kind: 'ambiguity_assessment_required' as const,
          reason: '질문 전에 Deep Mode 평가가 필요합니다.',
        };
      }
      if (deepModeState.assessment?.requestKind === 'other') {
        return {
          kind: 'shopping_not_requested' as const,
          reason: '상품 탐색 요청이 아니므로 추가 조건을 묻지 않습니다.',
        };
      }
      const requiredClarificationDimension =
        deepModeState.assessment?.clarificationDimension ?? null;
      if (
        requiredClarificationDimension &&
        input.dimension !== requiredClarificationDimension
      ) {
        return {
          kind: 'invalid_clarification' as const,
          expectedDimension: requiredClarificationDimension,
          reason:
            '현재 모호성 게이트에서 가장 중요한 조건을 먼저 확인해야 합니다.',
        };
      }
      setAskUser(input);
      return { waitingForUser: true };
    }),
    searchProductsDefinition.server(
      async ({ query, providerId, budgetMax, location }) => {
        if (requiresDeepModeAssessment && !deepModeState.assessment) {
          deepModeState.assessmentRequired = true;
          return {
            kind: 'ambiguity_assessment_required' as const,
            reason: '상품 검색 전에 Deep Mode 평가가 필요합니다.',
          };
        }
        if (deepModeState.assessment?.requestKind === 'other') {
          return {
            kind: 'shopping_not_requested' as const,
            reason: '상품 탐색 요청이 아니므로 상품을 검색하지 않습니다.',
          };
        }
        const requiredClarificationDimension =
          deepModeState.assessment?.clarificationDimension ?? null;
        if (requiredClarificationDimension) {
          return {
            kind: 'clarification_required' as const,
            dimension: requiredClarificationDimension,
            reason: '상품 검색 전에 모호성 게이트의 질문에 답해야 합니다.',
          };
        }
        const result = await session.searchProducts({
          query,
          providerId: providerId ?? 'daiso',
          ...(budgetMax == null ? {} : { budgetMax }),
          ...(location == null ? {} : { location }),
        });
        result.items.forEach(({ id }) =>
          recommendationState.productIds.add(id),
        );
        deepModeState.searchedProducts = true;
        return toAiProductResult(result.items);
      },
    ),
    getProductDefinition.server(async ({ id }) => {
      if (requiresDeepModeAssessment && !deepModeState.assessment) {
        deepModeState.assessmentRequired = true;
        return {
          kind: 'ambiguity_assessment_required' as const,
          reason: '상품 조회 전에 Deep Mode 평가가 필요합니다.',
        };
      }
      if (deepModeState.assessment?.requestKind === 'other') {
        return {
          kind: 'shopping_not_requested' as const,
          reason: '상품 탐색 요청이 아니므로 상품을 조회하지 않습니다.',
        };
      }
      if (deepModeState.assessment?.clarificationDimension) {
        return {
          kind: 'clarification_required' as const,
          dimension: deepModeState.assessment.clarificationDimension,
          reason: '상품 조회 전에 모호성 게이트의 질문에 답해야 합니다.',
        };
      }
      const product = await session.getProduct(id);
      return toAiProductResult(product ? [product] : []);
    }),
    recordProductRecommendationsDefinition.server(({ recommendations }) => {
      if (requiresDeepModeAssessment && !deepModeState.assessment) {
        deepModeState.assessmentRequired = true;
        return {
          kind: 'ambiguity_assessment_required' as const,
          reason: '추천 기록 전에 Deep Mode 평가가 필요합니다.',
        };
      }
      if (deepModeState.assessment?.requestKind === 'other') {
        return {
          kind: 'shopping_not_requested' as const,
          reason: '상품 탐색 요청이 아니므로 추천을 기록하지 않습니다.',
        };
      }
      if (deepModeState.assessment?.clarificationDimension) {
        return {
          kind: 'clarification_required' as const,
          dimension: deepModeState.assessment.clarificationDimension,
          reason: '추천 기록 전에 모호성 게이트의 질문에 답해야 합니다.',
        };
      }
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
