import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { Database } from '../../database/database.module.js';
import { DATABASE } from '../../database/database.module.js';
import {
  aiRunEvents,
  aiRuns,
  assets,
  conversations,
  messageParts,
  messages,
  rateLimits,
} from '../../database/schema.js';
import { DEFAULT_CONVERSATION_TITLE } from '../conversations/conversation.types.js';
import type { AiProviderId } from './ai-request.js';
import { providerIdsSchema } from './ai-request.js';
import type { AiHistoryMessage, CompleteRunInput } from './types.js';

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

type CancelRunResult = 'cancelled' | 'already_cancelled' | 'terminal';

const runLeaseMilliseconds = 60_000;

const providerIdsFromAskUser = (
  payload: unknown,
): ReadonlyArray<AiProviderId> => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
    return [];
  const value = (payload as Record<string, unknown>).providerIds;
  if (value === undefined) return [];
  const parsed = providerIdsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
};

@Injectable()
export class AiRepository {
  public constructor(@Inject(DATABASE) private readonly database: Database) {}

  public beginRun = (input: BeginRunInput): Promise<boolean> =>
    this.database.transaction(async (transaction) => {
      const now = new Date();
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
          status: 'reserved',
          startedAt: now,
          deadlineAt: new Date(now.getTime() + runLeaseMilliseconds),
          heartbeatAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: aiRuns.id });
      if (inserted.length === 0) return false;

      const ownedConversations = await transaction
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, input.conversationId),
            eq(conversations.accountId, input.accountId),
            isNull(conversations.deletedAt),
          ),
        )
        .limit(1);
      if (ownedConversations.length === 0)
        throw new NotFoundException('Conversation not found');
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

  public completeRun = (input: CompleteRunInput): Promise<void> =>
    this.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(aiRuns)
        .set({ status: 'completed', completedAt: new Date() })
        .where(and(eq(aiRuns.id, input.runId), eq(aiRuns.status, 'reserved')))
        .returning({ id: aiRuns.id });
      if (updated.length !== 1)
        throw new ConflictException('AI run lease lost');
      await transaction.insert(messages).values({
        id: input.messageId,
        conversationId: input.conversationId,
        role: 'assistant',
        runId: input.runId,
        status: 'completed',
      });
      const parts: Array<NewMessagePart> = [];
      if (input.text.length > 0) {
        parts.push({
          id: uuidv7(),
          messageId: input.messageId,
          kind: 'text',
          position: parts.length,
          payload: { text: input.text },
        });
      }
      if (input.askUser) {
        parts.push({
          id: uuidv7(),
          messageId: input.messageId,
          kind: 'ask_user',
          position: parts.length,
          payload:
            input.providerIds.length > 0
              ? { ...input.askUser, providerIds: input.providerIds }
              : input.askUser,
        });
      }
      const productPosition = parts.length;
      parts.push(
        ...input.productRecommendations.map(
          ({ productId, aiSummary, productSnapshot }, index) => ({
            id: uuidv7(),
            messageId: input.messageId,
            kind: 'product_reference',
            position: productPosition + index,
            payload: { productId, aiSummary, productSnapshot },
          }),
        ),
      );
      await transaction.insert(messageParts).values(parts);
    });

  public pendingProviderIds = async (
    accountId: string,
    conversationId: string,
  ): Promise<ReadonlyArray<AiProviderId>> => {
    const latestAssistant = await this.database
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
          eq(messages.role, 'assistant'),
          eq(messages.status, 'completed'),
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(1);
    const messageId = latestAssistant.at(0)?.id;
    if (!messageId) return [];
    const askUser = await this.database
      .select({ payload: messageParts.payload })
      .from(messageParts)
      .where(
        and(
          eq(messageParts.messageId, messageId),
          eq(messageParts.kind, 'ask_user'),
        ),
      )
      .limit(1);
    return providerIdsFromAskUser(askUser.at(0)?.payload);
  };

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

  public replaceDefaultTitle = async (
    accountId: string,
    conversationId: string,
    title: string,
  ): Promise<void> => {
    await this.database
      .update(conversations)
      .set({ title, updatedAt: new Date() })
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.accountId, accountId),
          eq(conversations.title, DEFAULT_CONVERSATION_TITLE),
          isNull(conversations.deletedAt),
        ),
      );
  };

  public failRun = async (runId: string): Promise<void> => {
    await this.database
      .update(aiRuns)
      .set({ status: 'failed', completedAt: new Date() })
      .where(and(eq(aiRuns.id, runId), eq(aiRuns.status, 'reserved')));
  };

  public isRunCancelled = async (runId: string): Promise<boolean> => {
    const runs = await this.database
      .select({ status: aiRuns.status })
      .from(aiRuns)
      .where(eq(aiRuns.id, runId))
      .limit(1);
    return runs.at(0)?.status === 'cancelled';
  };

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
      const now = new Date();
      const runs = await transaction
        .update(aiRuns)
        .set({ status: 'cancelled', completedAt: now, streamClosedAt: now })
        .where(
          and(
            eq(aiRuns.id, runId),
            eq(aiRuns.accountId, accountId),
            eq(aiRuns.conversationId, conversationId),
            eq(aiRuns.status, 'reserved'),
          ),
        )
        .returning({ id: aiRuns.id });
      const run = runs.at(0);
      if (run) return 'cancelled';
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

  public renewRunLease = async (
    runId: string,
    now = new Date(),
  ): Promise<void> => {
    const updated = await this.database
      .update(aiRuns)
      .set({
        heartbeatAt: now,
        deadlineAt: new Date(now.getTime() + runLeaseMilliseconds),
      })
      .where(and(eq(aiRuns.id, runId), eq(aiRuns.status, 'reserved')))
      .returning({ id: aiRuns.id });
    if (updated.length !== 1) throw new ConflictException('AI run lease lost');
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
          .set({
            status: 'failed',
            completedAt: now,
            streamClosedAt: now,
          })
          .where(and(eq(aiRuns.id, stale.id), eq(aiRuns.status, 'reserved')))
          .returning({ id: aiRuns.id });
        const run = runs.at(0);
        if (!run) continue;
        recovered += 1;
      }
      return recovered;
    });

  public cleanupRuntimeState = async (now = new Date()): Promise<void> => {
    await Promise.all([
      this.database.delete(aiRunEvents).where(lte(aiRunEvents.expiresAt, now)),
      this.database
        .delete(rateLimits)
        .where(
          and(
            lte(rateLimits.windowExpiresAt, now),
            or(
              isNull(rateLimits.blockedUntil),
              lte(rateLimits.blockedUntil, now),
            ),
          ),
        ),
    ]);
  };
}
