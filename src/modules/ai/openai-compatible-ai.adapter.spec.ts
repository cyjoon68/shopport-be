import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import type { StreamChunk } from '@tanstack/ai';
import { EventType } from '@tanstack/ai';

import type { Environment } from '../../config/environment.js';
import type { CatalogProduct } from '../catalog/types.js';
import { askUserSchema } from './ai-provider-protocol.js';
import type { AiToolSession } from './ai-tools.js';
import { OpenAiCompatibleAiStreamAdapter } from './openai-compatible-ai.adapter.js';
import type { AiStreamLifecycle, AiStreamResult } from './types.js';

const product: CatalogProduct = {
  id: '0198a122-0c00-7000-8000-000000000001',
  providerId: 'test',
  productCode: 'tumbler-1',
  title: '오래 쓰는 스테인리스 텀블러 600ml',
  imageUrl: 'https://example.com/tumbler.jpg',
  affiliate: false,
  relevanceBucket: 3,
  inStock: true,
  totalAmountMinor: '21900',
  deliveryEstimateDays: 1,
  ratingConfidence: 0.96,
  freshnessEpochMs: 1_786_460_400_000,
  outboundUrl: 'https://example.com/products/tumbler',
  store: null,
  inventory: null,
  evidence: [{ operation: 'products', fetchedAt: 1_786_460_400_000 }],
};

const completionChunk = (
  id: string,
  delta: Readonly<Record<string, unknown>>,
  finishReason: string | null,
): Readonly<Record<string, unknown>> => ({
  id,
  object: 'chat.completion.chunk',
  created: 1_786_460_400,
  model: 'gpt-5.4-mini',
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

const streamResponse = (
  chunks: ReadonlyArray<Readonly<Record<string, unknown>>>,
): Response =>
  new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' }, status: 200 },
  );

type AmbiguityAssessmentInput = Readonly<{
  requestKind: 'shopping' | 'other';
  goalClarity: number;
  constraintClarity: number;
  successCriteriaClarity: number;
  nextDimension: 'purpose' | 'budget' | 'requirement' | null;
}>;

const ambiguityAssessmentResponse = (
  id: string,
  input: AmbiguityAssessmentInput,
): Response =>
  streamResponse([
    completionChunk(
      id,
      {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `${id}-assessment`,
            type: 'function',
            function: {
              name: 'assessShoppingAmbiguity',
              arguments: JSON.stringify(input),
            },
          },
        ],
      },
      null,
    ),
    completionChunk(id, {}, 'tool_calls'),
  ]);

const requestBody = async (call: Parameters<typeof fetch>): Promise<string> => {
  const [input, init] = call;
  if (input instanceof Request) return input.clone().text();
  return typeof init?.body === 'string' ? init.body : '';
};

const requestHeaders = (call: Parameters<typeof fetch>): Headers => {
  const [input, init] = call;
  return input instanceof Request
    ? input.headers
    : new Headers(init?.headers ?? {});
};

const requestUrl = (call: Parameters<typeof fetch>): string => {
  const [input] = call;
  return input instanceof Request ? input.url : input.toString();
};

const requiredCall = (
  calls: Array<Parameters<typeof fetch>>,
  index: number,
): Parameters<typeof fetch> => {
  const call = calls.at(index);
  if (!call) throw new Error('Command Code request was not made');
  return call;
};

const deferred = <T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}> => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const testConfig = (): ConfigService<Environment, true> =>
  new ConfigService<Environment, true>({
    PROVIDER_API_KEY: 'key',
    PROVIDER_MODEL: 'gpt-5.4-mini',
    PROVIDER_MAX_OUTPUT_TOKENS: 512,
  });

const emptyTools: AiToolSession = {
  searchProducts: () =>
    Promise.resolve({ items: [], endCursor: null, hasNextPage: false }),
  getProduct: () => Promise.resolve(null),
};

const pendingStream = (
  lifecycle: AiStreamLifecycle,
): Readonly<{
  iterator: AsyncIterator<StreamChunk>;
  providerSignal: () => AbortSignal | undefined;
}> => {
  let signal: AbortSignal | undefined;
  const providerFetch = jest.fn<typeof fetch>((input, init) => {
    const requestSignal =
      input instanceof Request ? input.signal : init?.signal;
    signal = requestSignal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      requestSignal?.addEventListener(
        'abort',
        () => {
          reject(new Error('provider aborted'));
        },
        { once: true },
      );
    });
  });
  return {
    iterator: new OpenAiCompatibleAiStreamAdapter(testConfig(), providerFetch)
      .createStream(
        {
          threadId: 'thread-1',
          runId: 'run-1',
          text: '이미지 설명',
          image: { base64: 'aW1hZ2U=', mimeType: 'image/jpeg' },
        },
        emptyTools,
        lifecycle,
      )
      [Symbol.asyncIterator](),
    providerSignal: () => signal,
  };
};

describe('OpenAiCompatibleAiStreamAdapter', () => {
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
    const searchProducts = jest.fn(() =>
      Promise.resolve({ items: [], endCursor: null, hasNextPage: false }),
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
          Promise.resolve({ items: [], endCursor: null, hasNextPage: false }),
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
      Promise.resolve({ items: [], endCursor: null, hasNextPage: false }),
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
      Promise.resolve({ items: [], endCursor: null, hasNextPage: false }),
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
    const searchProducts = jest.fn(() =>
      Promise.resolve({ items: [], endCursor: null, hasNextPage: false }),
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
