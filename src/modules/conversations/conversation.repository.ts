import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { CursorPayload } from '../../common/cursor.js';
import type { Database } from '../../database/database.module.js';
import { DATABASE } from '../../database/database.module.js';
import {
  conversations,
  messageParts,
  messages,
  outbox,
} from '../../database/schema.js';
import type {
  ConversationRecord,
  MessagePartRecord,
  MessageRecord,
} from './conversation.types.js';

@Injectable()
export class ConversationRepository {
  public constructor(@Inject(DATABASE) private readonly database: Database) {}

  public async list(
    accountId: string,
    first: number,
    after: CursorPayload | null,
  ): Promise<ReadonlyArray<ConversationRecord>> {
    const cursorCondition = after
      ? or(
          lt(conversations.createdAt, new Date(after.createdAt)),
          and(
            eq(conversations.createdAt, new Date(after.createdAt)),
            lt(conversations.id, after.id),
          ),
        )
      : undefined;
    return this.database
      .select({
        id: conversations.id,
        title: conversations.title,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.accountId, accountId),
          isNull(conversations.deletedAt),
          cursorCondition,
        ),
      )
      .orderBy(desc(conversations.createdAt), desc(conversations.id))
      .limit(first + 1);
  }

  public async findOwned(
    accountId: string,
    id: string,
  ): Promise<ConversationRecord | null> {
    const rows = await this.database
      .select({
        id: conversations.id,
        title: conversations.title,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, id),
          eq(conversations.accountId, accountId),
          isNull(conversations.deletedAt),
        ),
      )
      .limit(1);
    return rows.at(0) ?? null;
  }

  public async create(
    accountId: string,
    title: string,
  ): Promise<ConversationRecord> {
    const record = {
      id: uuidv7(),
      accountId,
      title,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await this.database.insert(conversations).values(record);
    return record;
  }

  public async rename(
    accountId: string,
    id: string,
    title: string,
  ): Promise<ConversationRecord | null> {
    const rows = await this.database
      .update(conversations)
      .set({ title, updatedAt: new Date() })
      .where(
        and(
          eq(conversations.id, id),
          eq(conversations.accountId, accountId),
          isNull(conversations.deletedAt),
        ),
      )
      .returning({
        id: conversations.id,
        title: conversations.title,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
      });
    return rows.at(0) ?? null;
  }

  public async delete(accountId: string, id: string): Promise<boolean> {
    const deletedAt = new Date();
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .update(conversations)
        .set({ deletedAt, updatedAt: deletedAt })
        .where(
          and(
            eq(conversations.id, id),
            eq(conversations.accountId, accountId),
            isNull(conversations.deletedAt),
          ),
        )
        .returning({ id: conversations.id });
      if (rows.length === 0) return false;
      await transaction.insert(outbox).values({
        id: uuidv7(),
        topic: 'conversation.purge',
        payload: { accountId, conversationId: id },
      });
      return true;
    });
  }

  public async messagesFor(
    conversationIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<MessageRecord>> {
    if (conversationIds.length === 0) return [];
    return this.database
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        role: messages.role,
        status: messages.status,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(inArray(messages.conversationId, [...conversationIds]))
      .orderBy(messages.createdAt, messages.id);
  }

  public async partsFor(
    messageIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<MessagePartRecord>> {
    if (messageIds.length === 0) return [];
    return this.database
      .select({
        id: messageParts.id,
        messageId: messageParts.messageId,
        kind: messageParts.kind,
        position: messageParts.position,
        payload: messageParts.payload,
      })
      .from(messageParts)
      .where(inArray(messageParts.messageId, [...messageIds]))
      .orderBy(messageParts.position);
  }
}
