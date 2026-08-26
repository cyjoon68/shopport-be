import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import type { CatalogProduct } from '../modules/catalog/types.js';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
};

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey(),
  status: text('status').notNull().default('active'),
  displayName: text('display_name').notNull(),
  profileImageUrl: text('profile_image_url'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  ...timestamps,
});

export const authIdentities = pgTable(
  'auth_identities',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerSubject: text('provider_subject').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('auth_identities_provider_subject_unique').on(
      table.provider,
      table.providerSubject,
    ),
  ],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedBySessionId: uuid('replaced_by_session_id'),
    ...timestamps,
  },
  (table) => [
    unique('auth_sessions_token_hash_key').on(table.tokenHash),
    index('auth_sessions_expires_at_idx').on(table.expiresAt),
    index('auth_sessions_replaced_by_session_id_idx')
      .on(table.replacedBySessionId)
      .where(sql`${table.replacedBySessionId} is not null`),
  ],
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('conversations_account_created_idx').on(
      table.accountId,
      table.createdAt.desc(),
      table.id,
    ),
  ],
);

export const aiRuns = pgTable(
  'ai_runs',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    streamClosedAt: timestamp('stream_closed_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'ai_runs_status_check',
      sql`${table.status} in ('reserved', 'completed', 'failed', 'cancelled')`,
    ),
    index('ai_runs_stale_reserved_idx')
      .on(table.deadlineAt, table.heartbeatAt)
      .where(sql`${table.status} = 'reserved'`),
  ],
);

export const aiRunEvents = pgTable(
  'ai_run_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => aiRuns.id, { onDelete: 'cascade' }),
    chunk: jsonb('chunk').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '1 hour'`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('ai_run_events_run_id_id_idx').on(table.runId, table.id),
    index('ai_run_events_expires_at_idx').on(table.expiresAt),
  ],
);

export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').primaryKey(),
    hits: integer('hits').notNull(),
    windowExpiresAt: timestamp('window_expires_at', {
      withTimezone: true,
    }).notNull(),
    blockedUntil: timestamp('blocked_until', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('rate_limits_window_expires_at_idx').on(table.windowExpiresAt),
  ],
);

export const messages = pgTable('messages', {
  id: uuid('id').notNull(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  runId: uuid('run_id'),
  status: text('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const messageParts = pgTable('message_parts', {
  id: uuid('id').primaryKey(),
  messageId: uuid('message_id').notNull(),
  kind: text('kind').notNull(),
  position: integer('position').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    status: text('status').notNull(),
    originalKey: text('original_key').notNull(),
    normalizedKey: text('normalized_key'),
    contentType: text('content_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    width: integer('width'),
    height: integer('height'),
    ...timestamps,
  },
  (table) => [
    check(
      'assets_byte_size_check',
      sql`${table.byteSize} between 1 and 15728640`,
    ),
    index('assets_account_created_idx').on(
      table.accountId,
      table.createdAt.desc(),
    ),
  ],
);

export const savedProducts = pgTable(
  'saved_products',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').notNull(),
    savedAt: timestamp('saved_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.productId] })],
);

export const catalogMetadata = pgTable(
  'catalog_metadata',
  {
    id: uuid('id').primaryKey(),
    providerId: text('provider_id').notNull(),
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    imageUrl: text('image_url'),
    affiliate: boolean('affiliate').notNull().default(false),
    freshnessAt: timestamp('freshness_at', { withTimezone: true }).notNull(),
    snapshot: jsonb('snapshot').$type<CatalogProduct>(),
    ...timestamps,
  },
  (table) => [
    unique('catalog_metadata_provider_id_external_id_key').on(
      table.providerId,
      table.externalId,
    ),
  ],
);

export const offers = pgTable(
  'offers',
  {
    id: uuid('id').primaryKey(),
    productId: uuid('product_id').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    shippingMinor: bigint('shipping_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull().default('KRW'),
    inStock: boolean('in_stock').notNull(),
    outboundUrl: text('outbound_url').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    check('offers_amount_minor_check', sql`${table.amountMinor} >= 0`),
    check('offers_shipping_minor_check', sql`${table.shippingMinor} >= 0`),
    index('offers_product_observed_idx').on(
      table.productId,
      table.observedAt.desc(),
    ),
  ],
);

export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey(),
    topic: text('topic').notNull(),
    payload: jsonb('payload').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedBy: text('locked_by'),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastError: text('last_error'),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('outbox_attempt_count_check', sql`${table.attemptCount} >= 0`),
    index('outbox_ready_idx')
      .on(table.nextAttemptAt, table.createdAt, table.id)
      .where(sql`${table.publishedAt} is null and ${table.failedAt} is null`),
    index('outbox_published_retention_idx')
      .on(table.publishedAt)
      .where(sql`${table.publishedAt} is not null`),
    index('outbox_failed_retention_idx')
      .on(table.failedAt)
      .where(sql`${table.failedAt} is not null`),
  ],
);

export const archiveManifests = pgTable(
  'archive_manifests',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    objectKey: text('object_key').notNull(),
    checksum: text('checksum').notNull(),
    fromAt: timestamp('from_at', { withTimezone: true }).notNull(),
    toAt: timestamp('to_at', { withTimezone: true }).notNull(),
    messageCount: integer('message_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('archive_manifests_object_key_key').on(table.objectKey),
    check(
      'archive_manifests_message_count_check',
      sql`${table.messageCount} > 0`,
    ),
    index('archive_manifests_conversation_from_idx').on(
      table.conversationId,
      table.fromAt,
    ),
  ],
);
