import { ConfigService } from '@nestjs/config';
import { jest } from '@jest/globals';
import { EventType } from '@tanstack/ai';
import type { StreamChunk } from '@tanstack/ai';
import type { Environment } from '../../config/environment.js';
import type { CatalogProduct } from '../catalog/types.js';
import type { AiStreamResult } from './ai-stream.adapter.js';
import type { AiToolSession } from './ai-tools.js';
import { CommandCodeAiStreamAdapter } from './command-code-ai.adapter.js';
import { askUserSchema } from './command-code-ai.adapter.js';

const product: CatalogProduct = {
  id: '0198a122-0c00-7000-8000-000000000001',
  providerId: 'fake',
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

describe('CommandCodeAiStreamAdapter', () => {
  it('validates structured askUser arguments', () => {
    expect(
      askUserSchema.parse({
        question: '예산은 어느 정도인가요?',
        options: [
          { id: 'under-3', label: '3만원 이하' },
          { id: 'under-5', label: '5만원 이하' },
        ],
        allowFreeText: true,
      }).question,
    ).toBe('예산은 어느 정도인가요?');
    expect(() =>
      askUserSchema.parse({
        question: '가'.repeat(161),
        options: [
          { id: 'same', label: '작은 크기' },
          { id: 'same', label: '큰 크기' },
        ],
        allowFreeText: false,
      }),
    ).toThrow();
    expect(() =>
      askUserSchema.parse({
        question: '크기는요?',
        options: [{ id: 'one', label: '작은 크기' }],
        allowFreeText: false,
      }),
    ).toThrow();
  });

  it('passes trusted history to the provider in order', async () => {
    const providerFetch = jest
      .fn<typeof fetch>()
      .mockResolvedValue(
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
      COMMAND_CODE_API_KEY: 'key',
      COMMAND_CODE_MODEL: 'gpt-5.4-mini',
      COMMAND_CODE_MAX_OUTPUT_TOKENS: 512,
    });
    const tools: AiToolSession = {
      searchProducts: () =>
        Promise.resolve({ items: [], endCursor: null, hasNextPage: false }),
      getProduct: () => Promise.resolve(null),
      compareProducts: () => Promise.resolve([]),
    };
    for await (const _chunk of new CommandCodeAiStreamAdapter(
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

  it('finishes an askUser-only turn without running product search', async () => {
    const providerFetch = jest.fn<typeof fetch>().mockResolvedValue(
      streamResponse([
        completionChunk(
          'chatcmpl-question',
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call-question',
                type: 'function',
                function: {
                  name: 'askUser',
                  arguments: JSON.stringify({
                    question: '예산은 어느 정도인가요?',
                    options: [
                      { id: 'under-3', label: '3만원 이하' },
                      { id: 'under-5', label: '5만원 이하' },
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
    const config = new ConfigService<Environment, true>({
      COMMAND_CODE_API_KEY: 'key',
      COMMAND_CODE_MODEL: 'gpt-5.4-mini',
      COMMAND_CODE_MAX_OUTPUT_TOKENS: 512,
    });
    const searchProducts = jest.fn(() =>
      Promise.resolve({ items: [], endCursor: null, hasNextPage: false }),
    );
    const completed: Array<AiStreamResult> = [];
    const chunks: Array<StreamChunk> = [];
    const tools: AiToolSession = {
      searchProducts,
      getProduct: () => Promise.resolve(null),
      compareProducts: () => Promise.resolve([]),
    };
    for await (const chunk of new CommandCodeAiStreamAdapter(
      config,
      providerFetch,
    ).createStream(
      {
        threadId: '0198a122-0c00-7000-8000-000000000010',
        runId: '0198a122-0c00-7000-8000-000000000011',
        text: '텀블러 추천해줘',
        image: null,
      },
      tools,
      {
        onComplete: (result) => {
          completed.push(result);
          return Promise.resolve();
        },
        onFailure: () => Promise.resolve(),
        isCancelled: () => Promise.resolve(false),
      },
    )) {
      chunks.push(chunk);
    }
    expect(searchProducts).not.toHaveBeenCalled();
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(chunks.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.RUN_FINISHED,
      ]),
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]?.messageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(
      chunks.flatMap((chunk) =>
        chunk.type === EventType.TOOL_CALL_START ? [chunk.parentMessageId] : [],
      ),
    ).toContain(completed[0]?.messageId);
    expect(completed[0]?.text).toBe('');
    expect(completed[0]?.productIds).toEqual([]);
    expect(completed[0]?.askUser?.question).toBe('예산은 어느 정도인가요?');
  });
  it('streams a ZDR multimodal tool run and persists the final response', async () => {
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
                    arguments: JSON.stringify({ query: '텀블러' }),
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
      COMMAND_CODE_API_KEY: 'test-command-code-key',
      COMMAND_CODE_MODEL: 'gpt-5.4-mini',
      COMMAND_CODE_MAX_OUTPUT_TOKENS: 512,
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
      compareProducts: () => Promise.resolve([]),
    };
    const completed: Array<AiStreamResult> = [];
    const onFailure = jest.fn(() => Promise.resolve());
    const adapter = new CommandCodeAiStreamAdapter(config, providerFetch);
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
      },
    )) {
      chunks.push(chunk);
    }

    expect(providerFetch).toHaveBeenCalledTimes(2);
    const firstCall = requiredCall(providerFetch.mock.calls, 0);
    expect(requestUrl(firstCall)).toBe(
      'https://api.commandcode.ai/provider/v1/chat/completions',
    );
    expect(requestHeaders(firstCall).get('authorization')).toBe(
      'Bearer test-command-code-key',
    );
    expect(requestHeaders(firstCall).get('x-cmd-zdr')).toBe('1');
    expect(await requestBody(firstCall)).toContain(
      'data:image/jpeg;base64,aW1hZ2U=',
    );
    expect(searchProducts).toHaveBeenCalledWith('텀블러');
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
        productIds: [product.id],
      }),
    ]);
    expect(
      chunks.flatMap((chunk) =>
        chunk.type === EventType.TEXT_MESSAGE_START ? [chunk.messageId] : [],
      ),
    ).toContain(completed[0]?.messageId);
    expect(onFailure).not.toHaveBeenCalled();
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
      COMMAND_CODE_API_KEY: 'test-command-code-key',
      COMMAND_CODE_MODEL: 'gpt-5.4-mini',
      COMMAND_CODE_MAX_OUTPUT_TOKENS: 512,
    });
    const tools: AiToolSession = {
      searchProducts: () =>
        Promise.resolve({ items: [], endCursor: null, hasNextPage: false }),
      getProduct: () => Promise.resolve(null),
      compareProducts: () => Promise.resolve([]),
    };
    const onFailure = jest.fn(() => Promise.resolve());
    const chunks: Array<StreamChunk> = [];

    for await (const chunk of new CommandCodeAiStreamAdapter(
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
