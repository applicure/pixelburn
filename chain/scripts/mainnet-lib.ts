/**
 * Shared base of the mainnet-*.ts launch scripts. The rules every script gets from here:
 *  - RPC comes from MAINNET_RPC_URL only. SOLANA_RPC is never read, not even as a fallback.
 *  - The cluster's genesis hash must be mainnet's, or the process exits before anything else happens.
 *  - Dry run unless BOTH --execute and --mainnet-i-understand are given.
 *  - RPC URLs and key material are never printed; errors go through redact().
 *  - Rehearsal (--rehearsal + MPB_REHEARSAL_RPC_URL) is for testing the sending paths. It can't reach mainnet: it refuses
 *    the mainnet genesis hash, refuses --mainnet-i-understand, and uses its own keys directory and state file.
 *
 * Pure helpers (median, dispersion, budget) have no side effects and are unit-tested in mainnet-lib.test.ts.
 */
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
export const chainDir = resolve(here, "..");
export const repoDir = resolve(chainDir, "..");

export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
/** Never reuse: the devnet deployment. Every script refuses to treat this as the mainnet program. */
export const DEVNET_PROGRAM_ID = "A4uaXC9sU3UrbqcPZL4ZJMd2aKzmo5Rq4yDvRm8gpTS";

/** Owner decisions, 2026-11-05. Treasury has no key here on purpose: no script may read or need it. */
export const MAINNET_ROLES = {
  launch: "8FLcVCzsxgyH7iJRuwjk1tXREXnC4gjfh4am7tFCctEB",
  treasury: "FCgCSkEBH7nQoHw6NDPHmPbVmQMvUVQwDXGDjdn99i1J",
  creator: "DrwhHphNRoLwTkRMjHxdUU6FFsqF7oMDHyTypa2nw8Vu",
  keeper: "EKVJrMEsuKpcuaQJcxNCkpJch3rJEeB6z56YLscvaWbu",
} as const;

export const COIN = { name: "Pixel Frame", symbol: "PXL", website: "https://pixelframe.tech", image: "brand/token-image-1000.png",
  description: "The million-pixel billboard on Solana. Pay in SOL or $PXL; every token paid is burned, and half of every SOL payment buys $PXL back and burns it." } as const;
export const TOKEN_INITIAL_SUPPLY = "1000000000000000"; // pump.fun: 1e9 tokens x 1e6

/** chain/NOTES.md "Mainnet initialize parameters". */
export const INIT_PARAMS = {
  maxPriceAgeSecs: 120n,
  tokenBlocksCapPerHour: 250,
  buybackCapLamportsPerHour: 2_000_000_000n,
  buybackMaxSlippageBps: 1500,
} as const;

export const KEEPER_FLOAT_LAMPORTS = 500_000_000n;
export const UPLOADER_FLOAT_LAMPORTS = 100_000_000n;
export const PROGRAM_HEADROOM_PCT = 25n;
export const LAUNCH_BUDGET_LAMPORTS = 12_000_000_000n;

export const SAMPLE_INTERVAL_SECS = 10;
export const SAMPLE_WINDOW_SECS = 600;
export const SAMPLE_MAX_RATIO = 1.25;
export const GRAD_MEDIAN_WINDOW_SECS = 60;
export const GRAD_MAX_DISPERSION = 0.10;

// ---------------------------------------------------------------- pure helpers
export const sol = (lamports: bigint | number) => (Number(lamports) / 1e9).toFixed(4);

export function solToLamports(v: string): bigint {
  if (!/^\d+(\.\d{1,9})?$/.test(v)) throw new Error(`not a SOL amount: "${v}"`);
  const [w, f = ""] = v.split(".");
  return BigInt(w!) * 1_000_000_000n + BigInt(f.padEnd(9, "0"));
}

export function medianBig(xs: readonly bigint[]): bigint {
  if (xs.length === 0) throw new Error("median of nothing");
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2n;
}

