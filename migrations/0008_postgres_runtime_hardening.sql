CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "locked_by" text;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "locked_until" timestamptz;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_attempt_count_check" CHECK ("attempt_count" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "outbox" VALIDATE CONSTRAINT "outbox_attempt_count_check";--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions" ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_sessions_replaced_by_session_id_idx" ON "auth_sessions" ("replaced_by_session_id") WHERE "replaced_by_session_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX "catalog_metadata_provider_external_idx";--> statement-breakpoint
DROP INDEX "outbox_unpublished_idx";--> statement-breakpoint
CREATE INDEX "outbox_ready_idx" ON "outbox" ("next_attempt_at", "created_at", "id") WHERE "published_at" IS NULL AND "failed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "outbox_published_retention_idx" ON "outbox" ("published_at") WHERE "published_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "outbox_failed_retention_idx" ON "outbox" ("failed_at") WHERE "failed_at" IS NOT NULL;--> statement-breakpoint
CREATE FUNCTION "notify_outbox_ready"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM pg_notify('shopport_outbox_ready', '');
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "outbox_ready_notify"
AFTER INSERT OR UPDATE OF "next_attempt_at", "locked_by", "locked_until", "failed_at" ON "outbox"
FOR EACH ROW
WHEN (NEW."published_at" IS NULL AND NEW."failed_at" IS NULL AND NEW."locked_by" IS NULL)
EXECUTE FUNCTION "notify_outbox_ready"();
