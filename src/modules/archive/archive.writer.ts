import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, inArray, lt } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { Database } from '../../database/database.module.js';
import { DATABASE } from '../../database/database.module.js';
import {
  archiveManifests,
  conversations,
  messageParts,
  messages,
} from '../../database/schema.js';
import { ObjectStore } from '../../storage/object-store.js';
import type { ArchiveRecord } from './archive-format.js';
import { decodeArchive, encodeArchive } from './archive-format.js';

type PendingMessage = Readonly<{
  id: string;
  accountId: string;
  conversationId: string;
  role: string;
  status: string;
  createdAt: Date;
}>;

type ArchiveDatabase = Pick<Database, 'delete' | 'insert' | 'select'>;

@Injectable()
export class ArchiveWriter {
  public constructor(
    @Inject(DATABASE) private readonly database: Database,
    private readonly objects: ObjectStore,
  ) {}

  public archive = (): Promise<boolean> =>
    this.database.transaction(async (transaction) => {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000);
      const pending = await transaction
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
        .limit(500)
        .for('update', { skipLocked: true });
      if (pending.length === 0) return false;
      const grouped = new Map<string, PendingMessage[]>();
      for (const message of pending) {
        const group = grouped.get(message.conversationId) ?? [];
        group.push(message);
        grouped.set(message.conversationId, group);
      }
      for (const group of grouped.values()) {
        await this.archiveGroup(transaction, group);
      }
      return true;
    });

  private readonly archiveGroup = async (
    database: ArchiveDatabase,
    group: ReadonlyArray<PendingMessage>,
  ): Promise<void> => {
    const first = group.at(0);
    const last = group.at(-1);
    if (!first || !last) return;
    const ids = group.map(({ id }) => id);
    const parts = await database
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
    const partsByMessage = new Map<string, typeof parts>();
    for (const part of parts) {
      const messagePartsForId = partsByMessage.get(part.messageId) ?? [];
      messagePartsForId.push(part);
      partsByMessage.set(part.messageId, messagePartsForId);
    }
    const records: ReadonlyArray<ArchiveRecord> = group.map((message) => ({
      message: {
        id: message.id,
        conversationId: message.conversationId,
        role: message.role,
        status: message.status,
        createdAt: message.createdAt.toISOString(),
      },
      parts: partsByMessage.get(message.id) ?? [],
    }));
    const encoded = encodeArchive(records);
    const objectKey = `archives/${first.accountId}/${first.conversationId}/${first.id}-${last.id}.ndjson.gz`;
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
    await database.insert(archiveManifests).values({
      id: uuidv7(),
      accountId: first.accountId,
      conversationId: first.conversationId,
      objectKey,
      checksum: encoded.checksum,
      fromAt: first.createdAt,
      toAt: last.createdAt,
      messageCount: group.length,
    });
    await database
      .delete(messageParts)
      .where(inArray(messageParts.messageId, ids));
    await database.delete(messages).where(inArray(messages.id, ids));
  };
}
