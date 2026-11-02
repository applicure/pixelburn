CREATE TABLE "ads" (
	"id" integer PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"x" smallint NOT NULL,
	"y" smallint NOT NULL,
	"w" smallint NOT NULL,
	"h" smallint NOT NULL,
	"blocks" integer[],
	"title" text DEFAULT '' NOT NULL,
	"link" text DEFAULT '' NOT NULL,
	"image_uri" text DEFAULT '' NOT NULL,
	"image_sha256" text DEFAULT '' NOT NULL,
	"pay_mode" text NOT NULL,
	"paid_lamports" numeric(20, 0) DEFAULT '0' NOT NULL,
	"paid_tokens" numeric(20, 0) DEFAULT '0' NOT NULL,
	"usd_micro" numeric(20, 0) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"checks" jsonb,
	"checked_at" timestamp with time zone,
	"moderated_at" timestamp with time zone,
	"moderated_by" text,
	"hydrated" boolean DEFAULT false NOT NULL,
	"signature" text NOT NULL,
	"finalized" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auction" (
	"id" integer PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"blocks_remaining" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"winner" text,
	"winning_lamports" numeric(20, 0),
	"ad_id" integer,
	"start_signature" text NOT NULL,
	"settle_signature" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auction_bids" (
	"id" serial PRIMARY KEY NOT NULL,
	"signature" text NOT NULL,
	"event_index" integer NOT NULL,
	"bidder" text NOT NULL,
	"lamports" numeric(20, 0) NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"slot" bigint NOT NULL,
	"finalized" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buybacks" (
	"id" serial PRIMARY KEY NOT NULL,
	"signature" text NOT NULL,
	"event_index" integer NOT NULL,
	"lamports_in" numeric(20, 0) NOT NULL,
	"tokens_burned" numeric(20, 0) NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"slot" bigint NOT NULL,
	"finalized" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_events" (
	"signature" text NOT NULL,
	"event_index" integer NOT NULL,
	"name" text NOT NULL,
	"slot" bigint NOT NULL,
	"data" jsonb NOT NULL,
	"finalized" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_events_signature_event_index_pk" PRIMARY KEY("signature","event_index")
);
--> statement-breakpoint
CREATE TABLE "indexer_cursor" (
	"id" text PRIMARY KEY NOT NULL,
	"last_signature" text,
	"last_slot" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"sol_usd" double precision,
	"token_spot_sol" numeric(40, 0),
	"token_ema_sol" numeric(40, 0),
	"token_usd" double precision,
	"signature" text,
	"event_index" integer,
	"finalized" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" serial PRIMARY KEY NOT NULL,
	"signature" text NOT NULL,
	"event_index" integer NOT NULL,
	"ad_id" integer NOT NULL,
	"owner" text NOT NULL,
	"x" smallint NOT NULL,
	"y" smallint NOT NULL,
	"w" smallint NOT NULL,
	"h" smallint NOT NULL,
	"pay_mode" text NOT NULL,
	"lamports" numeric(20, 0) NOT NULL,
	"tokens_burned" numeric(20, 0) NOT NULL,
	"usd_micro" numeric(20, 0) NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"slot" bigint NOT NULL,
	"finalized" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ads_status_idx" ON "ads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ads_owner_idx" ON "ads" USING btree ("owner");--> statement-breakpoint
CREATE UNIQUE INDEX "auction_bids_sig_idx" ON "auction_bids" USING btree ("signature","event_index");--> statement-breakpoint
CREATE INDEX "auction_bids_ts_idx" ON "auction_bids" USING btree ("ts");--> statement-breakpoint
CREATE UNIQUE INDEX "buybacks_sig_idx" ON "buybacks" USING btree ("signature","event_index");--> statement-breakpoint
CREATE INDEX "buybacks_ts_idx" ON "buybacks" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "chain_events_final_idx" ON "chain_events" USING btree ("finalized");--> statement-breakpoint
CREATE UNIQUE INDEX "price_snapshots_sig_idx" ON "price_snapshots" USING btree ("signature","event_index");--> statement-breakpoint
CREATE INDEX "price_snapshots_ts_idx" ON "price_snapshots" USING btree ("ts");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_sig_idx" ON "purchases" USING btree ("signature","event_index");--> statement-breakpoint
CREATE INDEX "purchases_ts_idx" ON "purchases" USING btree ("ts");