import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { StreamChunk } from '@tanstack/ai';

import { AssetsService } from '../assets/assets.service.js';
import { toProductGraphql } from '../catalog/catalog.mapper.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { AiRepository } from './ai.repository.js';
import { parseAiRequest, storageRunIdFor } from './ai-request.js';
import type { AiStreamAdapter } from './ai-stream.adapter.js';
import { AI_STREAM_ADAPTER } from './ai-stream.adapter.js';
import { AiTools } from './ai-tools.js';

const fallbackConversationTitle = (prompt: string): string =>
  Array.from(prompt.replace(/\s+/gu, ' ').trim()).slice(0, 24).join('');

@Injectable()
export class AiService {
  public constructor(
    private readonly repository: AiRepository,
    private readonly tools: AiTools,
    private readonly assets: AssetsService,
    private readonly catalog: CatalogService,
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
    await this.repository.renewRunLease(request.storageRunId);
    try {
      const providerIds = request.providerIdsSpecified
        ? request.providerIds
        : await this.repository.pendingProviderIds(accountId, request.threadId);
      const tools = this.tools.createSession(providerIds);
      const history = await this.repository.conversationHistory(
        accountId,
        request.threadId,
      );
      const userPrompts = history.filter(({ role }) => role === 'user');
      const titleUpdate =
        userPrompts.length === 1
          ? this.stream
              .generateTitle(userPrompts[0]?.text ?? request.text)
              .catch(() => fallbackConversationTitle(request.text))
              .then((title) =>
                this.repository.replaceDefaultTitle(
                  accountId,
                  request.threadId,
                  title,
                ),
              )
              .catch(() => undefined)
          : Promise.resolve();
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
          onComplete: async (result): Promise<void> => {
            const snapshots = new Map<
              string,
              ReturnType<typeof toProductGraphql>
            >();
            const products = await this.catalog.getProducts(
              result.productRecommendations.map(({ productId }) => productId),
            );
            for (const product of products) {
              if (product) snapshots.set(product.id, toProductGraphql(product));
            }
            await Promise.all([
              this.repository.completeRun({
                runId: request.storageRunId,
                conversationId: request.threadId,
                messageId: result.messageId,
                text: result.text,
                productRecommendations: result.productRecommendations.map(
                  (recommendation) => ({
                    ...recommendation,
                    productSnapshot:
                      snapshots.get(recommendation.productId) ?? null,
                  }),
                ),
                askUser: result.askUser,
                providerIds,
              }),
              titleUpdate,
            ]);
          },
          onFailure: () => this.repository.failRun(request.storageRunId),
          isCancelled: () =>
            this.repository.isRunCancelled(request.storageRunId),
          renewLease: () => this.repository.renewRunLease(request.storageRunId),
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
    await this.repository.cancelRun(accountId, conversationId, storageRunId);
  };
}
