import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { Database } from '../../database/database.module.js';
import { DATABASE } from '../../database/database.module.js';
import { accounts, authSessions, outbox } from '../../database/schema.js';

export type ViewerRecord = Readonly<{
  id: string;
  displayName: string;
  profileImageUrl: string | null;
}>;

@Injectable()
export class ProfileRepository {
  public constructor(@Inject(DATABASE) private readonly database: Database) {}

  public async viewer(accountId: string): Promise<ViewerRecord | null> {
    const rows = await this.database
      .select({
        id: accounts.id,
        displayName: accounts.displayName,
        profileImageUrl: accounts.profileImageUrl,
      })
      .from(accounts)
      .where(and(eq(accounts.id, accountId), isNull(accounts.deletedAt)))
      .limit(1);
    return rows.at(0) ?? null;
  }

  public async updateDisplayName(
    accountId: string,
    displayName: string,
  ): Promise<ViewerRecord | null> {
    const rows = await this.database
      .update(accounts)
      .set({ displayName, updatedAt: new Date() })
      .where(and(eq(accounts.id, accountId), isNull(accounts.deletedAt)))
      .returning({ id: accounts.id });
    if (rows.length === 0) return null;
    return this.viewer(accountId);
  }

  public async deleteAccount(accountId: string): Promise<boolean> {
    const deletedAt = new Date();
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .update(accounts)
        .set({ status: 'deleting', deletedAt, updatedAt: deletedAt })
        .where(and(eq(accounts.id, accountId), isNull(accounts.deletedAt)))
        .returning({ id: accounts.id });
      if (rows.length === 0) return false;
      await transaction
        .update(authSessions)
        .set({ revokedAt: deletedAt })
        .where(
          and(
            eq(authSessions.accountId, accountId),
            isNull(authSessions.revokedAt),
          ),
        );
      await transaction.insert(outbox).values({
        id: uuidv7(),
        topic: 'account.purge',
        payload: { accountId },
      });
      return true;
    });
  }
}
