ALTER TABLE "ai_runs" ADD COLUMN "deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
UPDATE "ai_runs"
SET "deadline_at" = "started_at" + interval '60 seconds',
    "heartbeat_at" = "started_at";--> statement-breakpoint
ALTER TABLE "ai_runs" ALTER COLUMN "deadline_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_runs" ALTER COLUMN "heartbeat_at" SET NOT NULL;
