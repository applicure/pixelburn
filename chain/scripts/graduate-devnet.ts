/**
 * Curve -> PumpSwap graduation runbook, scripted for devnet. DRY RUN by default (simulates; sends nothing).
 *   node graduate-devnet.ts status
 *   node graduate-devnet.ts buyout  [--execute]   deployer buys the remaining real tokens -> curve.complete = true
 *   node graduate-devnet.ts migrate [--execute]   permissionless pump `migrate_v2` (on mainnet pump's bot does this)
 *   node graduate-devnet.ts switch  [--execute]   admin set_price_source(canonical Pool, seed = pool spot)
 * Then: node devnet-verify.ts crank 10 65   (warm-up; token payments resume when tokenPricingStatus is ok)
 * Devnet only; never prints secrets or RPC URLs. Appends every sent tx to ../devnet-log.json.
 */
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction, clusterApiUrl } from "@solana/web3.js";
import {
  OnlinePumpSdk, PUMP_SDK, canonicalPumpPoolPda, getBuySolAmountFromTokenAmount, isBondingCurveMigrated,
} from "@pump-fun/pump-sdk";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT, fetchConfig, parseBondingCurve, poolSpotPriceQ, setPriceSourceIx,
  tokenPricingStatus, type PriceSource,
} from "@mpb/sdk";
import BN from "bn.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const EXECUTE = process.argv.includes("--execute");
const cmd = process.argv[2] ?? "status";
const keys = (n: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(resolve(here, `../keys/${n}.json`), "utf8"))));
const url = process.env.SOLANA_RPC ?? (process.env.SOLANA_RPC_HELIUS_KEY ? `https://devnet.helius-rpc.com/?api-key=${process.env.SOLANA_RPC_HELIUS_KEY}` : clusterApiUrl("devnet"));
if (/mainnet/i.test(url) || (process.env.SOLANA_CLUSTER ?? "devnet") !== "devnet") throw new Error("devnet only");
const c = new Connection(url, "confirmed");
const ata = (owner: PublicKey, mint: PublicKey, tp: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), tp.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];

function log(step: string, sig: string, extra: Record<string, unknown> = {}) {
  const p = resolve(here, "../devnet-log.json");
  const arr = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : [];
  arr.push({ step, sig, explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet`, at: new Date().toISOString(), ...extra });
  writeFileSync(p, JSON.stringify(arr, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`${step}: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
}

async function run(label: string, ixs: TransactionInstruction[], signers: Keypair[], extra: Record<string, unknown> = {}) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs);
  tx.feePayer = signers[0]!.publicKey;
  const bh = await c.getLatestBlockhash("confirmed");
  tx.recentBlockhash = bh.blockhash;
  tx.sign(...signers);
  if (!EXECUTE) {
    const sim = await c.simulateTransaction(tx);
    console.log(`[dry run] ${label}: simulate ${sim.value.err ? `ERR ${JSON.stringify(sim.value.err)}` : "OK"} (CU ${sim.value.unitsConsumed})`);
    if (sim.value.err) console.log((sim.value.logs ?? []).slice(-6).join("\n"));
    return;
  }
  const sig = await c.sendRawTransaction(tx.serialize());
  await c.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  log(label, sig, extra);
}

const cfg = await fetchConfig(c);
const mint = cfg.tokenMint;
const pool = canonicalPumpPoolPda(mint);
const baseVault = ata(pool, mint, cfg.tokenProgram);
const quoteVault = ata(pool, WSOL_MINT, TOKEN_PROGRAM_ID);
const online = new OnlinePumpSdk(c);

async function curveState() {
  const curveKey = cfg.priceSource.kind === "bondingCurve" ? cfg.priceSource.curve : PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"))[0];
  const a = await c.getAccountInfo(curveKey);
  if (!a) return { curveKey, exists: false } as const;
  const p = parseBondingCurve(a.data);
  const realTok = a.data.readBigUInt64LE(24);
  return { curveKey, exists: true, complete: p.complete, realTok, vsol: p.quoteLamports, vtok: p.baseUnits } as const;
}

