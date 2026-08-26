import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AnyServerTool,
  ContentPart,
  ModelMessage,
  StreamChunk,
} from '@tanstack/ai';
import { chat, maxIterations } from '@tanstack/ai';
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import { v7 as uuidv7 } from 'uuid';

import type { Environment } from '../../config/environment.js';
import {
  askUserDefinition,
  assessShoppingAmbiguityDefinition,
  clarificationSkipMessage,
  conversationTitlePrompt,
  type DeepModeState,
  expectedProductIds,
  getProductDefinition,
  matchesExpectedProducts,
  normalizeConversationTitle,
  type ProductRecommendationState,
  providerConstraintPrompt,
  recordProductRecommendationsDefinition,
  searchProductsDefinition,
  systemPrompt,
} from './ai-provider-protocol.js';
import type { AiStreamAdapter } from './ai-stream.adapter.js';
import {
  createLifecycleMiddleware,
  createPublicStream,
  createTerminalState,
} from './ai-stream-lifecycle.js';
import { toAiProductResult } from './ai-tool-result.js';
import type { AiToolSession } from './ai-tools.js';
import {
  evaluateShoppingDeepMode,
  shoppingAmbiguityThreshold,
} from './shopping-deep-mode.js';
import type { AiStreamInput, AiStreamLifecycle, AskUser } from './types.js';

export const AI_PROVIDER_FETCH = Symbol('AI_PROVIDER_FETCH');

const providerBaseUrl = 'https://api.commandcode.ai/provider/v1';
const providerTimeoutMilliseconds = 45_000;

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
    this.#apiKey = config.get('PROVIDER_API_KEY', { infer: true });
    this.#model = config.get('PROVIDER_MODEL', { infer: true });
    this.#maxOutputTokens = config.get('PROVIDER_MAX_OUTPUT_TOKENS', {
      infer: true,
    });
  }

  public generateTitle = async (prompt: string): Promise<string> => {
    const title = await chat({
      adapter: this.createTextAdapter(),
      messages: [{ role: 'user', content: prompt }],
      systemPrompts: [conversationTitlePrompt],
      modelOptions: { max_completion_tokens: 48 },
      stream: false,
      debug: false,
    });
    return normalizeConversationTitle(title);
  };

  public createStream = (
    input: AiStreamInput,
    tools: AiToolSession,
    lifecycle: AiStreamLifecycle,
  ): AsyncIterable<StreamChunk> => {
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
    const providerTools = this.createTools(
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
    const adapter = this.createTextAdapter();
    const providerPrompt = providerConstraintPrompt(input.providerIds ?? []);
    const lifecycleMiddleware = createLifecycleMiddleware(
      abortController,
      lifecycle,
      terminal,
      recommendationState,
      deepModeState,
      () => askUser,
      assistantMessageId,
    );
    const source = chat({
      adapter,
      messages: this.modelMessages(input),
      systemPrompts: providerPrompt
        ? [systemPrompt, providerPrompt]
        : [systemPrompt],
      tools: providerTools,
      modelOptions: {
        max_completion_tokens: this.#maxOutputTokens,
      },
      abortController,
      agentLoopStrategy: maxIterations(5),
      threadId: input.threadId,
      runId: input.runId,
      middleware: [lifecycleMiddleware],
      debug: false,
    });
    return createPublicStream(
      source,
      input,
      abortController,
      terminal,
      assistantMessageId,
      lifecycleMiddleware.stop,
    );
  };

  private readonly createTextAdapter = (): ReturnType<
    typeof openaiCompatibleText
  > => {
    if (!this.#apiKey) throw new Error('PROVIDER_API_KEY is required');
    return openaiCompatibleText(this.#model, {
      name: 'commandcode',
      apiKey: this.#apiKey,
      baseURL: providerBaseUrl,
      defaultHeaders: { 'x-cmd-zdr': '1' },
      fetch: this.providerFetch,
      maxRetries: 1,
      timeout: providerTimeoutMilliseconds,
    });
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
