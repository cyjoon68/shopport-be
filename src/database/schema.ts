import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

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
  trialStartedAt: timestamp('trial_started_at', {
    withTimezone: true,
  }).notNull(),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }).notNull(),
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
    uniqueIndex('auth_identities_provider_subject_idx').on(
      table.provider,
      table.providerSubject,
    ),
  ],
);

export const authSessions = pgTable('auth_sessions', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  replacedBySessionId: uuid('replaced_by_session_id'),
  ...timestamps,
});

export const entitlements = pgTable('entitlements', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  key: text('key').notNull().default('trial'),
  productId: text('product_id'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  sourceEventAt: timestamp('source_event_at', { withTimezone: true }),
  ...timestamps,
});

export const dailyUsage = pgTable(
  'daily_usage',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    usageDate: date('usage_date').notNull(),
    textCount: integer('text_count').notNull().default(0),
    imageCount: integer('image_count').notNull().default(0),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.accountId, table.usageDate] })],
);

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  ...timestamps,
});

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
    usageDate: date('usage_date').notNull(),
    usageKind: text('usage_kind').notNull(),
    status: text('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
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

export const assets = pgTable('assets', {
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
});

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

export const catalogMetadata = pgTable('catalog_metadata', {
  id: uuid('id').primaryKey(),
  providerId: text('provider_id').notNull(),
  externalId: text('external_id').notNull(),
  title: text('title').notNull(),
  imageUrl: text('image_url'),
  affiliate: boolean('affiliate').notNull().default(false),
  freshnessAt: timestamp('freshness_at', { withTimezone: true }).notNull(),
  ...timestamps,
});

export const offers = pgTable('offers', {
  id: uuid('id').primaryKey(),
  productId: uuid('product_id').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  shippingMinor: bigint('shipping_minor', { mode: 'bigint' }).notNull(),
  currency: text('currency').notNull().default('KRW'),
  inStock: boolean('in_stock').notNull(),
  outboundUrl: text('outbound_url').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  ...timestamps,
});

export const outbox = pgTable('outbox', {
  id: uuid('id').primaryKey(),
  topic: text('topic').notNull(),
  payload: jsonb('payload').notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const webhookEvents = pgTable('webhook_events', {
  id: text('id').primaryKey(),
  source: text('source').notNull(),
  payloadHash: text('payload_hash').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull(),
});

export const archiveManifests = pgTable('archive_manifests', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  objectKey: text('object_key').notNull().unique(),
  checksum: text('checksum').notNull(),
  fromAt: timestamp('from_at', { withTimezone: true }).notNull(),
  toAt: timestamp('to_at', { withTimezone: true }).notNull(),
  messageCount: integer('message_count').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
