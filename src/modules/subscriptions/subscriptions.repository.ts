import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, lte, or } from 'drizzle-orm';

import type { Database } from '../../database/database.module.js';
import { DATABASE } from '../../database/database.module.js';
import { entitlements, webhookEvents } from '../../database/schema.js';
import type { RevenueCatEvent } from './revenuecat.js';
import { entitlementUpdateFrom } from './revenuecat.js';

@Injectable()
export class SubscriptionsRepository {
  public constructor(@Inject(DATABASE) private readonly database: Database) {}

  public process = (
    event: RevenueCatEvent,
    payloadHash: string,
  ): Promise<'processed' | 'duplicate' | 'ignored'> =>
    this.database.transaction(async (transaction) => {
      const inserted = await transaction
        .insert(webhookEvents)
        .values({
          id: event.id,
          source: 'revenuecat',
          payloadHash,
          processedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: webhookEvents.id });
      if (inserted.length === 0) return 'duplicate';
      const update = entitlementUpdateFrom(event);
      if (!update) return 'ignored';
      const changed = await transaction
        .update(entitlements)
        .set({
          key: update.key,
          productId: update.productId,
          expiresAt: update.expiresAt,
          sourceEventAt: update.sourceEventAt,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(entitlements.accountId, update.accountId),
            or(
              isNull(entitlements.sourceEventAt),
              lte(entitlements.sourceEventAt, update.sourceEventAt),
            ),
          ),
        )
        .returning({ accountId: entitlements.accountId });
      return changed.length === 1 ? 'processed' : 'ignored';
    });
}
