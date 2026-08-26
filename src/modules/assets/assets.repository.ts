import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { Database } from '../../database/database.module.js';
import { DATABASE } from '../../database/database.module.js';
import {
  accounts,
  assets,
  conversations,
  outbox,
} from '../../database/schema.js';
import { assetKeysFor } from './keys.js';

export type AssetRecord = Readonly<{
  id: string;
  status: string;
  normalizedKey: string | null;
  width: number | null;
  height: number | null;
  createdAt: Date;
}>;

@Injectable()
export class AssetsRepository {
  public constructor(@Inject(DATABASE) private readonly database: Database) {}

  public createForLiveConversation = async (input: {
    accountId: string;
    conversationId: string;
    originalKey: string;
    contentType: string;
    byteSize: number;
    id: string;
  }): Promise<AssetRecord | null> =>
    this.database.transaction(async (transaction) => {
      const account = await transaction
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.id, input.accountId),
            eq(accounts.status, 'active'),
            isNull(accounts.deletedAt),
          ),
        )
        .limit(1)
        .for('update');
      if (account.length === 0) return null;
      const conversation = await transaction
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, input.conversationId),
            eq(conversations.accountId, input.accountId),
            isNull(conversations.deletedAt),
          ),
        )
        .limit(1)
        .for('update');
      if (conversation.length === 0) return null;
      const rows = await transaction
        .insert(assets)
        .values({ ...input, status: 'pending_upload' })
        .returning({
          id: assets.id,
          status: assets.status,
          normalizedKey: assets.normalizedKey,
          width: assets.width,
          height: assets.height,
          createdAt: assets.createdAt,
        });
      const record = rows.at(0);
      if (!record) throw new Error('Asset insert returned no row');
      return record;
    });

  public async findOwned(
    accountId: string,
    id: string,
  ): Promise<AssetRecord | null> {
    const rows = await this.database
      .select({
        id: assets.id,
        status: assets.status,
        normalizedKey: assets.normalizedKey,
        width: assets.width,
        height: assets.height,
        createdAt: assets.createdAt,
      })
      .from(assets)
      .where(and(eq(assets.id, id), eq(assets.accountId, accountId)))
      .limit(1);
    return rows.at(0) ?? null;
  }

  public findForConversations = async (
    assetIds: ReadonlyArray<string>,
    conversationIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<AssetRecord>> => {
    if (assetIds.length === 0 || conversationIds.length === 0) return [];
    return this.database
      .select({
        id: assets.id,
        status: assets.status,
        normalizedKey: assets.normalizedKey,
        width: assets.width,
        height: assets.height,
        createdAt: assets.createdAt,
      })
      .from(assets)
      .where(
        and(
          inArray(assets.id, assetIds),
          inArray(assets.conversationId, conversationIds),
        ),
      );
  };

  public async delete(accountId: string, id: string): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .delete(assets)
        .where(and(eq(assets.id, id), eq(assets.accountId, accountId)))
        .returning({
          createdAt: assets.createdAt,
        });
      const record = rows.at(0);
      if (!record) return false;
      const keys = assetKeysFor(accountId, id);
      await transaction.insert(outbox).values({
        id: uuidv7(),
        topic: 'asset.purge',
        payload: {
          accountId,
          assetId: id,
          originalKey: keys.original,
          normalizedKey: keys.normalized,
        },
        nextAttemptAt: sql`greatest(now(), ${record.createdAt}::timestamptz + interval '15 minutes')`,
      });
      return true;
    });
  }
}
