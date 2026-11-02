import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { PROGRAM_ID as SDK_PROGRAM_ID } from "@mpb/sdk";
import { sql } from "drizzle-orm";
import { loadConfig } from "../src/config.js";
import { buildContext } from "../src/context.js";
import { createDb } from "../src/db/client.js";
import { createApp } from "../src/api/app.js";
import type { AdAccount, AdRef, ChainReader, OnchainTokenPrice } from "../src/chain/accounts.js";
import { StaticSolPrice, StaticTokenPrice } from "../src/pricing/prices.js";
import { silentLogger } from "../src/lib/log.js";
import type { NsfwChecker } from "../src/moderation/checks.js";

export function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const base = new URL(process.env.DATABASE_URL ?? "postgres://mpb:mpb@127.0.0.1:54329/mpb");
  base.pathname = "/mpb_test";
  return base.toString();
}

export const ADMIN = "test-admin-token";
export const HELIUS_SECRET = "test-helius-secret";
/** The real program id from the SDK IDL (fake logs must be framed with it for the SDK parser). */
export const PROGRAM_ID = SDK_PROGRAM_ID.toBase58();

export const randSig = () => bs58.encode(randomBytes(64));
export const randKey = () => Keypair.generate().publicKey.toBase58();

/** In-memory chain: tests register Ad accounts here. */
export class FakeChain implements ChainReader {
  ads = new Map<number, AdAccount>();
  supply: bigint | null = 900_000_000_000_000n;
  async fetchAd(ref: AdRef) {
    return this.ads.get(ref.id) ?? null;
  }
  async fetchTokenSupply() {
    return this.supply;
  }
  async fetchTokenPrice(): Promise<OnchainTokenPrice | null> {
    return null;
  }
  async fetchBuybackVaultLamports() {
    return 0n;
  }
}

export async function makeTestContext(opts: { nsfw?: NsfwChecker; autoApprove?: boolean; uploadsPerMin?: number } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "mpb-test-"));
  const cfg = loadConfig({
    DATABASE_URL: testDatabaseUrl(),
    PROGRAM_ID,
    PORT: "8799",
    // On-chain image URIs must be https:// (program + validateAdContent); dev-storage uses this origin.
    PUBLIC_API_URL: "https://api.test.invalid",
    DATA_DIR: dataDir,
    ADMIN_TOKEN: ADMIN,
    AUTO_APPROVE: opts.autoApprove ? "1" : "0",
    BLOCKLIST_FILE: path.resolve("data/blocklist.txt"),
    DRAINER_LIST_FILE: path.resolve("data/drainers.txt"),
    TOKEN_SUPPLY_STATIC: "1000000000000000",
  });
  const chain = new FakeChain();
  const db = createDb(cfg.DATABASE_URL, { max: 4 });
  const ctx = await buildContext(cfg, {
    db,
    chain,
    log: silentLogger,
    sol: new StaticSolPrice(150),
    token: new StaticTokenPrice(0.00001, 6),
    nsfw: opts.nsfw,
  });
  const app = createApp({
    db: ctx.db,
    log: silentLogger,
    composer: ctx.composer,
    moderation: ctx.moderation,
    quotes: ctx.quotes,
    stats: ctx.stats,
    storage: ctx.storage,
    localFiles: ctx.localFiles,
    resolveImageUrl: ctx.resolveImageUrl,
    bus: ctx.bus,
    webOrigins: ["http://localhost:3000"],
    adminToken: ADMIN,
    helius: { secret: HELIUS_SECRET, conn: null, programId: PROGRAM_ID, decoder: ctx.decoder },
    rateLimits: { uploadsPerMin: opts.uploadsPerMin ?? 1000, quotePerMin: 1000 },
  });
  return { ctx, app, chain, cfg };
}

export async function truncateAll(ctx: { db: import("../src/db/client.js").Db }) {
  await ctx.db.execute(
    sql`truncate ads, chain_events, purchases, buybacks, auction_bids, auction, price_snapshots, indexer_cursor restart identity`,
  );
}
