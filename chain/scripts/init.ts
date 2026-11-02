/**
 * Devnet bootstrap for the `pixel` program (Node >= 23: runs as TypeScript natively).
 *
 *   node init.ts                # DRY RUN (default): prints the plan, builds + sizes every tx, simulates if possible
 *   node init.ts --execute      # actually sends (spends devnet SOL)
 *
 * Steps:
 *   1. create a test SPL mint: 1,000,000,000 tokens, 6 decimals, minted to the admin ATA, mint authority revoked
 *   2. fund the treasury to rent-exemption if it is a fresh account
 *   3. initialize Config/Canvas/buyback vault (admin must be the program's upgrade authority)
 *
 * Env: SOLANA_RPC (full RPC URL incl. key) or SOLANA_RPC_HELIUS_KEY (devnet -> https://devnet.helius-rpc.com/?api-key=…),
 *      SOLANA_CLUSTER (default devnet; public endpoint fallback). The RPC URL and keys are never printed.
 *      ADMIN_KEYPAIR (default ../keys/admin.json, else ~/.config/solana/id.json),
 *      MINT=<pubkey> (use an EXISTING mint, e.g. a pump.fun coin from pump-devnet.ts; its token program is detected and
 *      no test mint is created), TREASURY, KEEPER (default admin),
 *      PROGRAM_ID (default SDK PROGRAM_ID), MINT_KEYPAIR (reuse a mint keypair file), PRICE_SOURCE
 *      ("curve:<pubkey>" | "pool:<pool>,<baseVault>,<quoteVault>"; default: the pump.fun bonding-curve PDA of the mint),
 *      INITIAL_TOKEN_EMA (lamports/base unit * 1e18; default: live spot of PRICE_SOURCE if it exists, else 0 = token
 *      payments disabled until set_price_source seeds it), TOKEN_BLOCKS_CAP_PER_HOUR (default 1000, max 5000),
 *      BUYBACK_CAP_SOL_PER_HOUR (default 10), BUYBACK_MAX_SLIPPAGE_BPS (default 1500), MAX_PRICE_AGE_SECS (default 120)
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  PROGRAM_ID,
  PUMP_PROGRAM_ID,
  SOL_USD_FEED_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  buybackVaultPda,
  canvasPda,
  configPda,
  fetchConfig,
  initializeIx,
  readSpotPriceQ,
  type PriceSource,
} from "@mpb/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const EXECUTE = process.argv.includes("--execute");
const DECIMALS = 6;
const SUPPLY = 1_000_000_000n * 10n ** BigInt(DECIMALS);

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

function parsePriceSource(mint: PublicKey): PriceSource {
  const v = process.env.PRICE_SOURCE;
  if (!v) {
    const curve = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID)[0];
    return { kind: "bondingCurve", curve };
  }
  if (v.startsWith("curve:")) return { kind: "bondingCurve", curve: new PublicKey(v.slice(6)) };
  if (v.startsWith("pool:")) {
    const [pool, base, quote] = v.slice(5).split(",").map((s) => new PublicKey(s.trim()));
    if (!pool || !base || !quote) throw new Error("PRICE_SOURCE pool needs 3 keys");
    return { kind: "pool", pool, baseVault: base, quoteVault: quote };
  }
  throw new Error(`bad PRICE_SOURCE ${v}`);
}

// ---- raw SPL Token instructions (avoid an extra dependency)
const initializeMint2 = (mint: PublicKey, authority: PublicKey) =>
  new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
    data: Buffer.concat([Buffer.from([20, DECIMALS]), authority.toBuffer(), Buffer.from([0])]),
  });
const createAtaIdempotent = (payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey) =>
  new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
const mintTo = (mint: PublicKey, dest: PublicKey, authority: PublicKey, amount: bigint) => {
  const data = Buffer.alloc(9);
  data[0] = 7;
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
};
const revokeMintAuthority = (mint: PublicKey, authority: PublicKey) =>
  new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([6, 0, 0]), // SetAuthority(MintTokens, None)
  });

/** Resolves the RPC endpoint. Returns a label that is safe to print (never the URL or key). */
function resolveRpc(): { url: string; label: string } {
  const cluster = process.env.SOLANA_CLUSTER ?? "devnet";
  if (cluster !== "devnet") throw new Error(`SOLANA_CLUSTER=${cluster} not supported by this script (devnet only)`);
  if (process.env.SOLANA_RPC) return { url: process.env.SOLANA_RPC, label: `SOLANA_RPC (${cluster}, redacted)` };
  if (process.env.SOLANA_RPC_HELIUS_KEY) {
    return {
      url: `https://devnet.helius-rpc.com/?api-key=${process.env.SOLANA_RPC_HELIUS_KEY}`,
      label: "Helius devnet (key redacted)",
    };
  }
  return { url: clusterApiUrl("devnet"), label: "public devnet endpoint" };
}

