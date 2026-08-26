LOCK TABLE "messages" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "message_parts" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DELETE FROM "message_parts" AS part
WHERE NOT EXISTS (
  SELECT 1 FROM "messages" AS message WHERE message."id" = part."message_id"
);--> statement-breakpoint
CREATE TABLE "messages_v2" (
  "id" uuid CONSTRAINT "messages_v2_pkey" PRIMARY KEY,
  "conversation_id" uuid NOT NULL CONSTRAINT "messages_conversation_id_conversations_id_fk" REFERENCES "conversations"("id") ON DELETE CASCADE,
  "role" text NOT NULL CONSTRAINT "messages_v2_role_check" CHECK ("role" IN ('user', 'assistant')),
  "run_id" uuid,
  "status" text NOT NULL CONSTRAINT "messages_v2_status_check" CHECK ("status" IN ('pending', 'completed', 'failed')),
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
INSERT INTO "messages_v2" ("id", "conversation_id", "role", "run_id", "status", "created_at")
SELECT "id", "conversation_id", "role", "run_id", "status", "created_at"
FROM "messages";--> statement-breakpoint
ALTER TABLE "messages" RENAME TO "messages_partitioned_legacy";--> statement-breakpoint
ALTER TABLE "messages_v2" RENAME TO "messages";--> statement-breakpoint
DROP TABLE "messages_partitioned_legacy";--> statement-breakpoint
ALTER TABLE "messages" RENAME CONSTRAINT "messages_v2_pkey" TO "messages_pkey";--> statement-breakpoint
ALTER TABLE "messages" RENAME CONSTRAINT "messages_v2_role_check" TO "messages_role_check";--> statement-breakpoint
ALTER TABLE "messages" RENAME CONSTRAINT "messages_v2_status_check" TO "messages_status_check";--> statement-breakpoint
ALTER TABLE "message_parts"
  ADD CONSTRAINT "message_parts_message_id_messages_id_fk"
  FOREIGN KEY ("message_id") REFERENCES "messages"("id")
  ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "message_parts"
  VALIDATE CONSTRAINT "message_parts_message_id_messages_id_fk";--> statement-breakpoint
UPDATE "outbox"
SET "failed_at" = NULL,
    "next_attempt_at" = LEAST("next_attempt_at", now())
WHERE "published_at" IS NULL AND "failed_at" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "outbox_ready_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "outbox_failed_retention_idx";--> statement-breakpoint
CREATE INDEX "auth_identities_account_id_idx" ON "auth_identities" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_account_id_idx" ON "auth_sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ai_runs_account_id_idx" ON "ai_runs" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ai_runs_conversation_id_idx" ON "ai_runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "assets_conversation_id_idx" ON "assets" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "saved_products_account_saved_product_idx" ON "saved_products" USING btree ("account_id", "saved_at" DESC NULLS LAST, "product_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "archive_manifests_account_id_idx" ON "archive_manifests" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "messages_created_id_idx" ON "messages" USING btree ("created_at", "id");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id", "created_at" DESC NULLS LAST, "id");--> statement-breakpoint
CREATE INDEX "message_parts_message_id_idx" ON "message_parts" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "outbox_ready_idx" ON "outbox" USING btree ("next_attempt_at", "created_at", "id") WHERE "published_at" IS NULL;
