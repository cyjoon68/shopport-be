CREATE TABLE "accounts" (
  "id" uuid PRIMARY KEY,
  "status" text NOT NULL DEFAULT 'active',
  "display_name" text NOT NULL,
  "profile_image_url" text,
  "trial_started_at" timestamptz NOT NULL,
  "trial_ends_at" timestamptz NOT NULL,
  "deleted_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "auth_identities" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "provider_subject" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "auth_identities_provider_subject_unique" UNIQUE("provider", "provider_subject")
);

CREATE TABLE "auth_sessions" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "replaced_by_session_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "entitlements" (
  "account_id" uuid PRIMARY KEY REFERENCES "accounts"("id") ON DELETE CASCADE,
  "key" text NOT NULL DEFAULT 'trial',
  "product_id" text,
  "expires_at" timestamptz,
  "source_event_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "daily_usage" (
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "usage_date" date NOT NULL,
  "text_count" integer NOT NULL DEFAULT 0 CHECK ("text_count" >= 0),
  "image_count" integer NOT NULL DEFAULT 0 CHECK ("image_count" >= 0),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("account_id", "usage_date")
);

CREATE TABLE "conversations" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "deleted_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "ai_runs" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "usage_date" date NOT NULL,
  "usage_kind" text NOT NULL CHECK ("usage_kind" IN ('text', 'image')),
  "status" text NOT NULL CHECK ("status" IN ('reserved', 'completed', 'failed')),
  "started_at" timestamptz NOT NULL,
  "completed_at" timestamptz
);

CREATE TABLE "messages" (
  "id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "role" text NOT NULL CHECK ("role" IN ('user', 'assistant')),
  "run_id" uuid,
  "status" text NOT NULL CHECK ("status" IN ('pending', 'completed', 'failed')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE ("created_at");

CREATE TABLE "messages_default" PARTITION OF "messages" DEFAULT;
CREATE INDEX "messages_conversation_created_idx" ON "messages"("conversation_id", "created_at" DESC, "id");

CREATE TABLE "message_parts" (
  "id" uuid PRIMARY KEY,
  "message_id" uuid NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('text', 'image', 'product_reference', 'tool_status')),
  "position" integer NOT NULL CHECK ("position" >= 0),
  "payload" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("message_id", "position")
);

CREATE TABLE "assets" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "conversation_id" uuid REFERENCES "conversations"("id") ON DELETE CASCADE,
  "status" text NOT NULL,
  "original_key" text NOT NULL,
  "normalized_key" text,
  "content_type" text NOT NULL,
  "byte_size" bigint NOT NULL CHECK ("byte_size" BETWEEN 1 AND 15728640),
  "width" integer,
  "height" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "saved_products" (
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "product_id" uuid NOT NULL,
  "saved_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("account_id", "product_id")
);

CREATE TABLE "catalog_metadata" (
  "id" uuid PRIMARY KEY,
  "provider_id" text NOT NULL,
  "external_id" text NOT NULL,
  "title" text NOT NULL,
  "image_url" text,
  "affiliate" boolean NOT NULL DEFAULT false,
  "freshness_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("provider_id", "external_id")
);

CREATE TABLE "offers" (
  "id" uuid PRIMARY KEY,
  "product_id" uuid NOT NULL,
  "amount_minor" bigint NOT NULL CHECK ("amount_minor" >= 0),
  "shipping_minor" bigint NOT NULL CHECK ("shipping_minor" >= 0),
  "currency" text NOT NULL DEFAULT 'KRW',
  "in_stock" boolean NOT NULL,
  "outbound_url" text NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "outbox" (
  "id" uuid PRIMARY KEY,
  "topic" text NOT NULL,
  "payload" jsonb NOT NULL,
  "published_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "webhook_events" (
  "id" text PRIMARY KEY,
  "source" text NOT NULL,
  "payload_hash" text NOT NULL,
  "processed_at" timestamptz NOT NULL
);

CREATE TABLE "archive_manifests" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "object_key" text NOT NULL UNIQUE,
  "checksum" text NOT NULL,
  "from_at" timestamptz NOT NULL,
  "to_at" timestamptz NOT NULL,
  "message_count" integer NOT NULL CHECK ("message_count" > 0),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "conversations_account_created_idx" ON "conversations"("account_id", "created_at" DESC, "id");
CREATE INDEX "assets_account_created_idx" ON "assets"("account_id", "created_at" DESC);
CREATE INDEX "catalog_metadata_provider_external_idx" ON "catalog_metadata"("provider_id", "external_id");
CREATE INDEX "offers_product_observed_idx" ON "offers"("product_id", "observed_at" DESC);
CREATE INDEX "outbox_unpublished_idx" ON "outbox"("created_at") WHERE "published_at" IS NULL;
CREATE INDEX "archive_manifests_conversation_from_idx" ON "archive_manifests"("conversation_id", "from_at");