/** max/min of the samples. Fractional accuracy is plenty: this is compared against 1.25. */
export function maxMinRatio(xs: readonly bigint[]): number {
  if (xs.length === 0) throw new Error("ratio of nothing");
  let lo = xs[0]!, hi = xs[0]!;
  for (const x of xs) { if (x < lo) lo = x; if (x > hi) hi = x; }
  if (lo <= 0n) return Number.POSITIVE_INFINITY;
  return Number((hi * 1_000_000n) / lo) / 1_000_000;
}

/** Largest relative distance of any sample from the median, e.g. 0.10 = 10%. */
export function dispersionFromMedian(xs: readonly bigint[]): number {
  const m = medianBig(xs);
  if (m <= 0n) return Number.POSITIVE_INFINITY;
  let worst = 0n;
  for (const x of xs) { const d = x > m ? x - m : m - x; if (d > worst) worst = d; }
  return Number((worst * 1_000_000n) / m) / 1_000_000;
}

export interface BudgetInput {
  soBytes: number;
  rent: (bytes: number) => bigint;
  launchBuyLamports: bigint;
  keeperBalance: bigint;
  creatorBalance: bigint;
  uploaderBalance: bigint;
  treasuryBalance: bigint;
  /** Already-spent items count as done, so preflight stays correct on a re-run. */
  deployed: boolean;
  coinCreated: boolean;
  initialized: boolean;
}
export interface BudgetLine { item: string; lamports: bigint; refunded?: boolean; note?: string }

export const PROGRAMDATA_HEADER = 45;
export const BUFFER_HEADER = 37;
export const PROGRAM_ACCOUNT_BYTES = 36;
export const CONFIG_BYTES = 544;
export const CANVAS_BYTES = 1321;
/** Fee and rent margin on top of the launch buy: pump curve fees (~1.25%), curve + ATA + metadata rents, tx fee. */
export const CREATOR_MARGIN_LAMPORTS = 150_000_000n;
const DEPLOY_FEES_LAMPORTS = 50_000_000n; // ~600 write txs + priority, upper bound
const MISC_FEES_LAMPORTS = 20_000_000n;   // fund, init, verification PDA, keeper ALT, graduation
export const VERIFY_PDA_LAMPORTS = 5_000_000n;

export const maxLenFor = (soBytes: number) => Math.ceil((soBytes * Number(100n + PROGRAM_HEADROOM_PCT)) / 100);

/**
 * What the launch wallet has to pay out, at its peak (the buffer is refunded only when the deploy lands, so the peak holds
 * buffer AND programdata rent at once). `required` is the number preflight compares with the wallet's balance.
 */
export function launchBudget(b: BudgetInput): { lines: BudgetLine[]; required: bigint; netAfterRefund: bigint } {
  const maxLen = maxLenFor(b.soBytes);
  const creatorTarget = b.launchBuyLamports + CREATOR_MARGIN_LAMPORTS;
  const top = (target: bigint, have: bigint) => (have >= target ? 0n : target - have);
  const lines: BudgetLine[] = [
    { item: `buffer rent (${b.soBytes} B .so), refunded when the deploy lands`, lamports: b.deployed ? 0n : b.rent(BUFFER_HEADER + b.soBytes), refunded: true },
    { item: `programdata rent (--max-len ${maxLen}, ${PROGRAM_HEADROOM_PCT}% headroom)`, lamports: b.deployed ? 0n : b.rent(PROGRAMDATA_HEADER + maxLen) },
    { item: "program account rent", lamports: b.deployed ? 0n : b.rent(PROGRAM_ACCOUNT_BYTES) },
    { item: "deploy tx fees + priority (upper bound)", lamports: b.deployed ? 0n : DEPLOY_FEES_LAMPORTS },
    { item: `keeper float, top up to ${sol(KEEPER_FLOAT_LAMPORTS)}`, lamports: top(KEEPER_FLOAT_LAMPORTS, b.keeperBalance) },
    { item: `creator: launch buy ${sol(b.launchBuyLamports)} + margin ${sol(CREATOR_MARGIN_LAMPORTS)}`, lamports: b.coinCreated ? 0n : top(creatorTarget, b.creatorBalance) },
    { item: `uploader float for Arweave, top up to ${sol(UPLOADER_FLOAT_LAMPORTS)}`, lamports: top(UPLOADER_FLOAT_LAMPORTS, b.uploaderBalance) },
    { item: "treasury rent-exemption (fresh account only)", lamports: top(b.rent(0), b.treasuryBalance) },
    { item: "initialize: config + canvas + vault rent", lamports: b.initialized ? 0n : b.rent(CONFIG_BYTES) + b.rent(CANVAS_BYTES) + b.rent(0) },
    { item: "verification PDA", lamports: VERIFY_PDA_LAMPORTS },
    { item: "other tx fees (upper bound)", lamports: MISC_FEES_LAMPORTS },
  ];
  const required = lines.reduce((a, l) => a + l.lamports, 0n);
  const refund = lines.filter((l) => l.refunded).reduce((a, l) => a + l.lamports, 0n);
  return { lines, required, netAfterRefund: required - refund };
}

