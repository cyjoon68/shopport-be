import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, lte } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '../database/database.module.js';
import { DATABASE } from '../database/database.module.js';
import {
  accounts,
  assets,
  conversations,
  messageParts,
  messages,
  outbox,
} from '../database/schema.js';
import { ObjectStore } from '../storage/object-store.js';

const accountPayload = z.object({ accountId: z.uuid() });
const conversationPayload = accountPayload.extend({ conversationId: z.uuid() });
const assetPayload = accountPayload.extend({
  originalKey: z.string().min(1),
  normalizedKey: z.string().nullable(),
});

type OutboxRecord = Readonly<{
  attemptCount: number;
  id: string;
  topic: string;
  payload: unknown;
}>;

@Injectable()
export class OutboxProcessor {
  public constructor(
    @Inject(DATABASE) private readonly database: Database,
    private readonly objects: ObjectStore,
  ) {}

  public process = async (): Promise<boolean> => {
    const now = new Date();
    const events = await this.database
      .select({
        attemptCount: outbox.attemptCount,
        id: outbox.id,
        topic: outbox.topic,
        payload: outbox.payload,
      })
      .from(outbox)
      .where(
        and(
          isNull(outbox.publishedAt),
          isNull(outbox.failedAt),
          lte(outbox.nextAttemptAt, now),
        ),
      )
      .orderBy(outbox.nextAttemptAt, outbox.createdAt)
      .limit(20);
    for (const event of events) {
      try {
        await this.processEvent(event);
        await this.database
          .update(outbox)
          .set({ lastError: null, publishedAt: new Date() })
          .where(and(eq(outbox.id, event.id), isNull(outbox.publishedAt)));
      } catch (error) {
        const attemptCount = event.attemptCount + 1;
        const failedAt = attemptCount >= 10 ? new Date() : null;
        const delaySeconds = Math.min(2 ** attemptCount, 3_600);
        await this.database
          .update(outbox)
          .set({
            attemptCount,
            failedAt,
            lastError: (error instanceof Error
              ? error.message
              : 'Worker failure'
            ).slice(0, 500),
            nextAttemptAt: new Date(Date.now() + delaySeconds * 1_000),
          })
          .where(and(eq(outbox.id, event.id), isNull(outbox.publishedAt)));
      }
    }
    return events.length > 0;
  };

  private readonly processEvent = async (
    event: OutboxRecord,
  ): Promise<void> => {
    if (event.topic === 'asset.purge') {
      const payload = assetPayload.parse(event.payload);
      await this.objects.deleteKey('raw', payload.originalKey);
      if (payload.normalizedKey)
        await this.objects.deleteKey('normalized', payload.normalizedKey);
      return;
    }
    if (event.topic === 'conversation.purge') {
      await this.purgeConversation(conversationPayload.parse(event.payload));
      return;
    }
    if (event.topic === 'account.purge') {
      await this.purgeAccount(accountPayload.parse(event.payload).accountId);
      return;
    }
    throw new Error(`Unsupported outbox topic: ${event.topic}`);
  };

  private readonly purgeConversation = async (
    payload: z.infer<typeof conversationPayload>,
  ): Promise<void> => {
    const [assetRows, messageRows] = await Promise.all([
      this.database
        .select({
          originalKey: assets.originalKey,
          normalizedKey: assets.normalizedKey,
        })
        .from(assets)
        .where(eq(assets.conversationId, payload.conversationId)),
      this.database
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.conversationId, payload.conversationId)),
    ]);
    await Promise.all(
      assetRows.flatMap(({ originalKey, normalizedKey }) => [
        this.objects.deleteKey('raw', originalKey),
        ...(normalizedKey
          ? [this.objects.deleteKey('normalized', normalizedKey)]
          : []),
      ]),
    );
    await this.objects.deletePrefix(
      'archive',
      `archives/${payload.accountId}/${payload.conversationId}/`,
    );
    await this.database.transaction(async (transaction) => {
      const ids = messageRows.map(({ id }) => id);
      if (ids.length > 0)
        await transaction
          .delete(messageParts)
          .where(inArray(messageParts.messageId, ids));
      await transaction
        .delete(conversations)
        .where(eq(conversations.id, payload.conversationId));
    });
  };

  private readonly purgeAccount = async (accountId: string): Promise<void> => {
    const messageRows = await this.database
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(eq(conversations.accountId, accountId));
    await Promise.all([
      this.objects.deletePrefix('raw', `uploads/${accountId}/`),
      this.objects.deletePrefix('normalized', `uploads/${accountId}/`),
      this.objects.deletePrefix('archive', `archives/${accountId}/`),
    ]);
    await this.database.transaction(async (transaction) => {
      const ids = messageRows.map(({ id }) => id);
      if (ids.length > 0)
        await transaction
          .delete(messageParts)
          .where(inArray(messageParts.messageId, ids));
      await transaction.delete(accounts).where(eq(accounts.id, accountId));
    });
  };
}