switch (cmd) {
  case "status": {
    const cs = await curveState();
    const [p, b, q] = await c.getMultipleAccountsInfo([pool, baseVault, quoteVault]);
    let poolSpot: bigint | null = null;
    if (p && b && q) poolSpot = poolSpotPriceQ(p.data, b.data, q.data);
    console.log(JSON.stringify({
      configSource: cfg.priceSource.kind, curve: cs, canonicalPool: pool.toBase58(), poolExists: !!p, baseVault: baseVault.toBase58(), quoteVault: quoteVault.toBase58(),
      poolSpotQ: poolSpot, emaQ: cfg.tokenEmaPriceSol, warmupCranks: cfg.emaWarmupCranks,
      tokenPricing: poolSpot && cfg.priceSource.kind === "pool" ? tokenPricingStatus(cfg, poolSpot, Math.floor(Date.now() / 1000), 1) : "n/a",
    }, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof PublicKey ? v.toBase58() : v), 2));
    break;
  }
  case "buyout": {
    const cs = await curveState();
    if (!cs.exists || cs.complete) throw new Error("curve missing or already complete");
    const buyer = keys("deployer");
    const [global, feeConfig, st] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig().catch(() => null), online.fetchBuyState(mint, buyer.publicKey, cfg.tokenProgram)]);
    const mintSupply = new BN((await c.getTokenSupply(mint)).value.amount);
    const amount = new BN(cs.realTok.toString()); // all remaining real tokens => completes the curve
    const solAmount = getBuySolAmountFromTokenAmount({ global, feeConfig, mintSupply, bondingCurve: st.bondingCurve, amount, quoteMint: st.quoteMint });
    const maxSol = solAmount.muln(102).divn(100);
    console.log(`buy out ${amount.toString()} base units for ~${Number(solAmount) / 1e9} SOL (max ${Number(maxSol) / 1e9})`);
    const ixs = await PUMP_SDK.buyInstructions({ global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: st.bondingCurve,
      associatedUserAccountInfo: st.associatedUserAccountInfo, mint, user: buyer.publicKey, amount, solAmount: maxSol, slippage: 1, tokenProgram: cfg.tokenProgram });
    await run("graduation: deployer buys out the curve", ixs, [buyer], { tokens: amount.toString(), maxSol: maxSol.toString() });
    break;
  }
  case "migrate": {
    const cs = await curveState();
    if (!cs.exists || !cs.complete) throw new Error("curve not complete yet");
    const user = keys("deployer");
    const global = await online.fetchGlobal();
    const ix = await PUMP_SDK.migrateV2Instruction({ withdrawAuthority: (global as unknown as { withdrawAuthority: PublicKey }).withdrawAuthority,
      mint, user: user.publicKey, baseTokenProgram: cfg.tokenProgram, quoteTokenProgram: TOKEN_PROGRAM_ID });
    await run("graduation: pump migrate_v2 (permissionless)", [ix], [user], { pool: pool.toBase58() });
    break;
  }
  case "switch": {
    const cs = await curveState();
    if (cs.exists && !cs.complete) throw new Error("refusing: curve not complete (pricing must stay on the curve until it graduates)");
    const [p, b, q] = await c.getMultipleAccountsInfo([pool, baseVault, quoteVault]);
    if (!p || !b || !q) throw new Error("canonical pool / vaults not found yet: wait for migration");
    const seed = poolSpotPriceQ(p.data, b.data, q.data);
    const ps: PriceSource = { kind: "pool", pool, baseVault, quoteVault };
    console.log(`switch price source -> pool ${pool.toBase58()} (seed EMA = pool spot ${seed})`);
    await run("graduation: admin set_price_source(Pool, seed = pool spot)", [setPriceSourceIx({ admin: keys("admin").publicKey, priceSource: ps, initialEmaPriceSol: seed })], [keys("admin")], { seed });
    console.log("next: node devnet-verify.ts crank 10 65  (token payments: warmingUp -> ok after >= 10 min)");
    break;
  }
  default:
    console.log("usage: status | buyout | migrate | switch  [--execute]");
}
void isBondingCurveMigrated;
