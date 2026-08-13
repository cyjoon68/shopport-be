import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { StreamChunk } from '@tanstack/ai';
import { AssetsService } from '../assets/assets.service.js';
import { AiRepository } from './ai.repository.js';
import { parseAiRequest } from './ai-request.js';
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
      runId: request.runId,
      userMessageId: request.userMessageId,
      text: request.text,
      assetId: request.assetId,
    });
    if (!began) throw new ConflictException('Run already exists');
    await this.repository.heartbeatRun(request.runId);
    try {
      const tools = this.tools.createSession();
      const image =
        request.assetId && this.stream.requiresImageData
          ? await this.assets.readNormalizedImage(accountId, request.assetId)
          : null;
      return this.stream.createStream(
        {
          threadId: request.threadId,
          runId: request.runId,
          text: request.text,
          image,
        },
        tools,
        {
          onComplete: (result) =>
            this.repository.completeRun(
              request.runId,
              request.threadId,
              result.messageId,
              result.text,
              result.productIds,
            ),
          onFailure: () => this.repository.failRun(request.runId),
          isCancelled: () => this.cancellation.isCancelled(request.runId),
        },
      );
    } catch (error) {
      await this.repository.failRun(request.runId);
      throw error;
    }
  };

  public assertOwnedRun = (
    accountId: string,
    runId: string,
    conversationId?: string,
  ): Promise<void> =>
    this.repository.assertOwnedRun(accountId, runId, conversationId);

  public cancel = async (
    accountId: string,
    conversationId: string,
    runId: string,
  ): Promise<void> => {
    const result = await this.repository.cancelRun(
      accountId,
      conversationId,
      runId,
    );
    if (result !== 'terminal') await this.cancellation.mark(runId);
  };
}
