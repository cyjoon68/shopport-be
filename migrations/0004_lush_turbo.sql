DROP TABLE "daily_usage" CASCADE;--> statement-breakpoint
DROP TABLE "entitlements" CASCADE;--> statement-breakpoint
DROP TABLE "webhook_events" CASCADE;--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "trial_started_at";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "trial_ends_at";--> statement-breakpoint
ALTER TABLE "ai_runs" DROP COLUMN "usage_date";--> statement-breakpoint
ALTER TABLE "ai_runs" DROP COLUMN "usage_kind";