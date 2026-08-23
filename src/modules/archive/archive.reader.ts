import { Inject, Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';

import type { Database } from '../../database/database.module.js';
import { DATABASE } from '../../database/database.module.js';
import { archiveManifests } from '../../database/schema.js';
import { ObjectStore } from '../../storage/object-store.js';
import type {
  MessagePartRecord,
  MessageRecord,
} from '../conversations/conversation.types.js';
import { decodeArchive } from './archive-format.js';

export type ArchiveBundle = Readonly<{
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
      .orderBy(archiveManifests.fromAt);
    const loaded = await Promise.all(
      manifests.map(async (manifest) => ({
        conversationId: manifest.conversationId,
        records: decodeArchive(
          await this.objects.get('archive', manifest.objectKey),
          manifest.checksum,
        ),
      })),
    );
    const bundles = new Map<
      string,
      { messages: MessageRecord[]; parts: MessagePartRecord[] }
    >();
    for (const archive of loaded) {
      const bundle = bundles.get(archive.conversationId) ?? {
        messages: [],
        parts: [],
      };
      for (const record of archive.records) {
        bundle.messages.push({
          ...record.message,
          createdAt: new Date(record.message.createdAt),
        });
        bundle.parts.push(...record.parts);
      }
      bundles.set(archive.conversationId, bundle);
    }
    return bundles;
  }
}
