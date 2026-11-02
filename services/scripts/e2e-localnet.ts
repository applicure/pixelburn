// End-to-end: real `pixel` program on solana-test-validator  <->  services (API + indexer + moderation
// + composer) as a separate process, wired only through RPC/websocket/HTTP/Postgres.
//
//   pnpm --filter @mpb/services e2e:localnet
//
// Needs: solana-test-validator on PATH, chain/target/deploy/pixel.so (anchor build), Postgres
// (E2E_DATABASE_URL, default mpb_e2e on the docker-compose server; recreated each run).
// Fixtures (pump curve, Pyth PriceUpdateV2, mint, token accounts) are preloaded with --account,
// like the SDK's LiteSVM test does.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BN } from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import postgres from "postgres";
import sharp from "sharp";
import {
  adPda,
  associatedTokenAddress,
  buyWithSolIx,
  buyWithTokenIx,
  coder,
  fetchCanvas,
  initializeIx,
  PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PYTH_RECEIVER_PROGRAM_ID,
  EMA_MIN_INTERVAL_SECS,
  EMA_WARMUP_CRANKS,
  EMA_WARMUP_SECS,
  SOL_USD_FEED_ID,
  spotPriceQ,
  TOKEN_PROGRAM_ID,
  transferAdIx,
  updateAdIx,
} from "@mpb/sdk";
import { SdkKeeperActions, sendIxs, sendIxsResult } from "../src/keeper/actions.js";
import { silentLogger } from "../src/lib/log.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVICES = path.resolve(here, "..");
const SO = path.resolve(SERVICES, "../chain/target/deploy/pixel.so");
const RPC_PORT = 18899;
const API_PORT = 18788;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const WS = `ws://127.0.0.1:${RPC_PORT + 1}`;
const API = `http://127.0.0.1:${API_PORT}`;
const ADMIN_TOKEN = "e2e-admin-token";
const DB_URL = process.env.E2E_DATABASE_URL ?? "postgres://mpb:mpb@127.0.0.1:54329/mpb_e2e";
const SOL = { price: 15_000_000_000n, expo: -8 }; // $150.00000000
const VSOL = 30_000_000_000n;
const VTOK = 1_073_000_000_000_000n;
// All timing comes from the program's constants as exported by @mpb/sdk (never hard-coded here).
const CRANK_EVERY_MS = (EMA_MIN_INTERVAL_SECS + 2) * 1000; // just above the on-chain minimum interval
const WARMUP_BUDGET_MS = Math.max(EMA_WARMUP_SECS * 1000, EMA_WARMUP_CRANKS * CRANK_EVERY_MS) + 4 * CRANK_EVERY_MS + 60_000;

