import { EventType, type StreamChunk } from '@tanstack/ai';
import { v7 as uuidv7 } from 'uuid';

import { decodePageCursor } from '../src/common/cursor.js';
import type { AiStreamAdapter } from '../src/modules/ai/ai-stream.adapter.js';
import { toAiProductResult } from '../src/modules/ai/ai-tool-result.js';
import type { AiToolSession } from '../src/modules/ai/ai-tools.js';
import type {
  AiStreamInput,
  AiStreamLifecycle,
} from '../src/modules/ai/types.js';
import type {
  CatalogProduct,
  CatalogProvider,
} from '../src/modules/catalog/types.js';

const maestroProduct: CatalogProduct = {
  id: '0198a122-0c00-7000-8000-000000000099',
  providerId: 'daiso',
  productCode: 'integration-tumbler',
  title: '통합 테스트 텀블러',
  imageUrl: 'https://images.example.com/tumbler.jpg',
  affiliate: false,
  relevanceBucket: 2,
  inStock: true,
  availability: 'IN_STOCK',
  totalAmountMinor: '5000',
  deliveryEstimateDays: 1,
  ratingConfidence: 1,
  freshnessEpochMs: Date.UTC(2026, 7, 24),
  outboundUrl: 'https://www.daisomall.co.kr/ds/prd/detail?pdNo=integration',
  store: null,
  inventory: null,
  evidence: [{ operation: 'products', fetchedAt: Date.UTC(2026, 7, 24) }],
};

const maestroProducts = [95, 96, 97, 98, 99].map(
  (suffix, index): CatalogProduct => ({
    ...maestroProduct,
    id: `0198a122-0c00-7000-8000-${String(suffix).padStart(12, '0')}`,
    productCode: `integration-tumbler-${String(suffix)}`,
    title: `통합 테스트 텀블러 ${String(index + 1)}`,
  }),
);

export const maestroCatalogProvider: CatalogProvider = {
  providerId: 'integration',
  capabilities: ['LIVE_QUERY'],
  outboundHosts: ['www.daisomall.co.kr'],
  search: ({ after }) => {
    decodePageCursor(after ?? null);
    return Promise.resolve({
      items: maestroProducts,
      endCursor: null,
      hasNextPage: false,
      unavailableProviderIds: [],
    });
  },
};

const waitForCompletion = async (
  lifecycle: AiStreamLifecycle,
  delayMilliseconds: number,
): Promise<boolean> => {
  const deadline = Date.now() + delayMilliseconds;
  while (Date.now() < deadline) {
    if (await lifecycle.isCancelled()) return false;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(100, deadline - Date.now())),
    );
  }
  return !(await lifecycle.isCancelled());
};

const createMaestroStream = async function* (
  input: AiStreamInput,
  tools: AiToolSession,
  lifecycle: AiStreamLifecycle,
  delayMilliseconds: number,
): AsyncGenerator<StreamChunk> {
  yield {
    type: EventType.RUN_STARTED,
    threadId: input.threadId,
    runId: input.runId,
  };
  if (!(await waitForCompletion(lifecycle, delayMilliseconds))) return;
  const search = await tools.searchProducts({
    query: input.text,
    providerId: 'daiso',
  });
  const messageId = uuidv7();
  const deltas = ['조건에 맞는 ', '상품 다섯 개를 ', '찾았어요.'];
  const text = deltas.join('');
  yield {
    type: EventType.TOOL_CALL_RESULT,
    messageId,
    toolCallId: 'integration-search',
    content: JSON.stringify(toAiProductResult(search.items)),
  };
  yield { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' };
  for (const delta of deltas) {
    yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta };
  }
  yield { type: EventType.TEXT_MESSAGE_END, messageId };
  await lifecycle.onComplete({
    messageId,
    text,
    productRecommendations: search.items.map(({ id }) => ({
      productId: id,
      aiSummary: '통합 테스트 추천 상품',
    })),
    askUser: null,
  });
  yield {
    type: EventType.RUN_FINISHED,
    threadId: input.threadId,
    runId: input.runId,
    outcome: { type: 'success' },
  };
};

export const createMaestroAiStream = (
  delayMilliseconds = 0,
): AiStreamAdapter => ({
  requiresImageData: false,
  generateTitle: () => Promise.resolve('통합 테스트 대화'),
  createStream: (input, tools, lifecycle): AsyncIterable<StreamChunk> => {
    if (input.text === 'pre-producer failure') {
      throw new Error('Integration pre-producer failure');
    }
    return createMaestroStream(input, tools, lifecycle, delayMilliseconds);
  },
});
