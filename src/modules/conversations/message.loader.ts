import { Injectable, Scope } from '@nestjs/common';
import DataLoader from 'dataloader';

import { ArchiveReader } from '../archive/archive.reader.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { ConversationRepository } from './conversation.repository.js';
import type { MessageGraphql } from './conversation.types.js';
import { mapMessages } from './message.mapper.js';

const maximumMessages = 50;

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
        const currentMessages = await repository.messagesFor(
          conversationIds,
          maximumMessages,
        );
        const currentCounts = new Map<string, number>();
        for (const message of currentMessages) {
          currentCounts.set(
            message.conversationId,
            (currentCounts.get(message.conversationId) ?? 0) + 1,
          );
        }
        const archived = await archives.forConversations(
          conversationIds,
          new Map(
            conversationIds.map((id) => [
              id,
              maximumMessages - (currentCounts.get(id) ?? 0),
            ]),
          ),
        );
        const messages = conversationIds.flatMap((id) =>
          [
            ...currentMessages.filter(
              ({ conversationId }) => conversationId === id,
            ),
            ...(archived.get(id)?.messages ?? []),
          ]
            .sort(
              (left, right) =>
                left.createdAt.getTime() - right.createdAt.getTime(),
            )
            .slice(-maximumMessages),
        );
        const messageIds = new Set(messages.map(({ id }) => id));
        const currentParts = await repository.partsFor([...messageIds]);
        const parts = [
          ...currentParts,
          ...conversationIds.flatMap((id) =>
            (archived.get(id)?.parts ?? []).filter(({ messageId }) =>
              messageIds.has(messageId),
            ),
          ),
        ];
        const mapped = await mapMessages(messages, parts, catalog);
        const sourceById = new Map(
          messages.map((message) => [message.id, message] as const),
        );
        const grouped = new Map<string, Array<MessageGraphql>>();
        for (const message of mapped) {
          const source = sourceById.get(message.id);
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
