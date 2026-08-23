import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { Database } from '../../database/database.module.js';
import { DATABASE } from '../../database/database.module.js';
import { assets, conversations, outbox } from '../../database/schema.js';

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

  public async create(input: {
    accountId: string;
    conversationId: string;
    originalKey: string;
    contentType: string;
    byteSize: number;
    id: string;
  }): Promise<AssetRecord> {
    const rows = await this.database
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
  }

  public async ownsConversation(
    accountId: string,
    conversationId: string,
  ): Promise<boolean> {
    const rows = await this.database
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.accountId, accountId),
        ),
      )
      .limit(1);
    return rows.length === 1;
  }

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

  public async delete(accountId: string, id: string): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .delete(assets)
        .where(and(eq(assets.id, id), eq(assets.accountId, accountId)))
        .returning({
          originalKey: assets.originalKey,
          normalizedKey: assets.normalizedKey,
        });
      const record = rows.at(0);
      if (!record) return false;
      await transaction.insert(outbox).values({
        id: uuidv7(),
        topic: 'asset.purge',
        payload: { accountId, assetId: id, ...record },
      });
      return true;
    });
  }
}
