ALTER TABLE "indexer_cursor" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "indexer_cursor" ADD COLUMN "last_checked_slot" bigint;