// ------------------------------------------------------------------ tiny test harness
let failures = 0;
const results: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  console.log(results[results.length - 1]);
  if (!ok) failures++;
}
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 90_000): Promise<T> {
  const t0 = Date.now();
  let last: unknown;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
      if (/simulation failed|failed on-chain/.test((e as Error).message)) throw e; // real errors: fail fast
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}
const getJson = async (p: string, init?: RequestInit) => {
  const r = await fetch(`${API}${p}`, init);
  return { status: r.status, body: (await r.json()) as any };
};
const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` };

// ------------------------------------------------------------------ fixtures
const accDisc = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
function packMint(supply: bigint) {
  const d = Buffer.alloc(82);
  d.writeBigUInt64LE(supply, 36);
  d[44] = 6; // decimals
  d[45] = 1; // initialized
  return d;
}
function packTokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint) {
  const d = Buffer.alloc(165);
  mint.toBuffer().copy(d, 0);
  owner.toBuffer().copy(d, 32);
  d.writeBigUInt64LE(amount, 64);
  d[108] = 1;
  return d;
}
function packCurve(vsol: bigint, vtok: bigint) {
  const d = Buffer.alloc(151);
  Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]).copy(d, 0);
  d.writeBigUInt64LE(vtok, 8);
  d.writeBigUInt64LE(vsol, 16);
  return d;
}
function packPriceUpdate(publishTime: bigint) {
  const body = coder.types.encode("PriceUpdateV2", {
    write_authority: PublicKey.default,
    verification_level: { Full: {} },
    price_message: {
      feed_id: Array.from(Buffer.from(SOL_USD_FEED_ID, "hex")),
      price: new BN(SOL.price.toString()),
      conf: new BN(1_000_000),
      exponent: SOL.expo,
      publish_time: new BN(publishTime.toString()),
      prev_publish_time: new BN((publishTime - 1n).toString()),
      ema_price: new BN(SOL.price.toString()),
      ema_conf: new BN(1_000_000),
    },
    posted_slot: new BN(1),
  });
  return Buffer.concat([accDisc("PriceUpdateV2"), body]);
}
function accountFile(dir: string, name: string, pubkey: PublicKey, data: Buffer, owner: PublicKey) {
  const f = path.join(dir, `${name}.json`);
  writeFileSync(
    f,
    JSON.stringify({
      pubkey: pubkey.toBase58(),
      account: { lamports: 10_000_000, data: [data.toString("base64"), "base64"], owner: owner.toBase58(), executable: false, rentEpoch: 0, space: data.length },
    }),
  );
  return ["--account", pubkey.toBase58(), f];
}

async function send(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[]) {
  return sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
}

async function pngBytes(w: number, h: number, rgb: [number, number, number]) {
  return sharp({ create: { width: w * 10, height: h * 10, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();
}

async function upload(w: number, h: number, rgb: [number, number, number]) {
  const fd = new FormData();
  fd.set("file", new Blob([new Uint8Array(await pngBytes(w, h, rgb))]), "x.png");
  fd.set("w", String(w));
  fd.set("h", String(h));
  const r = await fetch(`${API}/api/uploads`, { method: "POST", body: fd });
  return (await r.json()) as { uri: string; sha256: string };
}

function spawnTsx(script: string, env: Record<string, string>, tag: string): ChildProcess {
  const child = spawn(path.join(SERVICES, "node_modules/.bin/tsx"), [script], {
    cwd: SERVICES,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = (b: Buffer) =>
    b.toString().split("\n").filter(Boolean).forEach((l) => {
      logLines.push(`[${tag}] ${l}`);
      if (process.env.E2E_VERBOSE) console.log(`  [${tag}] ${l}`);
    });
  child.stdout!.on("data", out);
  child.stderr!.on("data", out);
  return child;
}
const logLines: string[] = [];

// ------------------------------------------------------------------ main
async function main() {
  if (!existsSync(SO)) throw new Error(`missing ${SO}; run anchor build in /chain`);
  const work = mkdtempSync(path.join(tmpdir(), "mpb-e2e-"));
  const adminKp = Keypair.generate(); // admin + keeper
  const buyer = Keypair.generate();
  const treasury = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const curve = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID)[0];
  const priceUpdate = Keypair.generate().publicKey;
  const buyerAta = associatedTokenAddress(buyer.publicKey, mint);
  const keeperAta = associatedTokenAddress(adminKp.publicKey, mint);
  const now = BigInt(Math.floor(Date.now() / 1000));

  // --- validator
  const args = [
    "--reset", "--quiet", "--ledger", path.join(work, "ledger"),
    // Keep full history: the default ledger limit purges old slots, after which getTransaction returns
    // null for early txs and the backfill-from-scratch phase can't rebuild them (what timed out before).
    "--limit-ledger-size", "500000000",
    "--rpc-port", String(RPC_PORT), "--faucet-port", "19900", "--dynamic-port-range", "18000-18050",
    "--upgradeable-program", PROGRAM_ID.toBase58(), SO, adminKp.publicKey.toBase58(),
    ...accountFile(work, "mint", mint, packMint(2_000_000_000_000_000n), TOKEN_PROGRAM_ID),
    ...accountFile(work, "curve", curve, packCurve(VSOL, VTOK), PUMP_PROGRAM_ID),
    // publish_time in the future keeps the price "fresh" for the whole run
    ...accountFile(work, "price", priceUpdate, packPriceUpdate(now + 7_200n), PYTH_RECEIVER_PROGRAM_ID),
    ...accountFile(work, "buyer-ata", buyerAta, packTokenAccount(mint, buyer.publicKey, 1_000_000_000_000_000n), TOKEN_PROGRAM_ID),
    ...accountFile(work, "keeper-ata", keeperAta, packTokenAccount(mint, adminKp.publicKey, 500_000_000_000_000n), TOKEN_PROGRAM_ID),
  ];
  console.log(`starting solana-test-validator (ledger ${work}/ledger)`);
  const validator = spawn("solana-test-validator", args, { stdio: "ignore" });
  const conn = new Connection(RPC, "confirmed");
  let server: ChildProcess | null = null;
  let keeper: ChildProcess | null = null;
  const cleanup = () => {
    server?.kill("SIGTERM");
    keeper?.kill("SIGTERM");
    if (!process.env.E2E_KEEP) validator.kill("SIGTERM");
  };
  process.on("exit", cleanup);
  try {
    await until("validator", async () => (await conn.getSlot()) > 0, 60_000);
    for (const k of [adminKp.publicKey, buyer.publicKey]) {
      const sig = await conn.requestAirdrop(k, 100 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "confirmed");
    }

    // --- program init (admin = upgrade authority = keeper)
    const priceSource = { kind: "bondingCurve" as const, curve };
    await send(conn, [initializeIx({
      admin: adminKp.publicKey, tokenMint: mint, treasury, keeper: adminKp.publicKey, pythFeedIdHex: SOL_USD_FEED_ID,
      priceSource, maxPriceAgeSecs: 300n, buybackCapLamportsPerHour: 5_000_000_000n, buybackMaxSlippageBps: 1500,
      initialTokenEmaPriceSol: spotPriceQ(VSOL, VTOK),
    })], [adminKp]);
    check("initialize via SDK", true);

    // --- the real keeper process, LIVE, cranks the EMA (warm-up needs >= 10 cranks over >= 600 s)
    keeper = spawnTsx("src/keeper/main.ts", {
      RPC_URL: RPC, WS_URL: WS, PROGRAM_ID: PROGRAM_ID.toBase58(), TOKEN_MINT: mint.toBase58(),
      KEEPER_LIVE: "1", KEEPER_KEYPAIR: JSON.stringify(Array.from(adminKp.secretKey)),
      KEEPER_CRANK_INTERVAL_MS: String(CRANK_EVERY_MS), KEEPER_BUYBACK_INTERVAL_MS: "86400000", HEARTBEAT_FILE: path.join(work, "keeper.hb"),
    }, "keeper");
    const actions = new SdkKeeperActions(conn, PROGRAM_ID);

    // --- services process against the validator
    const db = postgres(DB_URL.replace(/\/[^/]+$/, "/postgres"), { max: 1, onnotice: () => {} });
    const dbName = new URL(DB_URL).pathname.slice(1);
    await db.unsafe(`drop database if exists "${dbName}" with (force)`);
    await db.unsafe(`create database "${dbName}"`);
    await db.end();
    const serverEnv = {
      // The program only accepts ar:// or https:// image URIs, so dev-storage URLs must be https.
      // The host is only a label here: services serves/reads those files from DATA_DIR.
      PORT: String(API_PORT), HOST: "127.0.0.1", PUBLIC_API_URL: "https://api.e2e.invalid", DATABASE_URL: DB_URL, DATA_DIR: path.join(work, "data"),
      RPC_URL: RPC, WS_URL: WS, PROGRAM_ID: PROGRAM_ID.toBase58(), TOKEN_MINT: mint.toBase58(),
      INDEXER_ENABLED: "1", INDEXER_BACKFILL_INTERVAL_MS: "4000", ADMIN_TOKEN, CORS_ORIGINS: "http://localhost:3000",
      // SOL/USD read on-chain from the same PriceUpdateV2 account the program uses (no Hermes, no fallback).
      PYTH_SOL_USD_ACCOUNT: priceUpdate.toBase58(), NODE_ENV: "production", LOG_LEVEL: "info",
    };
    server = spawnTsx("src/server.ts", serverEnv, "api");
    await until("api /readyz", async () => (await fetch(`${API}/readyz`)).ok, 60_000);
    check("services API up (migrations ran)", true);
    const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
    const chainCranks = async () => Number((await sql`select count(*)::int as n from price_snapshots where source = 'chain'`)[0]!.n);
    await until("first keeper crank indexed (TokenPriceUpdated)", async () => (await chainCranks()) >= 1, 90_000);
    check("keeper process cranked live; TokenPriceUpdated indexed", true);

    // --- SOL buy driven by the services quote (quote must equal what the program charges)
    const up1 = await upload(2, 2, [255, 0, 0]);
    const up2 = await upload(3, 1, [0, 0, 255]);
    const up3 = await upload(1, 1, [0, 255, 0]);
    const qSol = (await getJson("/api/quote?w=2&h=2&mode=sol")).body;
    check("quote sol returns lamports", /^\d+$/.test(qSol.lamports), `lamports=${qSol.lamports}`);
    const warmQuote = await getJson("/api/quote?w=3&h=1&mode=token");
    check("token quote refused while EMA warms up (503 warming_up)", warmQuote.status === 503 && warmQuote.body.tokenPaymentStatus === "warming_up", JSON.stringify(warmQuote.body));
    check("SOL quote explains $PIXEL status (tokenPaymentStatus)", qSol.tokenPaymentStatus === "warming_up", `${qSol.tokenPaymentStatus}: ${qSol.tokenPaymentDetail}`);

    const content = (u: { uri: string; sha256: string }, title: string, link: string) => ({ title, link, imageUri: u.uri, imageSha256: u.sha256 });
    await send(conn, [buyWithSolIx({
      buyer: buyer.publicKey, rect: { x: 0, y: 0, w: 2, h: 2 }, content: content(up1, "Red", "https://red.example"),
      priceUpdate, treasury, maxLamports: BigInt(qSol.lamports),
    })], [buyer]);
    check("buy_with_sol with max_lamports = services quote (exact)", true);
    const qBad = (await getJson("/api/quote?w=1&h=1&mode=sol")).body;
    await send(conn, [buyWithSolIx({
      buyer: buyer.publicKey, rect: { x: 50, y: 50, w: 1, h: 1 }, content: content(up3, "Spam", "https://bit.ly/free"),
      priceUpdate, treasury, maxLamports: BigInt(qBad.lamports),
    })], [buyer]);

    // --- indexer (onLogs, provisional) -> hydrate from Ad account -> automatic checks
    const queue = await until("checked SOL ad in admin queue", async () => {
      const q = (await getJson("/api/admin/queue", { headers: admin })).body as any[];
      return q.length === 1 && q[0].checks && q[0].checks.every((c: any) => c.ok) ? q : null;
    });
    check("indexed + hydrated + all checks pass (sha256 vs on-chain, dims)", queue[0].id === 0 && queue[0].title === "Red");
    const rejected = await until("blocklisted ad auto-rejected", async () => {
      const q = (await getJson("/api/admin/queue?status=rejected", { headers: admin })).body as any[];
      return q.length === 1 ? q[0] : null;
    });
    check("blocklisted link auto-rejected", /blocklist/.test(rejected.reason), rejected.reason);

    // --- update + transfer -> AdUpdated (back to moderation) + AdTransferred
    await getJson("/api/admin/ads/0/approve", { method: "POST", headers: admin });
    check("approve -> /api/ads lists ad 0", ((await getJson("/api/ads")).body as any[]).some((a) => a.id === 0));
    const newOwner = Keypair.generate().publicKey;
    const up4 = await upload(2, 2, [255, 255, 0]);
    await send(conn, [
      updateAdIx({ owner: buyer.publicKey, ad: adPda(0, 0), content: content(up4, "Yellow", "https://yellow.example") }),
      transferAdIx({ owner: buyer.publicKey, ad: adPda(0, 0), newOwner }),
    ], [buyer]);
    const updated = await until("ad 0 re-hydrated after AdUpdated", async () => {
      const q = (await getJson("/api/admin/queue", { headers: admin })).body as any[];
      const a = q.find((x) => x.id === 0);
      return a && a.title === "Yellow" && a.checks ? a : null;
    });
    check("AdUpdated: ad back to pending with new on-chain content", updated.status === "pending" && updated.link === "https://yellow.example");
    check("AdTransferred: owner updated", updated.owner === newOwner.toBase58());
    check("updated ad left the public list until re-approved", ((await getJson("/api/ads")).body as any[]).every((a) => a.id !== 0));

    // --- wait for the EMA warm-up (keeper keeps cranking), then token payments open up
    console.log(`waiting for EMA warm-up (>= ${EMA_WARMUP_CRANKS} cranks over >= ${EMA_WARMUP_SECS} s, keeper cranks every ${CRANK_EVERY_MS / 1000} s; budget ${Math.round(WARMUP_BUDGET_MS / 60_000)} min)...`);
    const qTok = await until("token quote available", async () => {
      // (status is polled through the services API, which uses the SDK's tokenPricingStatus)
      const r = await getJson("/api/quote?w=3&h=1&mode=token");
      return r.status === 200 ? r.body : null;
    }, WARMUP_BUDGET_MS);
    check("token quote available after warm-up", /^\d+$/.test(qTok.tokens), `tokens=${qTok.tokens}, cranks indexed=${await chainCranks()}`);
    await send(conn, [buyWithTokenIx({
      buyer: buyer.publicKey, rect: { x: 10, y: 5, w: 3, h: 1 }, content: content(up2, "Blue", "https://blue.example"),
      priceUpdate, tokenMint: mint, priceSource, maxTokens: BigInt(qTok.tokens),
    })], [buyer]);
    check("buy_with_token with max_tokens = services quote (exact)", true);

    // --- keeper buyback: release -> (swap out-of-band) -> record, one atomic tx via SdkKeeperActions
    const spent = 100_000_000n; // 0.1 SOL
    const tokens = 4_000_000_000_000n; // > spent * 1e18 / EMA * (1 - 15%)
    const bbSig = await sendIxs(
      conn, adminKp,
      [...(await actions.releaseBuybackIxs(adminKp.publicKey, spent))!, ...(await actions.recordBuybackBurnIxs(adminKp.publicKey, spent, tokens))!],
      { live: true }, silentLogger, "buyback",
    );
    check("keeper release_buyback + record_buyback_burn (atomic, SDK builders)", !!bbSig);

    // --- approve both -> canvas
    // ids are assigned in landing order, so look them up instead of assuming them
    const pending = await until("token ad checked", async () => {
      const q = (await getJson("/api/admin/queue", { headers: admin })).body as any[];
      return q.length === 2 && q.every((a) => a.checks && a.checks.every((c: any) => c.ok)) ? q : null;
    });
    const etag0 = (await fetch(`${API}/api/canvas.png`)).headers.get("etag");
    for (const a of pending) await getJson(`/api/admin/ads/${a.id}/approve`, { method: "POST", headers: admin });
    const adsList = (await getJson("/api/ads")).body as any[];
    const modes = adsList.map((a) => a.payMode).sort().join(",");
    check("/api/ads lists the 2 approved ads (sol + token)", adsList.length === 2 && modes === "sol,token", JSON.stringify(adsList.map((a) => [a.id, a.payMode, a.usd])));
    const canvasRes = await fetch(`${API}/api/canvas.png`);
    const png = Buffer.from(await canvasRes.arrayBuffer());
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    check("canvas ETag changed after approve", canvasRes.headers.get("etag") !== etag0);
    check("canvas pixels: yellow at (5,5), blue at (105,55)", px(5, 5).join() === "255,255,0" && px(105, 55).join() === "0,0,255", `${px(5, 5)} / ${px(105, 55)}`);
    await sql.end();

    // --- everything finalizes; DB totals == Canvas account totals
    await until("all events finalized", async () => {
      const h = (await getJson("/healthz")).body;
      return h.indexer && h.indexer.provisionalTxs === 0 && !h.indexer.stale ? h : null;
    }, 120_000);
    const health = (await getJson("/healthz")).body;
    check("/healthz: indexer fresh, 0 provisional", health.ok === true, JSON.stringify(health.indexer));
    const compare = async (label: string) => {
      const c = await fetchCanvas(conn);
      const s = (await getJson("/api/stats")).body;
      const occ = (await getJson("/api/occupancy")).body;
      const pairs: [string, string, string][] = [
        ["soldBlocks", String(s.soldBlocks), String(c.soldBlocks)],
        ["usdRaised(micro)", String(Math.round(s.usdRaised * 1e6)), c.usdMicroRaised.toString()],
        ["lamportsRaised", s.lamportsRaised, c.lamportsRaised.toString()],
        ["lamportsToTreasury", s.lamportsToTreasury, c.lamportsToTreasury.toString()],
        ["lamportsToBuyback", s.lamportsToBuyback, c.lamportsToBuyback.toString()],
        ["tokensBurnedDirect", s.tokensBurnedDirect, c.tokensBurnedDirect.toString()],
        ["tokensBurnedBuyback", s.tokensBurnedBuyback, c.tokensBurnedBuyback.toString()],
        ["lamportsSpentBuyback", s.lamportsSpentBuyback, c.lamportsSpentBuyback.toString()],
        ["occupancy bitmap", occ.bitmap, Buffer.from(c.bitmap).toString("base64")],
      ];
      for (const [k, a, b] of pairs) check(`${label}: ${k} DB == Canvas`, a === b, k === "occupancy bitmap" ? "" : `${a} vs ${b}`);
      return s;
    };
    const statsLive = await compare("live");

    // --- crash/restart: wipe DB, restart services -> finalized backfill rebuilds the same state
    server.kill("SIGTERM");
    await new Promise((r) => server!.once("exit", r));
    const wipe = postgres(DB_URL, { max: 1, onnotice: () => {} });
    await wipe.unsafe("drop schema public cascade; drop schema if exists drizzle cascade; create schema public;");
    await wipe.end();
    server = spawnTsx("src/server.ts", serverEnv, "api");
    await until("api up after wipe", async () => (await fetch(`${API}/readyz`)).ok, 60_000);
    await until("backfill rebuilt 3 ads + buyback", async () => {
      const s = (await getJson("/api/stats")).body;
      return s.adsCount === 3 && s.lamportsSpentBuyback === statsLive.lamportsSpentBuyback ? s : null;
    });
    const statsBackfill = await compare("backfill-from-scratch");
    const feed = (await getJson("/api/feed?limit=50")).body as any[];
    check("feed after backfill: 3 purchases + 1 buyback, all finalized", feed.length === 4 && feed.every((f) => f.finalized), feed.map((f) => f.type).join(","));
    check("backfill stats equal live stats", JSON.stringify({ ...statsBackfill, updatedAt: 0, solPriceUsd: 0, tokenPriceUsd: 0, marketCapUsd: 0, tokenSupply: 0, burnedPct: 0 }) === JSON.stringify({ ...statsLive, updatedAt: 0, solPriceUsd: 0, tokenPriceUsd: 0, marketCapUsd: 0, tokenSupply: 0, burnedPct: 0 }));
    const supply = BigInt(statsBackfill.tokenSupply);
    const expectedSupply = 2_000_000_000_000_000n - BigInt(statsBackfill.tokensBurned);
    check("tokenSupply read on-chain reflects burns", supply === expectedSupply, `${supply} vs ${expectedSupply}`);
    check("keeper process still running", keeper?.exitCode === null);
    check("keeper heartbeat fresh", existsSync(path.join(work, "keeper.hb")));
    const allLogs = logLines.join("\n");
    check("no keeper secret / RPC secrets in any service log", !allLogs.includes(JSON.stringify(Array.from(adminKp.secretKey)).slice(1, 40)));
  } catch (e) {
    console.error("---- last service log lines ----\n" + logLines.slice(-40).join("\n"));
    throw e;
  } finally {
    cleanup();
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E ERROR:", e);
  process.exit(1);
});
