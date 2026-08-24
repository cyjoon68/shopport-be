CREATE TABLE "ai_run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"chunk" jsonb NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '1 hour' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"hits" integer NOT NULL,
	"window_expires_at" timestamp with time zone NOT NULL,
	"blocked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "stream_closed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "ai_runs" SET "stream_closed_at" = now() WHERE "stream_closed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "ai_run_events" ADD CONSTRAINT "ai_run_events_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_run_events_run_id_id_idx" ON "ai_run_events" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "ai_run_events_expires_at_idx" ON "ai_run_events" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "rate_limits_window_expires_at_idx" ON "rate_limits" USING btree ("window_expires_at");
