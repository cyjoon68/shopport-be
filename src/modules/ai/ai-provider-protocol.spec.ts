import { describe, expect, it } from '@jest/globals';

import {
  askUserSchema,
  type DeepModeState,
  nextToolChoice,
  normalizeConversationTitle,
  type ProductRecommendationState,
} from './ai-provider-protocol.js';

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

describe('AI provider protocol', () => {
  it('validates structured clarification arguments', () => {
    expect(
      askUserSchema.parse({
        dimension: 'purpose',
        question: '무엇을 가장 중요하게 보세요?',
        options: [
          { id: 'price', label: '가격' },
          { id: 'quality', label: '품질' },
        ],
        allowFreeText: true,
      }).question,
    ).toBe('무엇을 가장 중요하게 보세요?');
    expect(() =>
      askUserSchema.parse({
        dimension: 'budget',
        question: '무엇을 가장 중요하게 보세요?',
        options: [
          { id: 'same', label: '가격' },
          { id: 'same', label: '품질' },
        ],
        allowFreeText: true,
      }),
    ).toThrow();
  });

  it('normalizes a quoted multiline title to twenty-four characters', () => {
    expect(
      normalizeConversationTitle(
        '  “지성 피부에 맞는\n쿠션 파운데이션 추천입니다. 추가 설명”  ',
      ),
    ).toBe('지성 피부에 맞는 쿠션 파운데이션 추천입니다');
  });

  it('progresses tool choice through assessment, clarification, search, and recommendations', () => {
    const { recommendationState, deepModeState } = states();

    expect(nextToolChoice(recommendationState, deepModeState, null)).toEqual({
      type: 'function',
      function: { name: 'assessShoppingAmbiguity' },
    });
    deepModeState.assessment = {
      requestKind: 'shopping',
      ambiguityScore: 0.4,
      clarificationDimension: 'purpose',
    };
    expect(nextToolChoice(recommendationState, deepModeState, null)).toEqual({
      type: 'function',
      function: { name: 'askUser' },
    });
    deepModeState.assessment = {
      requestKind: 'shopping',
      ambiguityScore: 0,
      clarificationDimension: null,
    };
    expect(nextToolChoice(recommendationState, deepModeState, null)).toEqual({
      type: 'function',
      function: { name: 'searchProducts' },
    });
    deepModeState.searchedProducts = true;
    recommendationState.productIds.add('product-1');
    expect(nextToolChoice(recommendationState, deepModeState, null)).toEqual({
      type: 'function',
      function: { name: 'recordProductRecommendations' },
    });
    recommendationState.aiSummaries.set(
      'product-1',
      '상품 특징이 요청한 조건에 잘 맞기 때문에 추천합니다.',
    );
    expect(nextToolChoice(recommendationState, deepModeState, null)).toBeNull();
  });
});
