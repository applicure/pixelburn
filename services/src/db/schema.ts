import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// u64 values are stored as numeric(20,0) and surface as strings; u128 as numeric(40,0).
const u64 = (name: string) => numeric(name, { precision: 20, scale: 0 });
const u128 = (name: string) => numeric(name, { precision: 40, scale: 0 });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export type ModerationStatus = "pending" | "approved" | "rejected";
export type PayMode = "sol" | "token" | "auction";

export const ads = pgTable(
  "ads",
  {
    id: integer("id").primaryKey(), // on-chain ad_id (display counter)
    /** Ad account address (from the event). */
    address: text("address"),
    owner: text("owner").notNull(),
    x: smallint("x").notNull(),
    y: smallint("y").notNull(),
    w: smallint("w").notNull(),
    h: smallint("h").notNull(),
    /** Explicit block list (final-auction ad only); null = full rectangle. */
    blocks: integer("blocks").array(),
    title: text("title").notNull().default(""),
    link: text("link").notNull().default(""),
    imageUri: text("image_uri").notNull().default(""),
    imageSha256: text("image_sha256").notNull().default(""), // hex
    payMode: text("pay_mode").$type<PayMode>().notNull(),
    paidLamports: u64("paid_lamports").notNull().default("0"),
    paidTokens: u64("paid_tokens").notNull().default("0"),
    usdMicro: u64("usd_micro").notNull().default("0"),
    createdAt: ts("created_at").notNull(),
    /** Off-chain moderation. */
    status: text("status").$type<ModerationStatus>().notNull().default("pending"),
    reason: text("reason"),
    checks: jsonb("checks"),
    checkedAt: ts("checked_at"),
    moderatedAt: ts("moderated_at"),
    moderatedBy: text("moderated_by"),
    /** True once title/link/image were loaded from the Ad account. */
    hydrated: boolean("hydrated").notNull().default(false),
    signature: text("signature").notNull(),
    finalized: boolean("finalized").notNull().default(false),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("ads_status_idx").on(t.status), index("ads_owner_idx").on(t.owner)],
);

/** Raw decoded events; the (signature, event_index) PK is the idempotency key. */
export const chainEvents = pgTable(
  "chain_events",
  {
    signature: text("signature").notNull(),
    eventIndex: integer("event_index").notNull(),
    name: text("name").notNull(),
    slot: bigint("slot", { mode: "number" }).notNull(),
    data: jsonb("data").notNull(),
    finalized: boolean("finalized").notNull().default(false),
    source: text("source").notNull(), // backfill | logs | helius | seed
    ingestedAt: ts("ingested_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.signature, t.eventIndex] }), index("chain_events_final_idx").on(t.finalized)],
);

export const purchases = pgTable(
  "purchases",
  {
    id: serial("id").primaryKey(),
    signature: text("signature").notNull(),
    eventIndex: integer("event_index").notNull(),
    adId: integer("ad_id").notNull(),
    owner: text("owner").notNull(),
    x: smallint("x").notNull(),
    y: smallint("y").notNull(),
    w: smallint("w").notNull(),
    h: smallint("h").notNull(),
    payMode: text("pay_mode").$type<PayMode>().notNull(),
    lamports: u64("lamports").notNull(),
    tokensBurned: u64("tokens_burned").notNull(),
    usdMicro: u64("usd_micro").notNull(),
    ts: ts("ts").notNull(),
    slot: bigint("slot", { mode: "number" }).notNull(),
    finalized: boolean("finalized").notNull().default(false),
  },
  (t) => [uniqueIndex("purchases_sig_idx").on(t.signature, t.eventIndex), index("purchases_ts_idx").on(t.ts)],
);

export const buybacks = pgTable(
  "buybacks",
  {
    id: serial("id").primaryKey(),
    signature: text("signature").notNull(),
    eventIndex: integer("event_index").notNull(),
    lamportsIn: u64("lamports_in").notNull(),
    tokensBurned: u64("tokens_burned").notNull(),
    ts: ts("ts").notNull(),
    slot: bigint("slot", { mode: "number" }).notNull(),
    finalized: boolean("finalized").notNull().default(false),
  },
  (t) => [uniqueIndex("buybacks_sig_idx").on(t.signature, t.eventIndex), index("buybacks_ts_idx").on(t.ts)],
);

export const auctionBids = pgTable(
  "auction_bids",
  {
    id: serial("id").primaryKey(),
    signature: text("signature").notNull(),
    eventIndex: integer("event_index").notNull(),
    bidder: text("bidder").notNull(),
    lamports: u64("lamports").notNull(),
    ts: ts("ts").notNull(),
    slot: bigint("slot", { mode: "number" }).notNull(),
    finalized: boolean("finalized").notNull().default(false),
  },
  (t) => [uniqueIndex("auction_bids_sig_idx").on(t.signature, t.eventIndex), index("auction_bids_ts_idx").on(t.ts)],
);

/** Singleton row (id = 1) describing the final auction, derived from events. */
export const auction = pgTable("auction", {
  id: integer("id").primaryKey(),
  status: text("status").$type<"active" | "settled">().notNull(),
  blocksRemaining: integer("blocks_remaining").notNull(),
  startedAt: ts("started_at").notNull(),
  endsAt: ts("ends_at").notNull(),
  winner: text("winner"),
  winningLamports: u64("winning_lamports"),
  adId: integer("ad_id"),
  startSignature: text("start_signature").notNull(),
  settleSignature: text("settle_signature"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const priceSnapshots = pgTable(
  "price_snapshots",
  {
    id: serial("id").primaryKey(),
    ts: ts("ts").notNull(),
    source: text("source").notNull(), // chain (TokenPriceUpdated) | quote | seed
    solUsd: doublePrecision("sol_usd"),
    tokenSpotSol: u128("token_spot_sol"), // 1e18 fixed-point SOL per base unit
    tokenEmaSol: u128("token_ema_sol"),
    tokenSlowEmaSol: u128("token_slow_ema_sol"),
    tokenUsd: doublePrecision("token_usd"), // USD per whole token
    signature: text("signature"),
    eventIndex: integer("event_index"),
    finalized: boolean("finalized").notNull().default(true),
  },
  (t) => [uniqueIndex("price_snapshots_sig_idx").on(t.signature, t.eventIndex), index("price_snapshots_ts_idx").on(t.ts)],
);

export const indexerCursor = pgTable("indexer_cursor", {
  id: text("id").primaryKey(), // program id
  lastSignature: text("last_signature"),
  lastSlot: bigint("last_slot", { mode: "number" }),
  /** Last successful backfill pass (even if it found nothing) and the finalized slot at that time. */
  lastCheckedAt: ts("last_checked_at"),
  lastCheckedSlot: bigint("last_checked_slot", { mode: "number" }),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
