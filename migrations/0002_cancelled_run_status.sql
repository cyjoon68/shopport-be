ALTER TABLE "ai_runs" DROP CONSTRAINT "ai_runs_status_check";--> statement-breakpoint
CREATE INDEX "ai_runs_stale_reserved_idx" ON "ai_runs" USING btree ("deadline_at","heartbeat_at") WHERE "ai_runs"."status" = 'reserved';--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_status_check" CHECK ("ai_runs"."status" in ('reserved', 'completed', 'failed', 'cancelled'));
