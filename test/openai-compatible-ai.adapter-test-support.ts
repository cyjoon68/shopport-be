import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import type { StreamChunk } from '@tanstack/ai';

import type { Environment } from '../src/config/environment.js';
import type { AiToolSession } from '../src/modules/ai/ai-tools.js';
import { OpenAiCompatibleAiStreamAdapter } from '../src/modules/ai/openai-compatible-ai.adapter.js';
import type { AiStreamLifecycle } from '../src/modules/ai/types.js';
import type { CatalogProduct } from '../src/modules/catalog/types.js';

export const product: CatalogProduct = {
  id: '0198a122-0c00-7000-8000-000000000001',
  providerId: 'test',
  productCode: 'tumbler-1',
  title: '오래 쓰는 스테인리스 텀블러 600ml',
  imageUrl: 'https://example.com/tumbler.jpg',
  affiliate: false,
  relevanceBucket: 3,
  inStock: true,
  availability: 'IN_STOCK',
  totalAmountMinor: '21900',
  deliveryEstimateDays: 1,
  ratingConfidence: 0.96,
  freshnessEpochMs: 1_786_460_400_000,
  outboundUrl: 'https://example.com/products/tumbler',
  store: null,
  inventory: null,
  evidence: [{ operation: 'products', fetchedAt: 1_786_460_400_000 }],
};

export const completionChunk = (
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

export const streamResponse = (
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

export const ambiguityAssessmentResponse = (
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

export const requestBody = async (
  call: Parameters<typeof fetch>,
): Promise<string> => {
  const [input, init] = call;
  if (input instanceof Request) return input.clone().text();
  return typeof init?.body === 'string' ? init.body : '';
};

export const requestHeaders = (call: Parameters<typeof fetch>): Headers => {
  const [input, init] = call;
  return input instanceof Request
    ? input.headers
    : new Headers(init?.headers ?? {});
};

export const requestUrl = (call: Parameters<typeof fetch>): string => {
  const [input] = call;
  return input instanceof Request ? input.url : input.toString();
};

export const requiredCall = (
  calls: Array<Parameters<typeof fetch>>,
  index: number,
): Parameters<typeof fetch> => {
  const call = calls.at(index);
  if (!call) throw new Error('Command Code request was not made');
  return call;
};

export const deferred = <T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}> => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

export const testConfig = (): ConfigService<Environment, true> =>
  new ConfigService<Environment, true>({
    PROVIDER_API_KEY: 'key',
    PROVIDER_MODEL: 'gpt-5.4-mini',
    PROVIDER_MAX_OUTPUT_TOKENS: 512,
  });

export const emptyTools: AiToolSession = {
  searchProducts: () =>
    Promise.resolve({
      items: [],
      endCursor: null,
      hasNextPage: false,
      unavailableProviderIds: [],
    }),
  getProduct: () => Promise.resolve(null),
};

export const pendingStream = (
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
