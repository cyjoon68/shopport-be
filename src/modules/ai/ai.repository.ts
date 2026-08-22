import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, lte, or, sql } from 'drizzle-orm';
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
import type {
  AiHistoryMessage,
  AiProductRecommendation,
  AskUser,
} from './ai-stream.adapter.js';
import { getKstUsageDate, reserveQuota } from './quota.js';

type BeginRunInput = Readonly<{
  accountId: string;
  conversationId: string;
  runId: string;
  userMessageId: string;
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

export type CancelRunResult = 'cancelled' | 'already_cancelled' | 'terminal';

@Injectable()
export class AiRepository {
  public constructor(@Inject(DATABASE) private readonly database: Database) {}

  public beginRun = (input: BeginRunInput): Promise<boolean> =>
    this.database.transaction(async (transaction) => {
      const now = new Date();
      const usageDate = getKstUsageDate(now);
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${input.userMessageId}))`,
      );
      const existingMessages = await transaction
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.id, input.userMessageId))
        .limit(1);
      if (existingMessages.length > 0) {
        throw new ConflictException('Message already exists');
      }
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
          deadlineAt: new Date(now.getTime() + 60_000),
          heartbeatAt: now,
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

      await transaction.insert(messages).values({
        id: input.userMessageId,
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
          messageId: input.userMessageId,
          kind: 'text',
          position: parts.length,
          payload: { text: input.text },
        });
      }
      if (input.assetId) {
        parts.push({
          id: uuidv7(),
          messageId: input.userMessageId,
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

  public completeRun = (
    runId: string,
    conversationId: string,
    messageId: string,
    text: string,
    productRecommendations: ReadonlyArray<AiProductRecommendation>,
    askUser: AskUser | null,
  ): Promise<void> =>
    this.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(aiRuns)
        .set({ status: 'completed', completedAt: new Date() })
        .where(and(eq(aiRuns.id, runId), eq(aiRuns.status, 'reserved')))
        .returning({ id: aiRuns.id });
      if (updated.length === 0) return;
      await transaction.insert(messages).values({
        id: messageId,
        conversationId,
        role: 'assistant',
        runId,
        status: 'completed',
      });
      const parts: Array<NewMessagePart> = [];
      if (text.length > 0) {
        parts.push({
          id: uuidv7(),
          messageId,
          kind: 'text',
          position: parts.length,
          payload: { text },
        });
      }
      if (askUser) {
        parts.push({
          id: uuidv7(),
          messageId,
          kind: 'ask_user',
          position: parts.length,
          payload: askUser,
        });
      }
      const productPosition = parts.length;
      parts.push(
        ...productRecommendations.map(({ productId, aiSummary }, index) => ({
          id: uuidv7(),
          messageId,
          kind: 'product_reference',
          position: productPosition + index,
          payload: { productId, aiSummary },
        })),
      );
      await transaction.insert(messageParts).values(parts);
    });

  public conversationHistory = async (
    accountId: string,
    conversationId: string,
  ): Promise<ReadonlyArray<AiHistoryMessage>> => {
    const recentMessages = this.database
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(
        conversations,
        and(
          eq(conversations.id, messages.conversationId),
          eq(conversations.accountId, accountId),
        ),
      )
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.status, 'completed'),
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(12)
      .as('recent_messages');
    const rows = await this.database
      .select({
        messageId: messages.id,
        role: messages.role,
        kind: messageParts.kind,
        position: messageParts.position,
        payload: messageParts.payload,
      })
      .from(recentMessages)
      .innerJoin(messages, eq(messages.id, recentMessages.id))
      .innerJoin(messageParts, eq(messageParts.messageId, messages.id))
      .where(
        or(eq(messageParts.kind, 'text'), eq(messageParts.kind, 'ask_user')),
      )
      .orderBy(messages.createdAt, messages.id, messageParts.position);
    const grouped = new Map<string, AiHistoryMessage>();
    for (const row of rows) {
      if (row.role !== 'user' && row.role !== 'assistant') continue;
      let text = '';
      if (row.kind === 'text') {
        const payload = row.payload as { text?: unknown };
        if (typeof payload.text === 'string') text = payload.text;
      }
      if (row.kind === 'ask_user') {
        const payload = row.payload as {
          question?: unknown;
          options?: Array<{ label?: unknown }>;
        };
        if (typeof payload.question === 'string') {
          const labels = Array.isArray(payload.options)
            ? payload.options
                .map(({ label }) => (typeof label === 'string' ? label : ''))
                .filter(Boolean)
                .join(', ')
            : '';
          text = `${payload.question}${labels ? ` 선택지: ${labels}` : ''}`;
        }
      }
      if (!text) continue;
      const previous = grouped.get(row.messageId);
      grouped.set(row.messageId, {
        role: row.role,
        text: previous ? `${previous.text}\n${text}` : text,
      });
    }
    const bounded: Array<AiHistoryMessage> = [];
    let characters = 0;
    for (const message of [...grouped.values()].reverse()) {
      if (bounded.length >= 12 || characters + message.text.length > 8_000)
        break;
      bounded.unshift(message);
      characters += message.text.length;
    }
    return bounded;
  };

  public failRun = (runId: string): Promise<void> =>
    this.database.transaction(async (transaction) => {
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
        .set({ ...countUpdate, updatedAt: new Date() })
        .where(
          and(
            eq(dailyUsage.accountId, run.accountId),
            eq(dailyUsage.usageDate, run.usageDate),
          ),
        );
    });

  public assertOwnedRun = async (
    accountId: string,
    runId: string,
    conversationId?: string,
  ): Promise<void> => {
    const rows = await this.database
      .select({ id: aiRuns.id })
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.id, runId),
          eq(aiRuns.accountId, accountId),
          conversationId
            ? eq(aiRuns.conversationId, conversationId)
            : undefined,
        ),
      )
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('Run not found');
  };

  public cancelRun = (
    accountId: string,
    conversationId: string,
    runId: string,
  ): Promise<CancelRunResult> =>
    this.database.transaction(async (transaction) => {
      const runs = await transaction
        .update(aiRuns)
        .set({ status: 'cancelled', completedAt: new Date() })
        .where(
          and(
            eq(aiRuns.id, runId),
            eq(aiRuns.accountId, accountId),
            eq(aiRuns.conversationId, conversationId),
            eq(aiRuns.status, 'reserved'),
          ),
        )
        .returning({
          accountId: aiRuns.accountId,
          usageDate: aiRuns.usageDate,
          usageKind: aiRuns.usageKind,
        });
      const run = runs.at(0);
      if (run) {
        const countUpdate =
          run.usageKind === 'image'
            ? { imageCount: sql`greatest(${dailyUsage.imageCount} - 1, 0)` }
            : { textCount: sql`greatest(${dailyUsage.textCount} - 1, 0)` };
        await transaction
          .update(dailyUsage)
          .set({ ...countUpdate, updatedAt: new Date() })
          .where(
            and(
              eq(dailyUsage.accountId, run.accountId),
              eq(dailyUsage.usageDate, run.usageDate),
            ),
          );
        return 'cancelled';
      }
      const owned = await transaction
        .select({ status: aiRuns.status })
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.id, runId),
            eq(aiRuns.accountId, accountId),
            eq(aiRuns.conversationId, conversationId),
          ),
        )
        .limit(1);
      if (owned.length === 0) throw new NotFoundException('Run not found');
      return owned.at(0)?.status === 'cancelled'
        ? 'already_cancelled'
        : 'terminal';
    });

  public heartbeatRun = async (
    runId: string,
    now = new Date(),
  ): Promise<void> => {
    await this.database
      .update(aiRuns)
      .set({ heartbeatAt: now })
      .where(and(eq(aiRuns.id, runId), eq(aiRuns.status, 'reserved')));
  };

  public recoverStaleReservedRuns = (now = new Date()): Promise<number> =>
    this.database.transaction(async (transaction) => {
      const heartbeatCutoff = new Date(now.getTime() - 120_000);
      const staleRuns = await transaction
        .select({ id: aiRuns.id })
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.status, 'reserved'),
            or(
              lte(aiRuns.deadlineAt, now),
              lte(aiRuns.heartbeatAt, heartbeatCutoff),
            ),
          ),
        )
        .for('update', { skipLocked: true });
      let recovered = 0;
      for (const stale of staleRuns) {
        const runs = await transaction
          .update(aiRuns)
          .set({ status: 'failed', completedAt: now })
          .where(and(eq(aiRuns.id, stale.id), eq(aiRuns.status, 'reserved')))
          .returning({
            accountId: aiRuns.accountId,
            usageDate: aiRuns.usageDate,
            usageKind: aiRuns.usageKind,
          });
        const run = runs.at(0);
        if (!run) continue;
        const countUpdate =
          run.usageKind === 'image'
            ? { imageCount: sql`greatest(${dailyUsage.imageCount} - 1, 0)` }
            : { textCount: sql`greatest(${dailyUsage.textCount} - 1, 0)` };
        await transaction
          .update(dailyUsage)
          .set({ ...countUpdate, updatedAt: now })
          .where(
            and(
              eq(dailyUsage.accountId, run.accountId),
              eq(dailyUsage.usageDate, run.usageDate),
            ),
          );
        recovered += 1;
      }
      return recovered;
    });
}
