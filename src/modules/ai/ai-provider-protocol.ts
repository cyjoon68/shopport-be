import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { toolDefinition } from '@tanstack/ai';
import { z } from 'zod';

import type { AiProviderId } from './ai-request.js';
import type { ShoppingDeepModeAssessment } from './shopping-deep-mode.js';
import { shoppingRequestKinds } from './shopping-deep-mode.js';
import {
  type AiProductRecommendation,
  type AiStreamResult,
  type AskUser,
  clarificationDimensions,
} from './types.js';

export const clarificationSkipMessage =
  '질문을 건너뛰고 현재 정보로 계속 진행해줘.';
const conversationTitleLength = 24;
export const conversationTitlePrompt =
  '사용자의 첫 쇼핑 질문을 Drawer용 한국어 대화 제목으로 바꾸세요. 제목만 출력하고, 공백 포함 12~24자의 명사형으로 핵심 상품과 목적을 표현하며 자연스러운 한국어 띄어쓰기를 지키세요. 원문 인용, 설명, 접두어, 따옴표, 마침표는 쓰지 마세요.';

export const normalizeConversationTitle = (value: string): string => {
  const title = value
    .trim()
    .replace(/^["'“”‘’「」『』]+/gu, '')
    .replace(/\s+/gu, ' ')
    .split(/["'“”‘’「」『』:：]/u)[0]
    ?.replace(/[.!?]+$/gu, '')
    .trim();
  if (!title) throw new Error('Conversation title is empty');
  return Array.from(title).slice(0, conversationTitleLength).join('');
};

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

export const askUserDefinition = toolDefinition({
  name: 'askUser',
  description:
    '추천 결과를 크게 바꾸는 지정된 조건 하나를 dimension에 기록하고, 짧은 한국어 질문과 2~4개 선택지로 확인합니다. 사용자가 선택하거나 자유 입력으로 답할 때까지 상품을 검색하거나 추천하지 않습니다.',
  inputSchema: askUserSchema,
});

export const assessShoppingAmbiguityDefinition = toolDefinition({
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

export const searchProductsDefinition = toolDefinition({
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

export const getProductDefinition = toolDefinition({
  name: 'getProduct',
  description: '상품 ID로 승인된 provider의 최신 상품 카드를 조회합니다.',
  inputSchema: z.object({ id: z.uuid() }),
});

export const recordProductRecommendationsDefinition = toolDefinition({
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

export type ProductRecommendationState = {
  productIds: Set<string>;
  aiSummaries: Map<string, string>;
};

export type DeepModeState = {
  assessment: ShoppingDeepModeAssessment | null;
  assessmentRequired: boolean;
  searchedProducts: boolean;
};

const recommendationToolChoice = {
  type: 'function',
  function: { name: 'recordProductRecommendations' },
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

export const providerConstraintPrompt = (
  providerIds: ReadonlyArray<AiProviderId>,
): string | null => {
  if (providerIds.length === 0) return null;
  const names = providerIds
    .map((providerId) => (providerId === 'oliveyoung' ? '올리브영' : '다이소'))
    .join(', ');
  return `이번 요청의 판매처 조건은 ${names}이며 이미 확인된 조건입니다. 이 조건으로 추가 질문하지 말고, 상품 검색은 이 판매처 범위에서만 진행하세요.`;
};

export const expectedProductIds = (
  state: ProductRecommendationState,
): ReadonlyArray<string> => [...state.productIds];

const recommendationsComplete = (state: ProductRecommendationState): boolean =>
  state.productIds.size === 0 ||
  expectedProductIds(state).every((productId) =>
    state.aiSummaries.has(productId),
  );

const productRecommendations = (
  state: ProductRecommendationState,
): ReadonlyArray<AiProductRecommendation> =>
  expectedProductIds(state).flatMap((productId) => {
    const aiSummary = state.aiSummaries.get(productId);
    return aiSummary ? [{ productId, aiSummary }] : [];
  });

export const nextToolChoice = (
  recommendationState: ProductRecommendationState,
  deepModeState: DeepModeState,
  askUser: AskUser | null,
):
  | typeof ambiguityAssessmentToolChoice
  | typeof askUserToolChoice
  | typeof searchProductsToolChoice
  | typeof recommendationToolChoice
  | null => {
  if (askUser) return null;
  if (deepModeState.assessmentRequired && !deepModeState.assessment) {
    return ambiguityAssessmentToolChoice;
  }
  if (deepModeState.assessment?.clarificationDimension) {
    return askUserToolChoice;
  }
  if (
    deepModeState.assessment?.requestKind === 'shopping' &&
    !deepModeState.searchedProducts
  ) {
    return searchProductsToolChoice;
  }
  return recommendationsComplete(recommendationState)
    ? null
    : recommendationToolChoice;
};

export const providerStreamResult = (
  finishReason: string | null,
  content: string,
  recommendationState: ProductRecommendationState,
  deepModeState: DeepModeState,
  askUser: AskUser | null,
  assistantMessageId: string,
): AiStreamResult | null => {
  const text = content.trim();
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
      finishReason !== 'stop' ||
      text.length === 0 ||
      !recommendationsComplete(recommendationState))
  ) {
    return null;
  }
  return {
    messageId: assistantMessageId,
    text: askUser ? '' : text,
    productRecommendations: askUser
      ? []
      : productRecommendations(recommendationState),
    askUser,
  };
};

export const matchesExpectedProducts = (
  recommendations: ReadonlyArray<AiProductRecommendation>,
  state: ProductRecommendationState,
): boolean => {
  const productIds = expectedProductIds(state);
  return (
    recommendations.length === productIds.length &&
    recommendations.every(
      ({ productId, aiSummary }, index) =>
        productId === productIds[index] &&
        aiSummary.length >= 20 &&
        aiSummary.includes('추천'),
    )
  );
};

const harnessPath = fileURLToPath(
  new URL('./shopping-ai-harness.md', import.meta.url),
);
export const systemPrompt = readFileSync(harnessPath, 'utf8');
