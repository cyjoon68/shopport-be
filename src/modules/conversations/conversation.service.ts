import { Injectable } from '@nestjs/common';

import { decodeCursor, encodeCursor } from '../../common/cursor.js';
import { ConversationRepository } from './conversation.repository.js';
import type { ConversationRecord } from './conversation.types.js';

export type ConversationConnection = Readonly<{
  edges: ReadonlyArray<Readonly<{ cursor: string; node: ConversationRecord }>>;
  pageInfo: Readonly<{
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  }>;
}>;

@Injectable()
export class ConversationService {
  public constructor(private readonly repository: ConversationRepository) {}

  public async list(
    accountId: string,
    requestedFirst: number,
    after: string | null,
  ): Promise<ConversationConnection> {
    const first = Math.min(Math.max(requestedFirst, 1), 50);
    const cursor = after ?? null;
    const records = await this.repository.list(
      accountId,
      first,
      decodeCursor(cursor),
    );
    const hasNextPage = records.length > first;
    const page = records.slice(0, first);
    const edges = page.map((node) => ({
      cursor: encodeCursor({
        createdAt: node.createdAt.toISOString(),
        id: node.id,
      }),
      node,
    }));
    return {
      edges,
      pageInfo: {
        hasNextPage,
        hasPreviousPage: cursor !== null,
        startCursor: edges.at(0)?.cursor ?? null,
        endCursor: edges.at(-1)?.cursor ?? null,
      },
    };
  }

  public find = (
    accountId: string,
    id: string,
  ): Promise<ConversationRecord | null> =>
    this.repository.findOwned(accountId, id);

  public create = (
    accountId: string,
    title: string,
  ): Promise<ConversationRecord> => this.repository.create(accountId, title);

  public rename = (
    accountId: string,
    id: string,
    title: string,
  ): Promise<ConversationRecord | null> =>
    this.repository.rename(accountId, id, title);

  public delete = (accountId: string, id: string): Promise<boolean> =>
    this.repository.delete(accountId, id);
}
