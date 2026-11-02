// Demo seed: ~300 ads (~30% of blocks), purchase/buyback history and price snapshots.
// Events go through the real ingest path (encoded -> fake logs -> parsed -> ingested),
// images are generated pixel art stored via local storage, then moderation checks run.
//   pnpm --filter @mpb/services seed           (wipes and reseeds the DB)
import { randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { eq, inArray, sql } from "drizzle-orm";
import { loadConfig } from "./config.js";
import { buildContext } from "./context.js";
import { NOTIFY_CHANNEL, runMigrations } from "./db/client.js";
import { ads, priceSnapshots } from "./db/schema.js";
import { fakeLogs, SdkEventParser, type ProgramEvent } from "./chain/events.js";
import { adPda, PROGRAM_ID as SDK_PROGRAM_ID } from "@mpb/sdk";
import { ingestTx } from "./indexer/ingest.js";
import { emptyBitmap, getBlock, isRectFree, rectBlocks, setBlock } from "./lib/blocks.js";
import { mulberry32, generatePixelArt } from "./lib/pixelart.js";
import { applyTokenDiscount, quoteLamports, quoteTokensForUsd, quoteUsd, solPerTokenToQ } from "./lib/quote-math.js";
import { sha256Hex } from "./uploads/process.js";
import { createLogger } from "./lib/log.js";

const TARGET_ADS = Number(process.env.SEED_ADS ?? 300);
const SEED = Number(process.env.SEED_RANDOM ?? 1337);
const DAYS = 30;
const SEED_PROGRAM_ID = SDK_PROGRAM_ID.toBase58(); // frames the fake logs

const SIZES: [number, number, number][] = [
  // w, h, weight  (mean ≈ 10 blocks/ad -> ~30% of the canvas at 300 ads)
  [1, 1, 10], [2, 1, 8], [1, 2, 4], [2, 2, 14], [3, 2, 10], [3, 3, 10], [4, 2, 8], [4, 3, 7], [4, 4, 6],
  [5, 2, 5], [6, 3, 4], [5, 5, 3], [8, 4, 2.5], [10, 5, 1.2], [6, 6, 1.5], [10, 10, 0.5], [20, 10, 0.12],
];
/**
 * The program only accepts https:// (or ar://) image URIs. In dev, PUBLIC_API_URL is usually
 * http://localhost:PORT; store the https form "as if on-chain". The API maps localhost /files/
 * URIs back to PUBLIC_API_URL when serving imageUrl, so browsers still load them.
 */
const onChainUri = (uri: string) => uri.replace(/^http:\/\//, "https://");

const ADJ = ["Pixel", "Lunar", "Based", "Turbo", "Neon", "Degen", "Solar", "Quantum", "Retro", "Hyper", "Cosmic", "Frog", "Diamond", "Laser", "Golden", "Mega", "Tiny", "Brave"];
const NOUN = ["Pizza", "Labs", "DAO", "Swap", "Club", "Studio", "Arcade", "Garden", "Rocket", "Coffee", "Wallet", "Bakery", "Records", "Market", "Gym", "Radio", "Atlas", "Forge"];

async function main() {
  const cfg = loadConfig();
  if (cfg.NODE_ENV === "production" && process.env.SEED_ALLOW_PRODUCTION !== "1") {
    throw new Error("refusing to seed (wipes all tables) with NODE_ENV=production; set SEED_ALLOW_PRODUCTION=1 for a demo deployment");
  }
  const log = createLogger("seed", cfg.LOG_LEVEL);
  const ctx = await buildContext(cfg, { chain: null, log });
  await runMigrations(ctx.handle);
  const db = ctx.db;
  const rng = mulberry32(SEED);
  const ri = (n: number) => Math.floor(rng() * n);
  const sig = () => bs58.encode(randomBytes(64));

  log.info("wiping tables");
  await db.execute(sql`truncate ads, chain_events, purchases, buybacks, auction_bids, auction, price_snapshots, indexer_cursor restart identity`);

  const wallets = Array.from({ length: 140 }, () => Keypair.generate().publicKey.toBase58());
  const pickWallet = () => wallets[Math.min(wallets.length - 1, Math.floor(wallets.length * Math.pow(rng(), 2.2)))]!; // skewed

  // Price paths over the window: SOL/USD random walk, token price (SOL per whole token) trending up.
  const now = Math.floor(Date.now() / 1000);
  const start = now - DAYS * 86400;
  const hours = DAYS * 24;
  const solPath: number[] = [];
  const tokPath: number[] = [];
  let solP = 158, tokP = 0.0000095; // ~$1.5M market cap at 1e9 supply
  for (let i = 0; i <= hours; i++) {
    solP = Math.max(90, solP * (1 + (rng() - 0.5) * 0.02));
    tokP = Math.max(1e-7, tokP * (1 + (rng() - 0.49) * 0.03));
    solPath.push(solP);
    tokPath.push(tokP);
  }
  const at = (ts: number) => Math.min(hours, Math.max(0, Math.floor((ts - start) / 3600)));

  await db.insert(priceSnapshots).values(
    solPath.map((s, i) => {
      const fixed = solPerTokenToQ(tokPath[i]!, cfg.TOKEN_DECIMALS);
      return {
        ts: new Date((start + i * 3600) * 1000), source: "seed", solUsd: s,
        tokenSpotSol: fixed.toString(), tokenEmaSol: fixed.toString(), tokenUsd: tokPath[i]! * s, finalized: true,
      };
    }),
  );

  // Place rectangles.
  const bm = emptyBitmap();
  const totalW = SIZES.reduce((a, s) => a + s[2], 0);
  const sampleSize = () => {
    let r = rng() * totalW;
    for (const s of SIZES) if ((r -= s[2]) <= 0) return s;
    return SIZES[0]!;
  };
  type Placed = { x: number; y: number; w: number; h: number };
  const placed: Placed[] = [];
  // Sample all sizes first and place largest-first so big ads don't fail placement
  // (keeps the sold share close to the sampled mean, ~30%).
  const wanted = Array.from({ length: TARGET_ADS }, sampleSize).sort((a, b) => b[0] * b[1] - a[0] * a[1]);
  for (const [w, h] of wanted) {
    for (let attempt = 0; attempt < 5_000; attempt++) {
      // Mild bias toward the top like the original homepage.
      const x = ri(101 - w);
      const y = Math.min(100 - h, Math.floor(Math.pow(rng(), 1.3) * (101 - h)));
      const r = { x, y, w, h };
      if (!isRectFree(bm, r)) continue;
      rectBlocks(r).forEach((b) => setBlock(bm, b));
      placed.push(r);
      break;
    }
  }
  // Shuffle so ad ids (purchase order) aren't sorted by size.
  for (let i = placed.length - 1; i > 0; i--) {
    const j = ri(i + 1);
    [placed[i], placed[j]] = [placed[j]!, placed[i]!];
  }

  // Purchase timestamps, ascending with ad id.
  const times = placed.map(() => start + ri(DAYS * 86400)).sort((a, b) => a - b);
  log.info(`placing ${placed.length} ads; generating images`);

  let slot = 300_000_000;
  const meta: { id: number; title: string; link: string; uri: string; sha: string }[] = [];
  let lamportsToBuyback = 0n;
  for (let i = 0; i < placed.length; i++) {
    const r = placed[i]!;
    const ts = times[i]!;
    const solUsd = solPath[at(ts)]!;
    const solMicro = BigInt(Math.round(solUsd * 1e6));
    const fullUsd = quoteUsd(r.w, r.h);
    const payMode = rng() < 0.3 ? "token" : "sol";
    const lamports = payMode === "sol" ? quoteLamports(fullUsd, solMicro) : 0n;
    const q = solPerTokenToQ(tokPath[at(ts)]!, cfg.TOKEN_DECIMALS);
    const tokensBurned = payMode === "token" ? quoteTokensForUsd(fullUsd, q, q, solMicro, -6) : 0n;
    // Like the program, token purchases record the discounted USD actually paid.
    const usdMicro = payMode === "token" ? applyTokenDiscount(fullUsd) : fullUsd;
    if (payMode === "sol") lamportsToBuyback += lamports - lamports / 2n;
    const ev: ProgramEvent = {
      name: "AdPurchased", adId: i, ad: adPda(r.x, r.y).toBase58(), owner: pickWallet(), ...r, payMode, lamports, tokensBurned, usdMicro, ts: BigInt(ts),
    };
    // Round-trip through the production (SDK) log parser.
    const events = new SdkEventParser(SEED_PROGRAM_ID).parse(fakeLogs(SEED_PROGRAM_ID, [ev]));
    await ingestTx(db, { signature: sig(), slot: slot += 50 + ri(5000), finalized: true, source: "seed", events });

    const png = await generatePixelArt(r.w, r.h, SEED * 1000 + i);
    const sha = sha256Hex(png);
    const stored = await ctx.localFiles.put(png, "image/png", sha);
    await ctx.composer.cacheImage(sha, png);
    const title = `${ADJ[ri(ADJ.length)]} ${NOUN[ri(NOUN.length)]}`;
    meta.push({ id: i, title, link: `https://${title.toLowerCase().replace(/\s+/g, "")}.example/?ref=mpb`, uri: onChainUri(stored.uri), sha });
  }

  // A few ads intentionally fail moderation (blocked domain, bad hash, plain http).
  const bad = new Set<number>();
  while (bad.size < Math.round(placed.length * 0.04)) bad.add(ri(placed.length));
  const badKinds = ["https://bit.ly/free-sol", "http://insecure.example/", "sha"];
  let k = 0;
  for (const m of meta) {
    let { link, sha } = m;
    if (bad.has(m.id)) {
      const kind = badKinds[k++ % badKinds.length]!;
      if (kind === "sha") sha = sha256Hex(Buffer.from(`tampered-${m.id}`));
      else link = kind;
    }
    await db.update(ads).set({ title: m.title, link, imageUri: m.uri, imageSha256: sha, hydrated: true }).where(eq(ads.id, m.id));
  }

  // Run real automatic checks on everything.
  log.info("running moderation checks");
  for (;;) {
    const n = await ctx.moderation.checkPending(100);
    if (n === 0) break;
  }
  // Approve ~90% of the ads that passed checks; leave the rest pending for the admin queue.
  const passed = await db.select({ id: ads.id }).from(ads).where(eq(ads.status, "pending")).orderBy(ads.id);
  const approveIds = passed.filter(() => rng() < 0.9).map((r) => r.id);
  if (approveIds.length) {
    await db
      .update(ads)
      .set({ status: "approved", moderatedAt: new Date(), moderatedBy: "seed" })
      .where(inArray(ads.id, approveIds));
  }

  // A few ownership transfers.
  for (let t = 0; t < 6; t++) {
    const id = ri(placed.length);
    const [row] = await db.select({ owner: ads.owner, address: ads.address }).from(ads).where(eq(ads.id, id));
    const ev: ProgramEvent = { name: "AdTransferred", adId: id, ad: row!.address!, from: row!.owner, to: pickWallet(), ts: BigInt(now - ri(86400)) };
    await ingestTx(db, { signature: sig(), slot: slot += 100, finalized: true, source: "seed", events: [ev] });
  }

  // Buybacks: spend ~70% of the buyback share over the window in ~40 burns.
  const nBuybacks = 40;
  const budget = (lamportsToBuyback * 7n) / 10n;
  for (let b = 0; b < nBuybacks; b++) {
    const ts = start + Math.floor(((b + 0.5 + (rng() - 0.5) * 0.8) / nBuybacks) * DAYS * 86400);
    const lamportsIn = budget / BigInt(nBuybacks) + BigInt(ri(200_000_000)) - 100_000_000n;
    const solPerToken = tokPath[at(ts)]!;
    const tokensBurned = BigInt(Math.floor((Number(lamportsIn) / 1e9 / solPerToken) * 10 ** cfg.TOKEN_DECIMALS * 0.99));
    const events: ProgramEvent[] = [{ name: "BuybackBurned", lamportsIn, tokensBurned, ts: BigInt(ts) }];
    await ingestTx(db, { signature: sig(), slot: slot += 1000, finalized: true, source: "seed", events });
  }

  const [counts] = await db.execute<{ approved: number; pending: number; rejected: number }>(sql`
    select count(*) filter (where status='approved')::int as approved,
           count(*) filter (where status='pending')::int as pending,
           count(*) filter (where status='rejected')::int as rejected from ads`);
  let sold = 0;
  for (let i = 0; i < 10_000; i++) if (getBlock(bm, i)) sold++;
  log.info(`ads: ${placed.length} (${JSON.stringify(counts)}), sold blocks: ${sold} (${(sold / 100).toFixed(1)}%)`);

  log.info("rendering canvas");
  const img = await ctx.composer.rebuild();
  log.info(`canvas.png ${img.png.length} bytes etag ${img.etag}`);
  // Tell running API processes to re-render their in-memory canvas.
  await db.execute(sql`select pg_notify(${NOTIFY_CHANNEL}, ${JSON.stringify({ kind: "canvas" })})`);
  await ctx.handle.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
