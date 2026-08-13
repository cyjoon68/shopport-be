import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DATABASE } from '../../database/database.module.js';
import type { Database } from '../../database/database.module.js';
import { savedProducts } from '../../database/schema.js';

@Injectable()
export class FavoritesRepository {
  public constructor(@Inject(DATABASE) private readonly database: Database) {}

  public async list(
    accountId: string,
    first: number,
  ): Promise<ReadonlyArray<string>> {
    const rows = await this.database
      .select({ productId: savedProducts.productId })
      .from(savedProducts)
      .where(eq(savedProducts.accountId, accountId))
      .orderBy(desc(savedProducts.savedAt))
      .limit(first);
    return rows.map(({ productId }) => productId);
  }

  public async save(accountId: string, productId: string): Promise<void> {
    await this.database
      .insert(savedProducts)
      .values({ accountId, productId })
      .onConflictDoNothing();
  }

  public async has(accountId: string, productId: string): Promise<boolean> {
    const rows = await this.database
      .select({ productId: savedProducts.productId })
      .from(savedProducts)
      .where(
        and(
          eq(savedProducts.accountId, accountId),
          eq(savedProducts.productId, productId),
        ),
      )
      .limit(1);
    return rows.length === 1;
  }

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