async function main() {
  const { url: rpc, label: rpcLabel } = resolveRpc();
  if (/mainnet/i.test(rpc)) throw new Error("refusing to run against mainnet");
  const connection = new Connection(rpc, "confirmed");
  const defaultAdmin = existsSync(resolve(here, "../keys/admin.json"))
    ? resolve(here, "../keys/admin.json")
    : resolve(homedir(), ".config/solana/id.json");
  const admin = loadKeypair(process.env.ADMIN_KEYPAIR ?? defaultAdmin);
  const programId = process.env.PROGRAM_ID ? new PublicKey(process.env.PROGRAM_ID) : PROGRAM_ID;
  const treasury = new PublicKey(process.env.TREASURY ?? admin.publicKey.toBase58());
  const keeper = new PublicKey(process.env.KEEPER ?? admin.publicKey.toBase58());

  const keysDir = resolve(here, "../keys");
  const mintPath = process.env.MINT_KEYPAIR ?? resolve(keysDir, "test-mint.json");
  const existingMint = process.env.MINT ? new PublicKey(process.env.MINT) : null;
  let mint: Keypair;
  if (existingMint) {
    mint = { publicKey: existingMint } as Keypair; // never signs: creation is skipped for an existing mint
  } else if (existsSync(mintPath)) {
    mint = loadKeypair(mintPath);
  } else {
    mint = Keypair.generate();
    if (EXECUTE) {
      mkdirSync(dirname(mintPath), { recursive: true });
      writeFileSync(mintPath, JSON.stringify(Array.from(mint.secretKey)), { mode: 0o600 });
    }
  }
  const priceSource = parsePriceSource(mint.publicKey);
  const adminAta = associatedTokenAddress(admin.publicKey, mint.publicKey);

  console.log(`mode         ${EXECUTE ? "EXECUTE" : "DRY RUN (pass --execute to send)"}`);
  console.log(`rpc          ${rpcLabel}`);
  console.log(`program      ${programId.toBase58()}`);
  console.log(`admin        ${admin.publicKey.toBase58()}`);
  console.log(`treasury     ${treasury.toBase58()}`);
  console.log(`keeper       ${keeper.toBase58()}`);
  console.log(`mint         ${mint.publicKey.toBase58()} (${existingMint ? "existing (MINT)" : existsSync(mintPath) ? "existing keypair" : "new test mint"})`);
  console.log(`price source ${JSON.stringify(priceSource, (_, v) => (v instanceof PublicKey ? v.toBase58() : v))}`);
  console.log(`config       ${configPda(programId).toBase58()}`);
  console.log(`canvas       ${canvasPda(programId).toBase58()}`);
  console.log(`vault        ${buybackVaultPda(programId).toBase58()}`);

  const txs: { label: string; tx: Transaction; signers: Keypair[] }[] = [];

  const mintInfo = await connection.getAccountInfo(mint.publicKey).catch(() => null);
  if (existingMint && !mintInfo) throw new Error("MINT does not exist on this cluster");
  const tokenProgram = mintInfo?.owner ?? TOKEN_PROGRAM_ID;
  console.log(`token prog   ${tokenProgram.toBase58()}`);
  if (!mintInfo) {
    const rent = await connection.getMinimumBalanceForRentExemption(82).catch(() => 1_461_600);
    txs.push({
      label: "create test mint (1B, 6 dec) + mint to admin ATA + revoke mint authority",
      signers: [admin, mint],
      tx: new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: admin.publicKey,
          newAccountPubkey: mint.publicKey,
          lamports: rent,
          space: 82,
          programId: TOKEN_PROGRAM_ID,
        }),
        initializeMint2(mint.publicKey, admin.publicKey),
        createAtaIdempotent(admin.publicKey, adminAta, admin.publicKey, mint.publicKey),
        mintTo(mint.publicKey, adminAta, admin.publicKey, SUPPLY),
        revokeMintAuthority(mint.publicKey, admin.publicKey),
      ),
    });
  } else {
    console.log("mint exists, skipping creation");
  }

  const treasuryInfo = await connection.getAccountInfo(treasury).catch(() => null);
  if (!treasuryInfo) {
    const rent0 = await connection.getMinimumBalanceForRentExemption(0).catch(() => 890_880);
    txs.push({
      label: "fund treasury to rent-exemption (transfers to a fresh account below rent-min would fail)",
      signers: [admin],
      tx: new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: treasury, lamports: rent0 })),
    });
  }

  // EMA seed: admin-supplied (the program never seeds from a single spot read).
  let initialEma = process.env.INITIAL_TOKEN_EMA ? BigInt(process.env.INITIAL_TOKEN_EMA) : null;
  if (initialEma === null) {
    initialEma = await readSpotPriceQ(connection, priceSource).catch(() => 0n);
  }
  console.log(`ema seed     ${initialEma === 0n ? "0 (token payments disabled until seeded via set_price_source)" : initialEma.toString()}`);

  const configured = await fetchConfig(connection, programId).catch(() => null);
  if (!configured) {
    txs.push({
      label: "initialize config/canvas/vault",
      signers: [admin],
      tx: new Transaction().add(
        initializeIx({
          admin: admin.publicKey,
          tokenMint: mint.publicKey,
          tokenProgram,
          treasury,
          keeper,
          pythFeedIdHex: SOL_USD_FEED_ID,
          priceSource,
          maxPriceAgeSecs: BigInt(process.env.MAX_PRICE_AGE_SECS ?? "120"),
          buybackCapLamportsPerHour: BigInt(Math.round(Number(process.env.BUYBACK_CAP_SOL_PER_HOUR ?? "10") * 1e9)),
          buybackMaxSlippageBps: Number(process.env.BUYBACK_MAX_SLIPPAGE_BPS ?? "1500"),
          initialTokenEmaPriceSol: initialEma,
          tokenBlocksCapPerHour: Number(process.env.TOKEN_BLOCKS_CAP_PER_HOUR ?? "1000"),
          programId,
        }),
      ),
    });
  } else {
    console.log("config already initialised, skipping");
  }

  const { blockhash } = await connection.getLatestBlockhash().catch(() => ({ blockhash: "11111111111111111111111111111111" }));
  for (const { label, tx, signers } of txs) {
    tx.recentBlockhash = blockhash;
    tx.feePayer = admin.publicKey;
    tx.sign(...signers);
    const size = tx.serialize().length;
    console.log(`\n- ${label}\n  ${tx.instructions.length} ixs, ${size} bytes`);
    if (!EXECUTE) {
      const sim = await connection.simulateTransaction(tx).catch((e: Error) => ({ value: { err: redact(e.message), logs: [] } }));
      console.log(`  simulate: ${sim.value.err ? `ERR ${JSON.stringify(sim.value.err)}` : "ok"}`);
      continue;
    }
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    console.log(`  sent ${sig}`);
  }
  if (!EXECUTE) {
    console.log("\nDry run only. Note: steps that depend on earlier ones (e.g. initialize needs the mint) fail simulation until those land.");
  }
  console.log("\nNext: keeper cranks crank_token_price every 30-60 s; token payments go live after 10 cranks spanning >= 10 min.");
}

/** Strip RPC URL and keys from anything we print on failure. */
function redact(text: string): string {
  let out = text;
  for (const secret of [process.env.SOLANA_RPC, process.env.SOLANA_RPC_HELIUS_KEY]) {
    if (secret) out = out.split(secret).join("<redacted>");
  }
  return out.replace(/api-key=[^&\s"']+/gi, "api-key=<redacted>");
}

main().catch((e: unknown) => {
  console.error(redact(e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e)));
  process.exit(1);
});
