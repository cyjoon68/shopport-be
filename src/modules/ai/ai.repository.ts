import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { DATABASE } from '../../database/database.module.js';
import type { Database } from '../../database/database.module.js';
import {
  accounts,
  aiRuns,
  assets,
  conversations,
  dailyUsage,
  entitlements,
  messageParts,
  messages,
} from '../../database/schema.js';
import { AiAccessError } from './ai.errors.js';
import { getKstUsageDate, reserveQuota } from './quota.js';

type BeginRunInput = Readonly<{
  accountId: string;
  conversationId: string;
  runId: string;
  text: string;
  assetId: string | null;
}>;

type NewMessagePart = {
  id: string;
  messageId: string;
  kind: string;
  position: number;
  payload: unknown;
};

@Injectable()
export class AiRepository {
  public constructor(@Inject(DATABASE) private readonly database: Database) {}

  public beginRun(input: BeginRunInput): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const now = new Date();
      const usageDate = getKstUsageDate(now);
      const inserted = await transaction
        .insert(aiRuns)
        .values({
          id: input.runId,
          accountId: input.accountId,
          conversationId: input.conversationId,
          usageDate,
          usageKind: input.assetId ? 'image' : 'text',
          status: 'reserved',
          startedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: aiRuns.id });
      if (inserted.length === 0) return false;

      const accessRows = await transaction
        .select({
          trialEndsAt: accounts.trialEndsAt,
          entitlementKey: entitlements.key,
          entitlementExpiresAt: entitlements.expiresAt,
        })
        .from(accounts)
        .innerJoin(entitlements, eq(accounts.id, entitlements.accountId))
        .innerJoin(
          conversations,
          and(
            eq(conversations.accountId, accounts.id),
            eq(conversations.id, input.conversationId),
          ),
        )
        .where(eq(accounts.id, input.accountId))
        .limit(1);
      const access = accessRows.at(0);
      if (!access) throw new NotFoundException('Conversation not found');
      const isPro =
        access.entitlementKey === 'pro' &&
        (access.entitlementExpiresAt === null ||
          access.entitlementExpiresAt > now);
      if (!isPro && access.trialEndsAt <= now) {
        throw new AiAccessError('TRIAL_EXPIRED');
      }
      if (input.assetId) {
        const assetRows = await transaction
          .select({ id: assets.id })
          .from(assets)
          .where(
            and(
              eq(assets.id, input.assetId),
              eq(assets.accountId, input.accountId),
              eq(assets.conversationId, input.conversationId),
              eq(assets.status, 'ready'),
            ),
          )
          .limit(1);
        if (assetRows.length !== 1) {
          throw new NotFoundException('Ready image asset not found');
        }
      }

      await transaction
        .insert(dailyUsage)
        .values({ accountId: input.accountId, usageDate })
        .onConflictDoNothing();
      const usageRows = await transaction
        .select({
          textCount: dailyUsage.textCount,
          imageCount: dailyUsage.imageCount,
        })
        .from(dailyUsage)
        .where(
          and(
            eq(dailyUsage.accountId, input.accountId),
            eq(dailyUsage.usageDate, usageDate),
          ),
        )
        .for('update');
      const usage = usageRows.at(0);
      if (!usage) throw new Error('Usage reservation failed');
      let reserved;
      try {
        reserved = reserveQuota(
          usage,
          { hasText: input.text.length > 0, hasImage: input.assetId !== null },
          isPro ? 'pro' : 'trial',
        );
      } catch {
        throw new AiAccessError('QUOTA_EXCEEDED');
      }
      await transaction
        .update(dailyUsage)
        .set({ ...reserved, updatedAt: now })
        .where(
          and(
            eq(dailyUsage.accountId, input.accountId),
            eq(dailyUsage.usageDate, usageDate),
          ),
        );

      const messageId = uuidv7();
      await transaction.insert(messages).values({
        id: messageId,
        conversationId: input.conversationId,
        role: 'user',
        runId: input.runId,
        status: 'completed',
        createdAt: now,
      });
      const parts: Array<NewMessagePart> = [];
      if (input.text.length > 0) {
        parts.push({
          id: uuidv7(),
          messageId,
          kind: 'text',
          position: parts.length,
          payload: { text: input.text },
        });
      }
      if (input.assetId) {
        parts.push({
          id: uuidv7(),
          messageId,
          kind: 'image',
          position: parts.length,
          payload: {
            id: input.assetId,
            status: 'PROCESSING',
            url: null,
            width: null,
            height: null,
            createdAt: now.toISOString(),
          },
        });
      }
      if (parts.length > 0)
        await transaction.insert(messageParts).values(parts);
      return true;
    });
  }

  public completeRun(
    runId: string,
    conversationId: string,
    text: string,
    productIds: ReadonlyArray<string>,
  ): Promise<void> {
    return this.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(aiRuns)
        .set({ status: 'completed', completedAt: new Date() })
        .where(and(eq(aiRuns.id, runId), eq(aiRuns.status, 'reserved')))
        .returning({ id: aiRuns.id });
      if (updated.length === 0) return;
      const messageId = uuidv7();
      await transaction.insert(messages).values({
        id: messageId,
        conversationId,
        role: 'assistant',
        runId,
        status: 'completed',
      });
      const parts = [
        {
          id: uuidv7(),
          messageId,
          kind: 'text',
          position: 0,
          payload: { text },
        },
        ...productIds.map((productId, index) => ({
          id: uuidv7(),
          messageId,
          kind: 'product_reference',
          position: index + 1,
          payload: { productId },
        })),
      ];
      await transaction.insert(messageParts).values(parts);
    });
  }

  public failRun(runId: string): Promise<void> {
    return this.database.transaction(async (transaction) => {
      const runs = await transaction
        .update(aiRuns)
        .set({ status: 'failed', completedAt: new Date() })
        .where(and(eq(aiRuns.id, runId), eq(aiRuns.status, 'reserved')))
        .returning({
          accountId: aiRuns.accountId,
          usageDate: aiRuns.usageDate,
          usageKind: aiRuns.usageKind,
        });
      const run = runs.at(0);
      if (!run) return;
      const countUpdate =
        run.usageKind === 'image'
          ? { imageCount: sql`greatest(${dailyUsage.imageCount} - 1, 0)` }
          : { textCount: sql`greatest(${dailyUsage.textCount} - 1, 0)` };
      await transaction
        .update(dailyUsage)
        .set(countUpdate)
        .where(
          and(
            eq(dailyUsage.accountId, run.accountId),
            eq(dailyUsage.usageDate, run.usageDate),
          ),
        );
    });
  }
}
