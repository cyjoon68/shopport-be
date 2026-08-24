import { Inject, Injectable } from '@nestjs/common';
import { desc, inArray } from 'drizzle-orm';

import type { Database } from '../../database/database.module.js';
import { DATABASE } from '../../database/database.module.js';
import { archiveManifests } from '../../database/schema.js';
import { ObjectStore } from '../../storage/object-store.js';
import type {
  MessagePartRecord,
  MessageRecord,
} from '../conversations/conversation.types.js';
import { decodeArchiveAsync } from './archive-format.js';

type ArchiveBundle = Readonly<{
  messages: ReadonlyArray<MessageRecord>;
  parts: ReadonlyArray<MessagePartRecord>;
}>;

@Injectable()
export class ArchiveReader {
  public constructor(
    @Inject(DATABASE) private readonly database: Database,
    private readonly objects: ObjectStore,
  ) {}

  public async forConversations(
    conversationIds: ReadonlyArray<string>,
    limits?: ReadonlyMap<string, number>,
  ): Promise<ReadonlyMap<string, ArchiveBundle>> {
    if (conversationIds.length === 0) return new Map();
    const manifests = await this.database
      .select({
        conversationId: archiveManifests.conversationId,
        objectKey: archiveManifests.objectKey,
        checksum: archiveManifests.checksum,
      })
      .from(archiveManifests)
      .where(inArray(archiveManifests.conversationId, [...conversationIds]))
      .orderBy(desc(archiveManifests.fromAt));
    const remaining = new Map(limits);
    const bundles = new Map<
      string,
      { messages: MessageRecord[]; parts: MessagePartRecord[] }
    >();
    for (const manifest of manifests) {
      const limit = limits
        ? (remaining.get(manifest.conversationId) ?? 0)
        : Infinity;
      if (limit <= 0) continue;
      const records = await decodeArchiveAsync(
        await this.objects.get('archive', manifest.objectKey),
        manifest.checksum,
      );
      const selected = records.slice(-limit);
      const bundle = bundles.get(manifest.conversationId) ?? {
        messages: [],
        parts: [],
      };
      for (const record of selected) {
        bundle.messages.push({
          ...record.message,
          createdAt: new Date(record.message.createdAt),
        });
        bundle.parts.push(...record.parts);
      }
      bundles.set(manifest.conversationId, bundle);
      if (limits)
        remaining.set(manifest.conversationId, limit - selected.length);
    }
    return bundles;
  }
}
