import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, inArray, lt } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { DATABASE } from '../../database/database.module.js';
import type { Database } from '../../database/database.module.js';
import {
  archiveManifests,
  conversations,
  messageParts,
  messages,
} from '../../database/schema.js';
import { ObjectStore } from '../../storage/object-store.js';
import { decodeArchive, encodeArchive } from './archive-format.js';
import type { ArchiveRecord } from './archive-format.js';

type PendingMessage = Readonly<{
  id: string;
  accountId: string;
  conversationId: string;
  role: string;
  status: string;
  createdAt: Date;
}>;

@Injectable()
export class ArchiveWriter {
  public constructor(
    @Inject(DATABASE) private readonly database: Database,
    private readonly objects: ObjectStore,
  ) {}

  public async archive(): Promise<boolean> {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000);
    const pending = await this.database
      .select({
        id: messages.id,
        accountId: conversations.accountId,
        conversationId: messages.conversationId,
        role: messages.role,
        status: messages.status,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(lt(messages.createdAt, cutoff))
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .limit(500);
    if (pending.length === 0) return false;
    const grouped = new Map<string, PendingMessage[]>();
    for (const message of pending) {
      const group = grouped.get(message.conversationId) ?? [];
      group.push(message);
      grouped.set(message.conversationId, group);
    }
    for (const group of grouped.values()) await this.archiveGroup(group);
    return true;
  }

  private readonly archiveGroup = async (
    group: ReadonlyArray<PendingMessage>,
  ): Promise<void> => {
    const first = group.at(0);
    const last = group.at(-1);
    if (!first || !last) return;
    const ids = group.map(({ id }) => id);
    const parts = await this.database
      .select({
        id: messageParts.id,
        messageId: messageParts.messageId,
        kind: messageParts.kind,
        position: messageParts.position,
        payload: messageParts.payload,
      })
      .from(messageParts)
      .where(inArray(messageParts.messageId, ids))
      .orderBy(messageParts.position);
    const records: ReadonlyArray<ArchiveRecord> = group.map((message) => ({
      message: {
        id: message.id,
        conversationId: message.conversationId,
        role: message.role,
        status: message.status,
        createdAt: message.createdAt.toISOString(),
      },
      parts: parts.filter(({ messageId }) => messageId === message.id),
    }));
    const encoded = encodeArchive(records);
    const objectKey = `archives/${first.accountId}/${first.conversationId}/${String(first.createdAt.getTime())}-${String(last.createdAt.getTime())}-${uuidv7()}.ndjson.gz`;
    await this.objects.put(
      'archive',
      objectKey,
      encoded.body,
      'application/x-ndjson',
      encoded.checksum,
    );
    decodeArchive(
      await this.objects.get('archive', objectKey),
      encoded.checksum,
    );
    await this.database.transaction(async (transaction) => {
      await transaction.insert(archiveManifests).values({
        id: uuidv7(),
        accountId: first.accountId,
        conversationId: first.conversationId,
        objectKey,
        checksum: encoded.checksum,
        fromAt: first.createdAt,
        toAt: last.createdAt,
        messageCount: group.length,
      });
      await transaction
        .delete(messageParts)
        .where(inArray(messageParts.messageId, ids));
      await transaction.delete(messages).where(inArray(messages.id, ids));
    });
  };
}
