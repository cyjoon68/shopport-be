import { describe, expect, it, jest } from '@jest/globals';
import type { StreamChunk } from '@tanstack/ai';
import { v7 as uuidv7 } from 'uuid';

import type { AssetsService } from '../assets/assets.service.js';
import type { CatalogService } from '../catalog/catalog.service.js';
import type { CatalogProduct } from '../catalog/types.js';
import type { AiRepository } from './ai.repository.js';
import { AiService } from './ai.service.js';
import type { AiProviderId } from './ai-request.js';
import type { AiStreamAdapter } from './ai-stream.adapter.js';
import type { AiToolSession } from './ai-tools.js';
import type { AiTools } from './ai-tools.js';
import type {
  AiHistoryMessage,
  AiStreamInput,
  AiStreamLifecycle,
  CompleteRunInput,
} from './types.js';

const emptyStream = async function* (): AsyncIterable<StreamChunk> {
  await Promise.resolve();
  yield* [] as Array<StreamChunk>;
};

type ServiceFixture = Readonly<{
  createSession: (providerIds: ReadonlyArray<AiProviderId>) => AiToolSession;
  pendingProviderIds: jest.MockedFunction<
    (
      accountId: string,
      conversationId: string,
    ) => Promise<ReadonlyArray<AiProviderId>>
  >;
  conversationHistory: jest.MockedFunction<
    (
      accountId: string,
      conversationId: string,
    ) => Promise<ReadonlyArray<AiHistoryMessage>>
  >;
  generateTitle: jest.MockedFunction<(prompt: string) => Promise<string>>;
  replaceDefaultTitle: jest.MockedFunction<
    (accountId: string, conversationId: string, title: string) => Promise<void>
  >;
  createStream: jest.MockedFunction<
    (
      input: AiStreamInput,
      tools: AiToolSession,
      lifecycle: AiStreamLifecycle,
    ) => AsyncIterable<StreamChunk>
  >;
  completeRun: jest.MockedFunction<(input: CompleteRunInput) => Promise<void>>;
  cancelRun: jest.MockedFunction<
    (
      accountId: string,
      conversationId: string,
      runId: string,
    ) => Promise<'completed'>
  >;
  failRun: jest.MockedFunction<(runId: string) => Promise<void>>;
  failRunAndClose: jest.MockedFunction<(runId: string) => Promise<void>>;
  getProducts: jest.MockedFunction<
    (
      ids: ReadonlyArray<string>,
    ) => Promise<ReadonlyArray<CatalogProduct | null>>
  >;
  renewRunLease: jest.MockedFunction<(runId: string) => Promise<void>>;
  service: AiService;
}>;

const requestFor = (
  providerIds?: ReadonlyArray<AiProviderId>,
): Readonly<{
  accountId: string;
  body: Record<string, unknown>;
  threadId: string;
}> => {
  const threadId = uuidv7();
  return {
    accountId: uuidv7(),
    threadId,
    body: {
      threadId,
      runId: uuidv7(),
      messages: [{ id: uuidv7(), role: 'user', content: '립밤 찾아줘' }],
      forwardedProps: providerIds === undefined ? {} : { providerIds },
    },
  };
};

const createService = (): ServiceFixture => {
  const beginRun = jest
    .fn<(input: unknown) => Promise<boolean>>()
    .mockResolvedValue(true);
  const renewRunLease = jest
    .fn<(runId: string) => Promise<void>>()
    .mockResolvedValue();
  const completeRun = jest
    .fn<(input: CompleteRunInput) => Promise<void>>()
    .mockResolvedValue();
  const failRun = jest
    .fn<(runId: string) => Promise<void>>()
    .mockResolvedValue();
  const failRunAndClose = jest
    .fn<(runId: string) => Promise<void>>()
    .mockResolvedValue();
  const pendingProviderIds = jest
    .fn<
      (
        accountId: string,
        conversationId: string,
      ) => Promise<ReadonlyArray<AiProviderId>>
    >()
    .mockResolvedValue(['oliveyoung']);
  const conversationHistory = jest
    .fn<
      (
        accountId: string,
        conversationId: string,
      ) => Promise<ReadonlyArray<AiHistoryMessage>>
    >()
    .mockResolvedValue([]);
  const replaceDefaultTitle = jest
    .fn<
      (
        accountId: string,
        conversationId: string,
        title: string,
      ) => Promise<void>
    >()
    .mockResolvedValue();
  const cancelRun = jest
    .fn<
      (
        accountId: string,
        conversationId: string,
        runId: string,
      ) => Promise<'completed'>
    >()
    .mockResolvedValue('completed');
  const createSession = jest
    .fn<(providerIds: ReadonlyArray<AiProviderId>) => AiToolSession>()
    .mockReturnValue({} as AiToolSession);
  const createStream = jest
    .fn<
      (
        input: AiStreamInput,
        tools: AiToolSession,
        lifecycle: AiStreamLifecycle,
      ) => AsyncIterable<StreamChunk>
    >()
    .mockReturnValue(emptyStream());
  const repository = {
    beginRun,
    renewRunLease,
    completeRun,
    cancelRun,
    failRun,
    failRunAndClose,
    pendingProviderIds,
    conversationHistory,
    replaceDefaultTitle,
  } as unknown as AiRepository;
  const generateTitle = jest
    .fn<(prompt: string) => Promise<string>>()
    .mockResolvedValue('립밤 상품 탐색');
  const stream = {
    requiresImageData: false,
    generateTitle,
    createStream,
  } as unknown as AiStreamAdapter;
  const getProducts = jest
    .fn<
      (
        ids: ReadonlyArray<string>,
      ) => Promise<ReadonlyArray<CatalogProduct | null>>
    >()
    .mockResolvedValue([]);
  return {
    service: new AiService(
      repository,
      { createSession } as unknown as AiTools,
      {} as AssetsService,
      { getProducts } as unknown as CatalogService,
      stream,
    ),
    conversationHistory,
    createSession,
    generateTitle,
    createStream,
    completeRun,
    cancelRun,
    failRun,
    failRunAndClose,
    getProducts,
    pendingProviderIds,
    replaceDefaultTitle,
    renewRunLease,
  };
};

