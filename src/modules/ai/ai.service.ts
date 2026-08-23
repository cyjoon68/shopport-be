import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { StreamChunk } from '@tanstack/ai';
import { AssetsService } from '../assets/assets.service.js';
import { AiRepository } from './ai.repository.js';
import { parseAiRequest, storageRunIdFor } from './ai-request.js';
import { RedisRunCancellation } from './redis-run-cancellation.js';
import { AiTools } from './ai-tools.js';
import { AI_STREAM_ADAPTER } from './ai-stream.adapter.js';
import type { AiStreamAdapter } from './ai-stream.adapter.js';

@Injectable()
export class AiService {
  public constructor(
    private readonly repository: AiRepository,
    private readonly tools: AiTools,
    private readonly assets: AssetsService,
    private readonly cancellation: RedisRunCancellation,
    @Inject(AI_STREAM_ADAPTER) private readonly stream: AiStreamAdapter,
  ) {}

  public start = async (
    accountId: string,
    body: unknown,
  ): Promise<AsyncIterable<StreamChunk>> => {
    const request = parseAiRequest(body);
    const began = await this.repository.beginRun({
      accountId,
      conversationId: request.threadId,
      runId: request.storageRunId,
      userMessageId: request.userMessageId,
      text: request.text,
      assetId: request.assetId,
    });
    if (!began) throw new ConflictException('Run already exists');
    await this.repository.heartbeatRun(request.storageRunId);
    try {
      const providerIds = request.providerIdsSpecified
        ? request.providerIds
        : await this.repository.pendingProviderIds(accountId, request.threadId);
      const tools = this.tools.createSession(providerIds);
      const history = await this.repository.conversationHistory(
        accountId,
        request.threadId,
      );
      const image =
        request.assetId && this.stream.requiresImageData
          ? await this.assets.readNormalizedImage(accountId, request.assetId)
          : null;
      return this.stream.createStream(
        {
          threadId: request.threadId,
          runId: request.runId,
          text: request.text,
          providerIds,
          history,
          image,
        },
        tools,
        {
          onComplete: (result) =>
            this.repository.completeRun(
              request.storageRunId,
              request.threadId,
              result.messageId,
              result.text,
              result.productRecommendations,
              result.askUser,
              providerIds,
            ),
          onFailure: () => this.repository.failRun(request.storageRunId),
          isCancelled: () =>
            this.cancellation.isCancelled(request.storageRunId),
        },
      );
    } catch (error) {
      await this.repository.failRun(request.storageRunId);
      throw error;
    }
  };

  public assertOwnedRun = (
    accountId: string,
    runId: string,
    conversationId?: string,
  ): Promise<void> =>
    this.repository.assertOwnedRun(
      accountId,
      storageRunIdFor(runId),
      conversationId,
    );

  public cancel = async (
    accountId: string,
    conversationId: string,
    runId: string,
  ): Promise<void> => {
    const storageRunId = storageRunIdFor(runId);
    const result = await this.repository.cancelRun(
      accountId,
      conversationId,
      storageRunId,
    );
    if (result !== 'terminal') await this.cancellation.mark(storageRunId);
  };
}
