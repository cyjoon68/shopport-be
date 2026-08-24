import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';

import type { CursorPayload } from '../../common/cursor.js';
import type { Database } from '../../database/database.module.js';
import { DATABASE } from '../../database/database.module.js';
import { savedProducts } from '../../database/schema.js';

type SavedProductRecord = Readonly<{
  productId: string;
  savedAt: Date;
}>;

@Injectable()
export class FavoritesRepository {
  public constructor(@Inject(DATABASE) private readonly database: Database) {}

  public list = (
    accountId: string,
    first: number,
    after: CursorPayload | null,
  ): Promise<ReadonlyArray<SavedProductRecord>> => {
    const cursorCondition = after
      ? or(
          lt(savedProducts.savedAt, new Date(after.createdAt)),
          and(
            eq(savedProducts.savedAt, new Date(after.createdAt)),
            lt(savedProducts.productId, after.id),
          ),
        )
      : undefined;
    return this.database
      .select({
        productId: savedProducts.productId,
        savedAt: savedProducts.savedAt,
      })
      .from(savedProducts)
      .where(and(eq(savedProducts.accountId, accountId), cursorCondition))
      .orderBy(desc(savedProducts.savedAt), desc(savedProducts.productId))
      .limit(first + 1);
  };

  public async save(accountId: string, productId: string): Promise<void> {
    await this.database
      .insert(savedProducts)
      .values({ accountId, productId })
      .onConflictDoNothing();
  }

  public hasMany = async (
    accountId: string,
    productIds: ReadonlyArray<string>,
  ): Promise<ReadonlySet<string>> => {
    if (productIds.length === 0) return new Set();
    const rows = await this.database
      .select({ productId: savedProducts.productId })
      .from(savedProducts)
      .where(
        and(
          eq(savedProducts.accountId, accountId),
          inArray(savedProducts.productId, [...productIds]),
        ),
      );
    return new Set(rows.map(({ productId }) => productId));
  };

  public async unsave(accountId: string, productId: string): Promise<void> {
    await this.database
      .delete(savedProducts)
      .where(
        and(
          eq(savedProducts.accountId, accountId),
          eq(savedProducts.productId, productId),
        ),
      );
  }
}
