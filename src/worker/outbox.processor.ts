import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '../database/database.module.js';
import { DATABASE } from '../database/database.module.js';
import { accounts, assets, conversations, outbox } from '../database/schema.js';
import { ObjectStore } from '../storage/object-store.js';
import { report } from './worker-process.js';

const accountPayload = z.object({ accountId: z.uuid() });
const conversationPayload = accountPayload.extend({ conversationId: z.uuid() });
const assetPayload = accountPayload.extend({
  originalKey: z.string().min(1),
  normalizedKey: z.string().nullable(),
});
const claimLease = sql`now() + interval '5 minutes'`;
const availableAt = sql`greatest(${outbox.nextAttemptAt}, coalesce(${outbox.lockedUntil}, '-infinity'::timestamptz))`;

type OutboxRecord = Readonly<{
  attemptCount: number;
  id: string;
  topic: string;
  payload: unknown;
}>;

@Injectable()
export class OutboxProcessor {
  private readonly workerId = randomUUID();

  public constructor(
    @Inject(DATABASE) private readonly database: Database,
    private readonly objects: ObjectStore,
  ) {}

  public process = async (): Promise<boolean> => {
    const events = await this.claim();
    for (const event of events) {
      try {
        await this.processEvent(event);
        await this.database
          .update(outbox)
          .set({
            lastError: null,
            lockedBy: null,
            lockedUntil: null,
            publishedAt: new Date(),
          })
          .where(
            and(
              eq(outbox.id, event.id),
              eq(outbox.lockedBy, this.workerId),
              isNull(outbox.publishedAt),
            ),
          );
      } catch (error) {
        const attemptCount = event.attemptCount + 1;
        const delaySeconds = Math.min(2 ** attemptCount, 3_600);
        const message: unknown =
          error instanceof Error ? error.message : 'Worker failure';
        const lastError = String(message).replaceAll('\0', '').slice(0, 500);
        const persisted = await this.database
          .update(outbox)
          .set({
            attemptCount,
            failedAt: null,
            lastError,
            lockedBy: null,
            lockedUntil: null,
            nextAttemptAt: new Date(Date.now() + delaySeconds * 1_000),
          })
          .where(
            and(
              eq(outbox.id, event.id),
              eq(outbox.lockedBy, this.workerId),
              isNull(outbox.publishedAt),
            ),
          )
          .returning({ attemptCount: outbox.attemptCount });
        if (persisted.at(0)?.attemptCount === 10) {
          try {
            report(`outbox:${event.topic}`, error);
          } catch {
            continue;
          }
        }
      }
    }
    return events.length > 0;
  };

  public nextWakeDelay = async (
    maximumMilliseconds: number,
  ): Promise<number> => {
    const rows = await this.database
      .select({
        milliseconds: sql<string>`extract(epoch from (${availableAt} - now())) * 1000`,
      })
      .from(outbox)
      .where(isNull(outbox.publishedAt))
      .orderBy(availableAt)
      .limit(1);
    const milliseconds = Number(rows.at(0)?.milliseconds);
    if (!Number.isFinite(milliseconds)) return maximumMilliseconds;
    return Math.min(maximumMilliseconds, Math.max(0, Math.ceil(milliseconds)));
  };

  private readonly claim = async (): Promise<ReadonlyArray<OutboxRecord>> =>
    this.database.transaction(async (transaction) => {
      const events = await transaction
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
            lte(outbox.nextAttemptAt, sql`now()`),
            or(isNull(outbox.lockedUntil), lte(outbox.lockedUntil, sql`now()`)),
          ),
        )
        .orderBy(outbox.nextAttemptAt, outbox.createdAt, outbox.id)
        .limit(20)
        .for('update', { skipLocked: true });
      if (events.length === 0) return events;
      await transaction
        .update(outbox)
        .set({
          lockedBy: this.workerId,
          lockedUntil: claimLease,
        })
        .where(
          inArray(
            outbox.id,
            events.map(({ id }) => id),
          ),
        );
      return events;
    });

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
    const assetRows = await this.database
      .select({
        originalKey: assets.originalKey,
        normalizedKey: assets.normalizedKey,
      })
      .from(assets)
      .where(eq(assets.conversationId, payload.conversationId));
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
      await transaction
        .delete(conversations)
        .where(eq(conversations.id, payload.conversationId));
    });
  };

  private readonly purgeAccount = async (accountId: string): Promise<void> => {
    await Promise.all([
      this.objects.deletePrefix('raw', `uploads/${accountId}/`),
      this.objects.deletePrefix('normalized', `uploads/${accountId}/`),
      this.objects.deletePrefix('archive', `archives/${accountId}/`),
    ]);
    await this.database.transaction(async (transaction) => {
      await transaction.delete(accounts).where(eq(accounts.id, accountId));
    });
  };
}
