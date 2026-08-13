import { Injectable, Scope } from '@nestjs/common';
import DataLoader from 'dataloader';
import { CatalogService } from '../catalog/catalog.service.js';
import { ArchiveReader } from '../archive/archive.reader.js';
import { ConversationRepository } from './conversation.repository.js';
import type { MessageGraphql } from './conversation.types.js';
import { mapMessages } from './message.mapper.js';

@Injectable({ scope: Scope.REQUEST })
export class MessageLoader {
  readonly #loader: DataLoader<string, ReadonlyArray<MessageGraphql>>;

  public constructor(
    repository: ConversationRepository,
    catalog: CatalogService,
    archives: ArchiveReader,
  ) {
    this.#loader = new DataLoader(
      async (conversationIds: ReadonlyArray<string>) => {
        const [currentMessages, archived] = await Promise.all([
          repository.messagesFor(conversationIds),
          archives.forConversations(conversationIds),
        ]);
        const currentParts = await repository.partsFor(
          currentMessages.map(({ id }) => id),
        );
        const messages = [
          ...currentMessages,
          ...conversationIds.flatMap((id) => archived.get(id)?.messages ?? []),
        ].sort(
          (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
        );
        const parts = [
          ...currentParts,
          ...conversationIds.flatMap((id) => archived.get(id)?.parts ?? []),
        ];
        const mapped = await mapMessages(messages, parts, catalog);
        const grouped = new Map<string, Array<MessageGraphql>>();
        for (const message of mapped) {
          const source = messages.find(({ id }) => id === message.id);
          if (!source) continue;
          const current = grouped.get(source.conversationId) ?? [];
          current.push(message);
          grouped.set(source.conversationId, current);
        }
        return conversationIds.map((id) => grouped.get(id) ?? []);
      },
    );
  }

  public load = (
    conversationId: string,
  ): Promise<ReadonlyArray<MessageGraphql>> =>
    this.#loader.load(conversationId);
}
