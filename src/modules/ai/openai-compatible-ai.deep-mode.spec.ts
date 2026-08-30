import { describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { EventType, type StreamChunk } from '@tanstack/ai';

import {
  ambiguityAssessmentResponse,
  completionChunk,
  requestBody,
  requiredCall,
  streamResponse,
} from '../../../test/openai-compatible-ai.adapter-test-support.js';
import type { Environment } from '../../config/environment.js';
import type { AiToolSession } from './ai-tools.js';
import { OpenAiCompatibleAiStreamAdapter } from './openai-compatible-ai.adapter.js';
import type { AiStreamResult } from './types.js';

describe('OpenAI-compatible Deep Mode', () => {
  it('forces the LLM through Deep Mode before a category-only recommendation', async () => {
    const providerFetch = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        streamResponse([
          completionChunk(
            'chatcmpl-search',
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call-search',
                  type: 'function',
                  function: {
                    name: 'searchProducts',
                    arguments: JSON.stringify({ query: '립밤' }),
                  },
                },
              ],
            },
            null,
          ),
          completionChunk('chatcmpl-search', {}, 'tool_calls'),
        ]),
      )
      .mockResolvedValueOnce(
        ambiguityAssessmentResponse('chatcmpl-assessment', {
          requestKind: 'shopping',
          goalClarity: 0.6,
          constraintClarity: 0,
          successCriteriaClarity: 0,
          nextDimension: 'purpose',
        }),
      )
      .mockResolvedValueOnce(
        streamResponse([
          completionChunk(
            'chatcmpl-question',
            {
              role: 'assistant',
              content: '추천 전에 확인할게요.',
              tool_calls: [
                {
                  index: 0,
                  id: 'call-question',
                  type: 'function',
                  function: {
                    name: 'askUser',
                    arguments: JSON.stringify({
                      dimension: 'purpose',
                      question: '어디에서 주로 사용할 건가요?',
                      options: [
                        { id: 'home', label: '집' },
                        { id: 'outside', label: '외출' },
                      ],
                      allowFreeText: true,
                    }),
                  },
                },
              ],
            },
            null,
          ),
          completionChunk('chatcmpl-question', {}, 'tool_calls'),
        ]),
      );
    const searchProducts = jest.fn<AiToolSession['searchProducts']>(() =>
      Promise.resolve({
        items: [],
        endCursor: null,
        hasNextPage: false,
        unavailableProviderIds: [],
      }),
    );
    const completed: Array<AiStreamResult> = [];
    const chunks: Array<StreamChunk> = [];
    for await (const chunk of new OpenAiCompatibleAiStreamAdapter(
      new ConfigService<Environment, true>({
        PROVIDER_API_KEY: 'key',
        PROVIDER_MODEL: 'gpt-5.4-mini',
        PROVIDER_MAX_OUTPUT_TOKENS: 512,
      }),
      providerFetch,
    ).createStream(
      {
        threadId: '0198a122-0c00-7000-8000-000000000010',
        runId: '0198a122-0c00-7000-8000-000000000011',
        text: '립밤 추천해줘',
        image: null,
      },
      { searchProducts, getProduct: () => Promise.resolve(null) },
      {
        onComplete: (result): Promise<void> => {
          completed.push(result);
          return Promise.resolve();
        },
        onFailure: () => Promise.resolve(),
        isCancelled: () => Promise.resolve(false),
        renewLease: () => Promise.resolve(),
      },
    )) {
      chunks.push(chunk);
    }

    expect(searchProducts).not.toHaveBeenCalled();
    expect(providerFetch).toHaveBeenCalledTimes(3);
    const initialBody = JSON.parse(
      await requestBody(requiredCall(providerFetch.mock.calls, 0)),
    ) as { tool_choice?: unknown };
    expect(initialBody.tool_choice).toEqual({
      type: 'function',
      function: { name: 'assessShoppingAmbiguity' },
    });
    expect(JSON.stringify(initialBody)).toContain(
      '상품군만 있으면 목표 명확도는 최대 0.6',
    );
    const assessmentBody = JSON.parse(
      await requestBody(requiredCall(providerFetch.mock.calls, 1)),
    ) as { tool_choice?: unknown };
    expect(assessmentBody.tool_choice).toEqual({
      type: 'function',
      function: { name: 'assessShoppingAmbiguity' },
    });
    const questionBody = JSON.parse(
      await requestBody(requiredCall(providerFetch.mock.calls, 2)),
    ) as { tool_choice?: unknown };
    expect(questionBody.tool_choice).toEqual({
      type: 'function',
      function: { name: 'askUser' },
    });
    expect(chunks.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.RUN_FINISHED,
      ]),
    );
    expect(completed).toEqual([
      expect.objectContaining({
        text: '',
        productRecommendations: [],
        askUser: {
          dimension: 'purpose',
          question: '어디에서 주로 사용할 건가요?',
          options: [
            { id: 'home', label: '집' },
            { id: 'outside', label: '외출' },
          ],
          allowFreeText: true,
        },
      }),
    ]);
  });

  it('fails a text response that bypasses the required Deep Mode assessment', async () => {
    const providerFetch = jest
      .fn<typeof fetch>()
      .mockResolvedValue(
        streamResponse([
          completionChunk(
            'chatcmpl-bypass',
            { role: 'assistant', content: '립밤을 추천해요.' },
            null,
          ),
          completionChunk('chatcmpl-bypass', {}, 'stop'),
        ]),
      );
    const completed: Array<AiStreamResult> = [];
    const onFailure = jest.fn(() => Promise.resolve());

    for await (const _chunk of new OpenAiCompatibleAiStreamAdapter(
      new ConfigService<Environment, true>({
        PROVIDER_API_KEY: 'key',
        PROVIDER_MODEL: 'gpt-5.4-mini',
        PROVIDER_MAX_OUTPUT_TOKENS: 512,
      }),
      providerFetch,
    ).createStream(
      {
        threadId: '0198a122-0c00-7000-8000-000000000010',
        runId: '0198a122-0c00-7000-8000-000000000011',
        text: '립밤 추천해줘',
        image: null,
      },
      {
        searchProducts: () =>
          Promise.resolve({
            items: [],
            endCursor: null,
            hasNextPage: false,
            unavailableProviderIds: [],
          }),
        getProduct: () => Promise.resolve(null),
      },
      {
        onComplete: (result): Promise<void> => {
          completed.push(result);
          return Promise.resolve();
        },
        onFailure,
        isCancelled: () => Promise.resolve(false),
        renewLease: () => Promise.resolve(),
      },
    ))
      void _chunk;

    const initialBody = JSON.parse(
      await requestBody(requiredCall(providerFetch.mock.calls, 0)),
    ) as { tool_choice?: unknown };
    expect(initialBody.tool_choice).toEqual({
      type: 'function',
      function: { name: 'assessShoppingAmbiguity' },
    });
    expect(completed).toEqual([]);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('allows a normal reply after the LLM classifies a text request as other', async () => {
    const providerFetch = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        ambiguityAssessmentResponse('chatcmpl-other-assessment', {
          requestKind: 'other',
          goalClarity: 1,
          constraintClarity: 1,
          successCriteriaClarity: 1,
          nextDimension: null,
        }),
      )
      .mockResolvedValueOnce(
        streamResponse([
          completionChunk(
            'chatcmpl-other-answer',
            { role: 'assistant', content: '안녕하세요.' },
            null,
          ),
          completionChunk('chatcmpl-other-answer', {}, 'stop'),
        ]),
      );
    const searchProducts = jest.fn(() =>
      Promise.resolve({
        items: [],
        endCursor: null,
        hasNextPage: false,
        unavailableProviderIds: [],
      }),
    );
    const completed: Array<AiStreamResult> = [];

    for await (const _chunk of new OpenAiCompatibleAiStreamAdapter(
      new ConfigService<Environment, true>({
        PROVIDER_API_KEY: 'key',
        PROVIDER_MODEL: 'gpt-5.4-mini',
        PROVIDER_MAX_OUTPUT_TOKENS: 512,
      }),
      providerFetch,
    ).createStream(
      {
        threadId: '0198a122-0c00-7000-8000-000000000010',
        runId: '0198a122-0c00-7000-8000-000000000011',
        text: '안녕',
        image: null,
      },
      { searchProducts, getProduct: () => Promise.resolve(null) },
      {
        onComplete: (result): Promise<void> => {
          completed.push(result);
          return Promise.resolve();
        },
        onFailure: () => Promise.resolve(),
        isCancelled: () => Promise.resolve(false),
        renewLease: () => Promise.resolve(),
      },
    ))
      void _chunk;

    expect(searchProducts).not.toHaveBeenCalled();
    expect(completed).toEqual([
      expect.objectContaining({
        text: '안녕하세요.',
        askUser: null,
        productRecommendations: [],
      }),
    ]);
  });

  it('asks the next most impactful condition while a follow-up remains ambiguous', async () => {
    const providerFetch = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        ambiguityAssessmentResponse('chatcmpl-follow-up-assessment', {
          requestKind: 'shopping',
          goalClarity: 1,
          constraintClarity: 0,
          successCriteriaClarity: 0,
          nextDimension: 'budget',
        }),
      )
      .mockResolvedValueOnce(
        streamResponse([
          completionChunk(
            'chatcmpl-follow-up-question',
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call-budget-question',
                  type: 'function',
                  function: {
                    name: 'askUser',
                    arguments: JSON.stringify({
                      dimension: 'budget',
                      question: '예산은 어느 정도로 볼까요?',
                      options: [
                        { id: 'under-3000', label: '3천원 이하' },
                        { id: 'under-5000', label: '5천원 이하' },
                      ],
                      allowFreeText: true,
                    }),
                  },
                },
              ],
            },
            null,
          ),
          completionChunk('chatcmpl-follow-up-question', {}, 'tool_calls'),
        ]),
      );
    const searchProducts = jest.fn(() =>
      Promise.resolve({
        items: [],
        endCursor: null,
        hasNextPage: false,
        unavailableProviderIds: [],
      }),
    );
    const completed: Array<AiStreamResult> = [];

    for await (const _chunk of new OpenAiCompatibleAiStreamAdapter(
      new ConfigService<Environment, true>({
        PROVIDER_API_KEY: 'key',
        PROVIDER_MODEL: 'gpt-5.4-mini',
        PROVIDER_MAX_OUTPUT_TOKENS: 512,
      }),
      providerFetch,
    ).createStream(
      {
        threadId: '0198a122-0c00-7000-8000-000000000010',
        runId: '0198a122-0c00-7000-8000-000000000011',
        text: '외출할 때 쓸 거야',
        history: [
          { role: 'user', text: '립밤 추천해줘' },
          { role: 'assistant', text: '어디에서 주로 사용할 건가요?' },
          { role: 'user', text: '외출할 때 쓸 거야' },
        ],
        image: null,
      },
      { searchProducts, getProduct: () => Promise.resolve(null) },
      {
        onComplete: (result): Promise<void> => {
          completed.push(result);
          return Promise.resolve();
        },
        onFailure: () => Promise.resolve(),
        isCancelled: () => Promise.resolve(false),
        renewLease: () => Promise.resolve(),
      },
    ))
      void _chunk;

    expect(searchProducts).not.toHaveBeenCalled();
    expect(completed[0]?.askUser).toEqual(
      expect.objectContaining({ dimension: 'budget' }),
    );
  });

  it('searches after assessment when the user explicitly skips clarification', async () => {
    const providerFetch = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        ambiguityAssessmentResponse('chatcmpl-skip-assessment', {
          requestKind: 'shopping',
          goalClarity: 0.6,
          constraintClarity: 0,
          successCriteriaClarity: 0,
          nextDimension: 'purpose',
        }),
      )
      .mockResolvedValueOnce(
        streamResponse([
          completionChunk(
            'chatcmpl-skip-search',
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call-skip-search',
                  type: 'function',
                  function: {
                    name: 'searchProducts',
                    arguments: JSON.stringify({ query: '립밤' }),
                  },
                },
              ],
            },
            null,
          ),
          completionChunk('chatcmpl-skip-search', {}, 'tool_calls'),
        ]),
      )
      .mockResolvedValueOnce(
        streamResponse([
          completionChunk(
            'chatcmpl-skip-answer',
            { role: 'assistant', content: '조건에 맞는 상품을 찾지 못했어요.' },
            null,
          ),
          completionChunk('chatcmpl-skip-answer', {}, 'stop'),
        ]),
      );
    const searchProducts = jest.fn<AiToolSession['searchProducts']>(() =>
      Promise.resolve({
        items: [],
        endCursor: null,
        hasNextPage: false,
        unavailableProviderIds: [],
      }),
    );
    const completed: Array<AiStreamResult> = [];

    for await (const _chunk of new OpenAiCompatibleAiStreamAdapter(
      new ConfigService<Environment, true>({
        PROVIDER_API_KEY: 'key',
        PROVIDER_MODEL: 'gpt-5.4-mini',
        PROVIDER_MAX_OUTPUT_TOKENS: 512,
      }),
      providerFetch,
    ).createStream(
      {
        threadId: '0198a122-0c00-7000-8000-000000000010',
        runId: '0198a122-0c00-7000-8000-000000000011',
        text: '질문을 건너뛰고 현재 정보로 계속 진행해줘.',
        image: null,
      },
      { searchProducts, getProduct: () => Promise.resolve(null) },
      {
        onComplete: (result): Promise<void> => {
          completed.push(result);
          return Promise.resolve();
        },
        onFailure: () => Promise.resolve(),
        isCancelled: () => Promise.resolve(false),
        renewLease: () => Promise.resolve(),
      },
    ))
      void _chunk;

    expect(searchProducts).toHaveBeenCalledWith({
      query: '립밤',
      providerId: 'daiso',
    });
    expect(completed[0]?.askUser).toBeNull();
  });
});
