import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { StreamChunk } from '@tanstack/ai';
import { v7 as uuidv7 } from 'uuid';
import { toProductGraphql } from '../catalog/catalog.mapper.js';
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
    let result;
    try {
      const tools = this.tools.createSession();
      result = await this.withTimeout(
        tools.searchProducts(request.text),
        60_000,
      );
    } catch (error) {
      await this.repository.failRun(request.runId);
      throw error;
    }
    await this.repository.heartbeatRun(request.runId);
    const products = result.items.map((product) => toProductGraphql(product));
    const answer =
      products.length > 0
        ? '조건에 맞는 상품을 가격과 배송 기준으로 정리했어요. 카드를 눌러 상세 조건을 확인해 보세요.'
        : '조건에 맞는 상품을 찾지 못했어요. 용도나 예산을 조금 더 알려주세요.';
    const assistantMessageId = uuidv7();
    return this.stream.createStream(
      {
        threadId: request.threadId,
        runId: request.runId,
        messageId: assistantMessageId,
        message: answer,
        products,
      },
      {
        onComplete: () =>
          this.repository.completeRun(
            request.runId,
            request.threadId,
            assistantMessageId,
            answer,
            result.items.map(({ id }) => id),
          ),
        onFailure: () => this.repository.failRun(request.runId),
        isCancelled: () => this.cancellation.isCancelled(request.runId),
      },
    );
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

  private readonly withTimeout = async <Value>(
    operation: Promise<Value>,
    milliseconds: number,
  ): Promise<Value> => {
    let timeout: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error('AI turn timed out'));
      }, milliseconds);
    });
    try {
      return await Promise.race([operation, expired]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
}