// ---------------------------------------------------------------- args + guard
export interface RunMode {
  execute: boolean;
  rehearsal: boolean;
  /** Only used for rehearsal: its own keys. Mainnet's are chain/keys/mainnet. */
  keysDir: string;
  statePath: string;
  args: Map<string, string | true>;
}

export function parseArgs(argv = process.argv.slice(2)): Map<string, string | true> {
  const m = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) { m.set(a.slice(2, eq), a.slice(eq + 1)); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { m.set(a.slice(2), next); i++; } else m.set(a.slice(2), true);
  }
  return m;
}

export function die(msg: string): never {
  console.error(`REFUSING: ${redact(msg)}`);
  process.exit(1);
}

/** Decides the mode from flags alone. The genesis check happens in connect(). */
export function runMode(args = parseArgs()): RunMode {
  const rehearsal = args.has("rehearsal");
  const execute = args.has("execute");
  if (rehearsal && args.has("mainnet-i-understand")) die("--rehearsal and --mainnet-i-understand exclude each other");
  if (!rehearsal && execute && !args.has("mainnet-i-understand")) die("--execute on mainnet also needs --mainnet-i-understand");
  if (!rehearsal && !execute && args.has("mainnet-i-understand")) console.log("note: --mainnet-i-understand without --execute is still a dry run");
  const keysDir = rehearsal ? resolve(process.env.MPB_REHEARSAL_KEYS_DIR ?? resolve(chainDir, ".rehearsal/keys")) : resolve(chainDir, "keys/mainnet");
  const statePath = rehearsal ? resolve(chainDir, ".rehearsal/state.json") : resolve(chainDir, ".mainnet-state.json");
  return { execute, rehearsal, keysDir, statePath, args };
}

const secretValues = () => [process.env.MAINNET_RPC_URL, process.env.MPB_REHEARSAL_RPC_URL, process.env.SOLANA_RPC, process.env.SOLANA_RPC_HELIUS_KEY, process.env.GRADUATION_WEBHOOK_URL];

