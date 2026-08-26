import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import type { StreamChunk } from '@tanstack/ai';
import { EventType } from '@tanstack/ai';

import type { Environment } from '../../config/environment.js';
import type { CatalogProduct } from '../catalog/types.js';
import type { AiToolSession } from './ai-tools.js';
import {
  ambiguityAssessmentResponse,
  completionChunk,
  product,
  requestBody,
  requestHeaders,
  requestUrl,
  requiredCall,
  streamResponse,
} from '../../../test/openai-compatible-ai.adapter-test-support.js';
import { OpenAiCompatibleAiStreamAdapter } from './openai-compatible-ai.adapter.js';
import type { AiStreamResult } from './types.js';

describe('OpenAiCompatibleAiStreamAdapter', () => {
  it('summarizes a prompt as a single-line conversation title', async () => {
    const providerFetch = jest.fn<typeof fetch>().mockResolvedValue(
      streamResponse([
        completionChunk(
          'chatcmpl-title',
          {
            role: 'assistant',
            content: '“지성 피부에 맞는\n쿠션 파운데이션 추천.”',
          },
          null,
        ),
        completionChunk('chatcmpl-title', {}, 'stop'),
      ]),
    );
    const adapter = new OpenAiCompatibleAiStreamAdapter(
      new ConfigService<Environment, true>({
        PROVIDER_API_KEY: 'key',
        PROVIDER_MODEL: 'gpt-5.4-mini',
        PROVIDER_MAX_OUTPUT_TOKENS: 512,
      }),
      providerFetch,
    );

    await expect(
      adapter.generateTitle('지성 피부에 맞는 쿠션 파데 추천해줘'),
    ).resolves.toBe('지성 피부에 맞는 쿠션 파운데이션 추천');
    const body = await requestBody(requiredCall(providerFetch.mock.calls, 0));
    expect(body).toContain('Drawer용 한국어 대화 제목');
  });

  it('passes trusted history to the provider in order', async () => {
    const providerFetch = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        ambiguityAssessmentResponse('chatcmpl-history-assessment', {
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
            'chatcmpl-history',
            { role: 'assistant', content: '5만원 기준으로 찾아볼게요.' },
            null,
          ),
          completionChunk('chatcmpl-history', {}, 'stop'),
        ]),
      );
    const config = new ConfigService<Environment, true>({
      PROVIDER_API_KEY: 'key',
      PROVIDER_MODEL: 'gpt-5.4-mini',
      PROVIDER_MAX_OUTPUT_TOKENS: 512,
    });
    const tools: AiToolSession = {
      searchProducts: () =>
        Promise.resolve({ items: [], endCursor: null, hasNextPage: false }),
      getProduct: () => Promise.resolve(null),
    };
    for await (const _chunk of new OpenAiCompatibleAiStreamAdapter(
      config,
      providerFetch,
    ).createStream(
      {
        threadId: '0198a122-0c00-7000-8000-000000000010',
        runId: '0198a122-0c00-7000-8000-000000000011',
        text: '5만원 이하',
        history: [
          { role: 'user', text: '텀블러를 추천해줘' },
          { role: 'assistant', text: '예산은 어느 정도인가요?' },
          { role: 'user', text: '5만원 이하' },
        ],
        image: null,
      },
      tools,
      {
        onComplete: () => Promise.resolve(),
        onFailure: () => Promise.resolve(),
        isCancelled: () => Promise.resolve(false),
        renewLease: () => Promise.resolve(),
      },
    ))
      void _chunk;
    const body = JSON.parse(
      await requestBody(requiredCall(providerFetch.mock.calls, 0)),
    ) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages.slice(-3)).toEqual([
      expect.objectContaining({ role: 'user', content: '텀블러를 추천해줘' }),
      expect.objectContaining({
        role: 'assistant',
        content: '예산은 어느 정도인가요?',
      }),
      expect.objectContaining({ role: 'user', content: '5만원 이하' }),
    ]);
  });

  it('normalizes nullable search input and streams the AI summary response', async () => {
    const providerFetch = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        streamResponse([
          completionChunk(
            'chatcmpl-tool',
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call-search',
                  type: 'function',
                  function: {
                    name: 'searchProducts',
                    arguments: JSON.stringify({
                      query: '텀블러',
                      providerId: 'daiso',
                      budgetMax: null,
                      location: null,
                    }),
                  },
                },
              ],
            },
            null,
          ),
          completionChunk('chatcmpl-tool', {}, 'tool_calls'),
        ]),
      )
      .mockResolvedValueOnce(
        streamResponse([
          completionChunk(
            'chatcmpl-recommendations',
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call-recommendations',
                  type: 'function',
                  function: {
                    name: 'recordProductRecommendations',
                    arguments: JSON.stringify({
                      recommendations: [
                        {
                          productId: product.id,
                          aiSummary:
                            '600ml 스테인리스 텀블러라 오래 쓰기 좋고 예산 안이기 때문에 추천해요.',
                        },
                      ],
                    }),
                  },
                },
              ],
            },
            null,
          ),
          completionChunk('chatcmpl-recommendations', {}, 'tool_calls'),
        ]),
      )
      .mockResolvedValueOnce(
        streamResponse([
          completionChunk(
            'chatcmpl-answer',
            { role: 'assistant', content: '이 텀블러는 총액이 21,900원이고 ' },
            null,
          ),
          completionChunk(
            'chatcmpl-answer',
            { content: '재고가 있어요.' },
            null,
          ),
          completionChunk('chatcmpl-answer', {}, 'stop'),
        ]),
      );
    const config = new ConfigService<Environment, true>({
      PROVIDER_API_KEY: 'test-provider-key',
      PROVIDER_MODEL: 'gpt-5.4-mini',
      PROVIDER_MAX_OUTPUT_TOKENS: 512,
    });
    const searchProducts = jest.fn(() =>
      Promise.resolve({
        items: [product],
        endCursor: null,
        hasNextPage: false,
      }),
    );
    const tools: AiToolSession = {
      searchProducts,
      getProduct: () => Promise.resolve(null),
    };
    const completed: Array<AiStreamResult> = [];
    const onFailure = jest.fn(() => Promise.resolve());
    const adapter = new OpenAiCompatibleAiStreamAdapter(config, providerFetch);
    const chunks: Array<StreamChunk> = [];

    for await (const chunk of adapter.createStream(
      {
        threadId: '0198a122-0c00-7000-8000-000000000010',
        runId: '0198a122-0c00-7000-8000-000000000011',
        text: '사진 같은 텀블러를 찾아줘',
        image: { base64: 'aW1hZ2U=', mimeType: 'image/jpeg' },
      },
      tools,
      {
        onComplete: (result): Promise<void> => {
          completed.push(result);
          return Promise.resolve();
        },
        onFailure,
        isCancelled: () => Promise.resolve(false),
        renewLease: () => Promise.resolve(),
      },
    )) {
      chunks.push(chunk);
    }

    expect(providerFetch).toHaveBeenCalledTimes(3);
    const firstCall = requiredCall(providerFetch.mock.calls, 0);
    expect(requestUrl(firstCall)).toBe(
      'https://api.commandcode.ai/provider/v1/chat/completions',
    );
    expect(requestHeaders(firstCall).get('authorization')).toBe(
      'Bearer test-provider-key',
    );
    expect(requestHeaders(firstCall).get('x-cmd-zdr')).toBe('1');
    const firstBody = await requestBody(firstCall);
    expect(firstBody).toContain('data:image/jpeg;base64,aW1hZ2U=');
    expect(firstBody).toContain('askUser');
    const recommendationsBody = JSON.parse(
      await requestBody(requiredCall(providerFetch.mock.calls, 1)),
    ) as { tool_choice?: unknown };
    expect(recommendationsBody.tool_choice).toEqual({
      type: 'function',
      function: { name: 'recordProductRecommendations' },
    });
    expect(searchProducts).toHaveBeenCalledWith({
      query: '텀블러',
      providerId: 'daiso',
    });
    expect(chunks.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        EventType.RUN_STARTED,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_RESULT,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.RUN_FINISHED,
      ]),
    );
    expect(completed).toEqual([
      expect.objectContaining({
        text: '이 텀블러는 총액이 21,900원이고 재고가 있어요.',
        productRecommendations: [
          {
            productId: product.id,
            aiSummary:
              '600ml 스테인리스 텀블러라 오래 쓰기 좋고 예산 안이기 때문에 추천해요.',
          },
        ],
        askUser: null,
      }),
    ]);
    expect(
      chunks.flatMap((chunk) =>
        chunk.type === EventType.TEXT_MESSAGE_START ? [chunk.messageId] : [],
      ),
    ).toContain(completed[0]?.messageId);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('forces a corrected recommendation record before completing', async () => {
    const providerFetch = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        ambiguityAssessmentResponse('chatcmpl-assessment', {
          requestKind: 'shopping',
          goalClarity: 1,
          constraintClarity: 1,
          successCriteriaClarity: 1,
          nextDimension: null,
        }),
      )
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
                    arguments: JSON.stringify({ query: '텀블러' }),
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
        streamResponse([
          completionChunk(
            'chatcmpl-invalid-recommendations',
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call-invalid-recommendations',
                  type: 'function',
                  function: {
                    name: 'recordProductRecommendations',
                    arguments: JSON.stringify({
                      recommendations: [
                        {
                          productId: '0198a122-0c00-7000-8000-000000000002',
                          aiSummary:
                            '600ml 스테인리스 텀블러라 오래 쓰기 좋기 때문에 추천해요.',
                        },
                      ],
                    }),
                  },
                },
              ],
            },
            null,
          ),
          completionChunk('chatcmpl-invalid-recommendations', {}, 'tool_calls'),
        ]),
      )
      .mockResolvedValueOnce(
        streamResponse([
          completionChunk(
            'chatcmpl-valid-recommendations',
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call-valid-recommendations',
                  type: 'function',
                  function: {
                    name: 'recordProductRecommendations',
                    arguments: JSON.stringify({
                      recommendations: [
                        {
                          productId: product.id,
                          aiSummary:
                            '600ml 스테인리스 텀블러라 오래 쓰기 좋기 때문에 추천해요.',
                        },
                      ],
                    }),
                  },
                },
              ],
            },
            null,
          ),
          completionChunk('chatcmpl-valid-recommendations', {}, 'tool_calls'),
        ]),
      )
      .mockResolvedValueOnce(
        streamResponse([
          completionChunk(
            'chatcmpl-final',
            { role: 'assistant', content: '조건에 맞는 텀블러를 찾았어요.' },
            null,
          ),
          completionChunk('chatcmpl-final', {}, 'stop'),
        ]),
      );
    const config = new ConfigService<Environment, true>({
      PROVIDER_API_KEY: 'test-provider-key',
      PROVIDER_MODEL: 'gpt-5.4-mini',
      PROVIDER_MAX_OUTPUT_TOKENS: 512,
    });
    const completed: Array<AiStreamResult> = [];

    for await (const _chunk of new OpenAiCompatibleAiStreamAdapter(
      config,
      providerFetch,
    ).createStream(
      {
        threadId: '0198a122-0c00-7000-8000-000000000010',
        runId: '0198a122-0c00-7000-8000-000000000011',
        text: '출근할 때 쓸 텀블러를 찾아줘',
        image: null,
      },
      {
        searchProducts: () =>
          Promise.resolve({
            items: [product],
            endCursor: null,
            hasNextPage: false,
          }),
        getProduct: () => Promise.resolve(null),
      },
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

    expect(providerFetch).toHaveBeenCalledTimes(5);
    const correctedBody = JSON.parse(
      await requestBody(requiredCall(providerFetch.mock.calls, 3)),
    ) as { tool_choice?: unknown };
    expect(correctedBody.tool_choice).toEqual({
      type: 'function',
      function: { name: 'recordProductRecommendations' },
    });
    expect(completed[0]?.productRecommendations).toEqual([
      {
        productId: product.id,
        aiSummary: '600ml 스테인리스 텀블러라 오래 쓰기 좋기 때문에 추천해요.',
      },
    ]);
  });

  it('fails without saving duplicate and missing recommendations', async () => {
    const secondProduct = {
      ...product,
      id: '0198a122-0c00-7000-8000-000000000002',
      productCode: 'tumbler-2',
    };
    const providerFetch = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        ambiguityAssessmentResponse('chatcmpl-assessment', {
          requestKind: 'shopping',
          goalClarity: 1,
          constraintClarity: 1,
          successCriteriaClarity: 1,
          nextDimension: null,
        }),
      )
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
                    arguments: JSON.stringify({ query: '텀블러' }),
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
        streamResponse([
          completionChunk(
            'chatcmpl-invalid-recommendations',
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call-invalid-recommendations',
                  type: 'function',
                  function: {
                    name: 'recordProductRecommendations',
                    arguments: JSON.stringify({
                      recommendations: [
                        {
                          productId: product.id,
                          aiSummary:
                            '600ml 스테인리스 텀블러라 오래 쓰기 좋기 때문에 추천해요.',
                        },
                        {
                          productId: product.id,
                          aiSummary:
                            '600ml 스테인리스 텀블러라 오래 쓰기 좋기 때문에 추천해요.',
                        },
                      ],
                    }),
                  },
                },
              ],
            },
            null,
          ),
          completionChunk('chatcmpl-invalid-recommendations', {}, 'tool_calls'),
        ]),
      )
      .mockResolvedValueOnce(
        streamResponse([
          completionChunk(
            'chatcmpl-incomplete',
            { role: 'assistant', content: '조건에 맞는 텀블러를 찾았어요.' },
            null,
          ),
          completionChunk('chatcmpl-incomplete', {}, 'stop'),
        ]),
      );
    const config = new ConfigService<Environment, true>({
      PROVIDER_API_KEY: 'test-provider-key',
      PROVIDER_MODEL: 'gpt-5.4-mini',
      PROVIDER_MAX_OUTPUT_TOKENS: 512,
    });
    const completed: Array<AiStreamResult> = [];
    const onFailure = jest.fn(() => Promise.resolve());
    const chunks: Array<StreamChunk> = [];

    for await (const chunk of new OpenAiCompatibleAiStreamAdapter(
      config,
      providerFetch,
    ).createStream(
      {
        threadId: '0198a122-0c00-7000-8000-000000000010',
        runId: '0198a122-0c00-7000-8000-000000000011',
        text: '출근할 때 쓸 텀블러를 찾아줘',
        image: null,
      },
      {
        searchProducts: () =>
          Promise.resolve({
            items: [product, secondProduct],
            endCursor: null,
            hasNextPage: false,
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
    )) {
      chunks.push(chunk);
    }

    expect(providerFetch).toHaveBeenCalledTimes(4);
    const retryBody = await requestBody(
      requiredCall(providerFetch.mock.calls, 3),
    );
    expect(retryBody).toContain(product.id);
    expect(retryBody).toContain(secondProduct.id);
    const retryOptions = JSON.parse(retryBody) as { tool_choice?: unknown };
    expect(retryOptions.tool_choice).toEqual({
      type: 'function',
      function: { name: 'recordProductRecommendations' },
    });
    expect(completed).toEqual([]);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(chunks.at(-1)).toEqual(
      expect.objectContaining({ type: EventType.RUN_ERROR }),
    );
  });

  it('sanitizes provider failures and releases the reserved run', async () => {
    const providerFetch = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: 'upstream detail',
            type: 'server_error',
            code: 'upstream_failure',
          },
        }),
        { headers: { 'content-type': 'application/json' }, status: 500 },
      ),
    );
    const config = new ConfigService<Environment, true>({
      PROVIDER_API_KEY: 'test-provider-key',
      PROVIDER_MODEL: 'gpt-5.4-mini',
      PROVIDER_MAX_OUTPUT_TOKENS: 512,
    });
    const tools: AiToolSession = {
      searchProducts: () =>
        Promise.resolve({ items: [], endCursor: null, hasNextPage: false }),
      getProduct: () => Promise.resolve(null),
    };
    const onFailure = jest.fn(() => Promise.resolve());
    const chunks: Array<StreamChunk> = [];

    for await (const chunk of new OpenAiCompatibleAiStreamAdapter(
      config,
      providerFetch,
    ).createStream(
      {
        threadId: '0198a122-0c00-7000-8000-000000000010',
        runId: '0198a122-0c00-7000-8000-000000000011',
        text: '텀블러',
        image: null,
      },
      tools,
      {
        onComplete: () => Promise.resolve(),
        onFailure,
        isCancelled: () => Promise.resolve(false),
        renewLease: () => Promise.resolve(),
      },
    )) {
      chunks.push(chunk);
    }

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(chunks.at(-1)).toEqual(
      expect.objectContaining({
        type: EventType.RUN_ERROR,
        message: 'AI provider request failed',
        code: 'AI_PROVIDER_ERROR',
      }),
    );
    expect(JSON.stringify(chunks)).not.toContain('upstream detail');
  });
});
