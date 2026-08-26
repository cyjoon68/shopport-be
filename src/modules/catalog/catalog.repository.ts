import { Inject, Injectable } from '@nestjs/common';
import { inArray, sql } from 'drizzle-orm';

import type { Database } from '../../database/database.module.js';
import { DATABASE } from '../../database/database.module.js';
import { catalogMetadata } from '../../database/schema.js';
import type { CatalogProduct } from './types.js';

const catalogRecord = (
  product: CatalogProduct,
): typeof catalogMetadata.$inferInsert => ({
  id: product.id,
  providerId: product.providerId,
  externalId: product.productCode,
  title: product.title,
  imageUrl: product.imageUrl,
  affiliate: product.affiliate,
  freshnessAt: new Date(product.freshnessEpochMs),
  snapshot: product,
});

@Injectable()
export class CatalogRepository {
  public constructor(@Inject(DATABASE) private readonly database: Database) {}

  public save = async (
    products: ReadonlyArray<CatalogProduct>,
  ): Promise<void> => {
    if (products.length === 0) return;
    await this.database
      .insert(catalogMetadata)
      .values(products.map(catalogRecord))
      .onConflictDoUpdate({
        target: catalogMetadata.id,
        set: {
          providerId: sql`excluded.provider_id`,
          externalId: sql`excluded.external_id`,
          title: sql`excluded.title`,
          imageUrl: sql`excluded.image_url`,
          affiliate: sql`excluded.affiliate`,
          freshnessAt: sql`excluded.freshness_at`,
          snapshot: sql`excluded.snapshot`,
          updatedAt: sql`now()`,
        },
      });
  };

  public get = async (id: string): Promise<CatalogProduct | null> => {
    const products = await this.getMany([id]);
    return products[0] ?? null;
  };

  public getMany = async (
    ids: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<CatalogProduct | null>> => {
    if (ids.length === 0) return [];
    const rows = await this.database
      .select({ id: catalogMetadata.id, snapshot: catalogMetadata.snapshot })
      .from(catalogMetadata)
      .where(inArray(catalogMetadata.id, [...ids]));
    const products = new Map(
      rows.flatMap(({ id, snapshot }) => (snapshot ? [[id, snapshot]] : [])),
    );
    return ids.map((id) => products.get(id) ?? null);
  };
}