export function redact(text: string): string {
  let out = text;
  for (const s of secretValues()) if (s) out = out.split(s).join("<rpc>");
  return out
    .replace(/api-key=[^&\s"']+/gi, "api-key=<redacted>")
    .replace(/https?:\/\/[^\s"']*(quiknode|quicknode|helius|alchemy|triton|rpcpool)[^\s"']*/gi, "<rpc>");
}

/** Connects and verifies the cluster, and exits(1) on anything but the expected one. */
export async function connect(mode: RunMode): Promise<{ connection: Connection; url: string; label: string; genesis: string }> {
  const url = mode.rehearsal ? process.env.MPB_REHEARSAL_RPC_URL : process.env.MAINNET_RPC_URL;
  const varName = mode.rehearsal ? "MPB_REHEARSAL_RPC_URL" : "MAINNET_RPC_URL";
  if (!url) die(`${varName} is not set${mode.rehearsal ? "" : " (SOLANA_RPC is deliberately not read: pass it explicitly as MAINNET_RPC_URL)"}`);
  const connection = new Connection(url, { commitment: "confirmed", disableRetryOnRateLimit: false });
  let genesis: string;
  try {
    genesis = await connection.getGenesisHash();
  } catch (e) {
    die(`cannot verify the cluster behind ${varName}: ${(e as Error).message}`);
  }
  if (mode.rehearsal) {
    if (genesis === MAINNET_GENESIS_HASH) die(`${varName} is mainnet; a rehearsal can't run there`);
    const local = /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url);
    if (!local && genesis !== DEVNET_GENESIS_HASH) die(`${varName} is neither localhost nor devnet (genesis ${genesis})`);
    return { connection, url, genesis, label: `REHEARSAL ${local ? "localnet" : "devnet"} (${varName})` };
  }
  if (genesis !== MAINNET_GENESIS_HASH) die(`${varName} is not mainnet (genesis ${genesis}, expected ${MAINNET_GENESIS_HASH})`);
  return { connection, url, genesis, label: `mainnet (${varName}, redacted)` };
}

// ---------------------------------------------------------------- keys
export function keypath(mode: RunMode, name: string): string {
  if (name === "treasury" || name === "OWNER-EXPORT-private-keys") die("no script may read the treasury key or the owner export");
  return resolve(mode.keysDir, `${name}.json`);
}

export function loadKey(mode: RunMode, name: string): Keypair {
  const p = keypath(mode, name);
  if (!existsSync(p)) die(`missing key file for "${name}" under ${mode.keysDir}`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
}

/** Creates the key file if absent (mode 600), never overwrites one. Returns the public key only. */
export function ensureKey(mode: RunMode, name: string): { pubkey: PublicKey; created: boolean } {
  const p = keypath(mode, name);
  if (existsSync(p)) return { pubkey: loadKey(mode, name).publicKey, created: false };
  const kp = Keypair.generate();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600, flag: "wx" });
  chmodSync(p, 0o600);
  return { pubkey: kp.publicKey, created: true };
}

/** Public keys of the roles. On mainnet they're fixed and the key files must match. In rehearsal they're whatever the keys dir holds. */
export function roles(mode: RunMode): { launch: PublicKey; treasury: PublicKey; creator: PublicKey; keeper: PublicKey } {
  if (mode.rehearsal) {
    const r = (n: string) => ensureKey(mode, n).pubkey;
    return { launch: r("launch"), treasury: r("rehearsal-treasury"), creator: r("creator"), keeper: r("keeper") };
  }
  return { launch: new PublicKey(MAINNET_ROLES.launch), treasury: new PublicKey(MAINNET_ROLES.treasury), creator: new PublicKey(MAINNET_ROLES.creator), keeper: new PublicKey(MAINNET_ROLES.keeper) };
}

/** The program id as committed to the source: `#[cfg(feature = "mainnet")] declare_id!`. */
export function declaredMainnetId(): string {
  const src = readFileSync(resolve(chainDir, "programs/pixel/src/lib.rs"), "utf8");
  const m = /#\[cfg\(feature = "mainnet"\)\]\s*declare_id!\("([^"]+)"\)/.exec(src);
  if (!m) die("no feature-gated mainnet declare_id! in programs/pixel/src/lib.rs (run mainnet-program-id.ts)");
  return m[1]!;
}

/** Program id for this run; the keypair must match the committed id, and it is never the devnet one. */
export function programId(mode: RunMode): PublicKey {
  const id = declaredMainnetId();
  if (id === DEVNET_PROGRAM_ID) die("the mainnet declare_id! is the devnet program id");
  return new PublicKey(id);
}

// ---------------------------------------------------------------- resumable state (no secrets, gitignored)
export interface StepRecord { at: string; sig?: string; [k: string]: unknown }
export interface LaunchState {
  version: 1;
  steps: Record<string, StepRecord>;
  programId?: string;
  mint?: string;
  curve?: string;
  metadataUri?: string;
  imageUri?: string;
  build?: { sha256: string; bytes: number; commit: string; verifiable: boolean; path: string };
  samples?: { medianQ: string; count: number; ratio: number; firstAt: string; lastAt: string; graduated: boolean };
  keeperLookupTable?: string;
}

export function readState(mode: RunMode): LaunchState {
  if (!existsSync(mode.statePath)) return { version: 1, steps: {} };
  return JSON.parse(readFileSync(mode.statePath, "utf8")) as LaunchState;
}

/** Atomic: a crash mid-write can't leave half a state file. */
export function writeState(mode: RunMode, s: LaunchState) {
  mkdirSync(dirname(mode.statePath), { recursive: true });
  const tmp = `${mode.statePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  renameSync(tmp, mode.statePath);
}

export function markStep(mode: RunMode, step: string, rec: Omit<StepRecord, "at"> = {}) {
  const s = readState(mode);
  s.steps[step] = { ...rec, at: new Date().toISOString() };
  writeState(mode, s);
}

// ---------------------------------------------------------------- CLI + tx helpers
/** Runs the solana CLI with an explicit --url and with its output redacted. Throws on a non-zero exit. */
export function solanaCli(url: string, args: string[], opts: { capture?: boolean } = {}): string {
  const r = spawnSync("solana", [...args, "--url", url], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = redact(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (!opts.capture) process.stdout.write(out);
  if (r.status !== 0) throw new Error(`solana ${args[0]} ${args[1] ?? ""} failed: ${out.split("\n").slice(-6).join(" | ")}`);
  return out;
}

export const hasCommand = (cmd: string, args = ["--version"]) => {
  try { execFileSync(cmd, args, { stdio: "ignore" }); return true; } catch { return false; }
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Priority fee: 75th percentile of recent fees on the given accounts, clamped so a spike can't burn the budget. */
export async function priorityMicroLamports(c: Connection, accounts: PublicKey[] = [], floor = 10_000, ceil = 2_000_000): Promise<number> {
  const fees = await c.getRecentPrioritizationFees({ lockedWritableAccounts: accounts }).catch(() => []);
  const xs = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
  const p75 = xs.length ? xs[Math.floor(xs.length * 0.75)]! : 0;
  return Math.min(ceil, Math.max(floor, p75));
}

export interface SendOpts { units: number; microLamports?: number; extraSigners?: Keypair[]; lookupTables?: never }

export async function buildTx(c: Connection, payer: PublicKey, ixs: TransactionInstruction[], o: SendOpts) {
  const bh = await c.getLatestBlockhash("confirmed");
  const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: o.units })];
  if (o.microLamports) budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: o.microLamports }));
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: bh.blockhash, instructions: [...budget, ...ixs] }).compileToV0Message();
  return { tx: new VersionedTransaction(msg), ...bh };
}

/** Signs and rebroadcasts until confirmed or the blockhash expires. Throws with the on-chain error; never reports an unconfirmed signature as done. */
export async function sendAndConfirm(c: Connection, tx: VersionedTransaction, lastValidBlockHeight: number, signers: Keypair[]): Promise<string> {
  tx.sign(signers);
  const raw = tx.serialize();
  const sig = await c.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0 });
  for (;;) {
    const st = await c.getSignatureStatus(sig);
    if (st.value?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(st.value.err)}`);
    if (st.value?.confirmationStatus === "confirmed" || st.value?.confirmationStatus === "finalized") return sig;
    if ((await c.getBlockHeight("confirmed")) > lastValidBlockHeight) throw new Error(`tx ${sig} expired before confirming; re-run the step (it checks chain state first)`);
    await c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    await sleep(2_000);
  }
}

export async function simulate(c: Connection, tx: VersionedTransaction): Promise<{ ok: boolean; err: unknown; units?: number; logs: string[] }> {
  const sim = await c.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  return { ok: !sim.value.err, err: sim.value.err, units: sim.value.unitsConsumed, logs: sim.value.logs ?? [] };
}

export const explorer = (mode: RunMode, kind: "tx" | "address", id: string) =>
  mode.rehearsal ? `${kind}:${id}` : `https://explorer.solana.com/${kind}/${id}`;

/** Standard wrapper: prints errors redacted and sets the exit code. */
export function main(fn: () => Promise<void>) {
  fn().catch((e: unknown) => {
    console.error(redact(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  });
}

export const stringifyBig = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x instanceof PublicKey ? x.toBase58() : x), 2);

export function sha256File(path: string): Promise<string> {
  return import("node:crypto").then(({ createHash }) => createHash("sha256").update(readFileSync(path)).digest("hex"));
}

void Transaction;