const catalogProduct: CatalogProduct = {
  id: '0198a122-0c00-7000-8000-000000000001',
  providerId: 'daiso',
  productCode: 'lip-balm',
  title: '립밤',
  imageUrl: 'https://example.com/lip-balm.jpg',
  affiliate: false,
  relevanceBucket: 3,
  inStock: true,
  availability: 'IN_STOCK',
  totalAmountMinor: '1000',
  deliveryEstimateDays: null,
  ratingConfidence: 1,
  freshnessEpochMs: 1_786_460_400_000,
  outboundUrl: 'https://example.com/lip-balm',
  store: null,
  inventory: null,
  evidence: [],
};

describe('AiService cancellation', () => {
  it('returns the repository cancellation outcome', async () => {
    const fixture = createService();
    const accountId = uuidv7();
    const conversationId = uuidv7();
    const runId = uuidv7();

    await expect(
      fixture.service.cancel(accountId, conversationId, runId),
    ).resolves.toBe('completed');
    expect(fixture.cancelRun).toHaveBeenCalledWith(
      accountId,
      conversationId,
      runId,
    );
  });
});

describe('AiService provider filters', () => {
  it('closes a pre-producer failure without renewing the initial lease', async () => {
    const fixture = createService();
    const request = requestFor();
    fixture.pendingProviderIds.mockRejectedValue(new Error('filters failed'));

    await expect(
      fixture.service.start(request.accountId, request.body),
    ).rejects.toThrow('filters failed');

    expect(fixture.renewRunLease).not.toHaveBeenCalled();
    expect(fixture.failRun).not.toHaveBeenCalled();
    expect(fixture.failRunAndClose).toHaveBeenCalledTimes(1);
  });

  it('uses an explicit empty filter instead of a pending clarification filter', async () => {
    const { service, createSession, pendingProviderIds } = createService();
    const request = requestFor([]);

    await service.start(request.accountId, request.body);

    expect(pendingProviderIds).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledWith([]);
  });

  it('reuses the pending clarification filter when providerIds is omitted', async () => {
    const { service, createSession, pendingProviderIds } = createService();
    const request = requestFor();

    await service.start(request.accountId, request.body);

    expect(pendingProviderIds).toHaveBeenCalledWith(
      request.accountId,
      request.threadId,
    );
    expect(createSession).toHaveBeenCalledWith(['oliveyoung']);
  });

  it('titles a conversation from its first user prompt', async () => {
    const fixture = createService();
    const request = requestFor([]);
    fixture.conversationHistory.mockResolvedValue([
      { role: 'user', text: '립밤 찾아줘' },
    ]);

    await fixture.service.start(request.accountId, request.body);
    await Promise.resolve();

    expect(fixture.generateTitle).toHaveBeenCalledWith('립밤 찾아줘');
    expect(fixture.replaceDefaultTitle).toHaveBeenCalledWith(
      request.accountId,
      request.threadId,
      '립밤 상품 탐색',
    );
  });

  it('does not regenerate a title after a follow-up prompt', async () => {
    const fixture = createService();
    const request = requestFor([]);
    fixture.conversationHistory.mockResolvedValue([
      { role: 'user', text: '립밤 찾아줘' },
      { role: 'assistant', text: '어떤 용도인가요?' },
      { role: 'user', text: '보습용' },
    ]);

    await fixture.service.start(request.accountId, request.body);

    expect(fixture.generateTitle).not.toHaveBeenCalled();
  });

  it('maps catalog snapshots before passing completion to the repository', async () => {
    const fixture = createService();
    const request = requestFor([]);
    fixture.getProducts.mockResolvedValue([catalogProduct]);

    await fixture.service.start(request.accountId, request.body);
    const lifecycle = fixture.createStream.mock.calls.at(0)?.[2];
    if (!lifecycle) throw new Error('Expected stream lifecycle');
    await lifecycle.onComplete({
      messageId: '0198a122-0c00-7000-8000-000000000004',
      text: '립밤을 찾았어요.',
      productRecommendations: [
        {
          productId: catalogProduct.id,
          aiSummary: '보습이 필요한 외출용으로 적합해서 추천해요.',
        },
      ],
      askUser: null,
    });

    expect(fixture.getProducts).toHaveBeenCalledWith([catalogProduct.id]);
    expect(fixture.completeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        productRecommendations: [
          expect.objectContaining({
            productId: catalogProduct.id,
            productSnapshot: expect.objectContaining({
              id: catalogProduct.id,
            }),
          }),
        ],
      }),
    );
  });
});
