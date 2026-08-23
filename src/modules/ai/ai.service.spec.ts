import { describe, expect, it, jest } from '@jest/globals';
import type { StreamChunk } from '@tanstack/ai';
import { v7 as uuidv7 } from 'uuid';
import type { AssetsService } from '../assets/assets.service.js';
import type { AiRepository } from './ai.repository.js';
import type { AiProviderId } from './ai-request.js';
import type {
  AiStreamAdapter,
  AiStreamInput,
  AiStreamLifecycle,
} from './ai-stream.adapter.js';
import { AiService } from './ai.service.js';
import type { AiToolSession } from './ai-tools.js';
import type { AiTools } from './ai-tools.js';
import type { RedisRunCancellation } from './redis-run-cancellation.js';

const emptyStream = async function* (): AsyncIterable<StreamChunk> {
  await Promise.resolve();
  yield* [] as Array<StreamChunk>;
};

type ServiceFixture = Readonly<{
  createSession: (providerIds: ReadonlyArray<AiProviderId>) => AiToolSession;
  pendingProviderIds: (
    accountId: string,
    conversationId: string,
  ) => Promise<ReadonlyArray<AiProviderId>>;
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
  const heartbeatRun = jest
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
    .fn<() => Promise<ReadonlyArray<never>>>()
    .mockResolvedValue([]);
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
    heartbeatRun,
    pendingProviderIds,
    conversationHistory,
  } as unknown as AiRepository;
  const stream = {
    requiresImageData: false,
    createStream,
  } as unknown as AiStreamAdapter;
  return {
    service: new AiService(
      repository,
      { createSession } as unknown as AiTools,
      {} as AssetsService,
      {} as RedisRunCancellation,
      stream,
    ),
    createSession,
    pendingProviderIds,
  };
};

describe('AiService provider filters', () => {
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
});
