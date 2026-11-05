// node --test mainnet-lib.test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { dispersionFromMedian, launchBudget, maxLenFor, maxMinRatio, medianBig, parseArgs, redact, runMode, solToLamports } from "./mainnet-lib.ts";

const run = (file: string, args: string[], env: Record<string, string> = {}) => spawnSync("node", [file, ...args], { encoding: "utf8", env: { PATH: process.env.PATH!, ...env } });

test("median, ratio, dispersion", () => {
  assert.equal(medianBig([3n, 1n, 2n]), 2n);
  assert.equal(medianBig([1n, 2n, 3n, 4n]), 2n);
  assert.equal(maxMinRatio([100n, 125n]), 1.25);
  assert.ok(maxMinRatio([100n, 126n]) > 1.25);
  assert.equal(maxMinRatio([5n, 5n, 5n]), 1); // an untraded curve
  assert.equal(dispersionFromMedian([100n, 100n, 110n]), 0.1);
  assert.ok(dispersionFromMedian([100n, 100n, 111n]) > 0.1);
  assert.equal(maxMinRatio([0n, 5n]), Infinity);
});

test("SOL amounts are strict; 0 is valid", () => {
  assert.equal(solToLamports("0"), 0n);
  assert.equal(solToLamports("1.5"), 1_500_000_000n);
  for (const bad of ["", "abc", "-1", "1e3", "1.0000000001"]) assert.throws(() => solToLamports(bad));
});

const rent = (n: number) => BigInt(128 + n) * 6960n;
const base = { soBytes: 580_000, rent, launchBalance: 12_000_000_000n, keeperBalance: 0n, uploaderBalance: 0n, treasuryBalance: 0n, openBufferLamports: 0n, solBuyLamports: 1_000_000_000n, tokenBuyLamports: 1_000_000_000n, deployed: false, initialized: false };

test("budget: peak holds buffer and programdata at once; the creator isn't in it", () => {
  const b = launchBudget(base);
  assert.equal(maxLenFor(1000), 1250);
  assert.ok(b.fits);
  assert.equal(b.peakAtDeploy - b.net, rent(37 + 580_000));
  assert.ok(!b.lines.some((l) => /creator|dev buy|coin/i.test(l.item)));
  assert.equal(b.spare, 12_000_000_000n - b.net - b.smokeReserve);
});

test("budget fails when either the peak or the net doesn't fit, and a finished deploy no longer counts", () => {
  assert.equal(launchBudget({ ...base, launchBalance: 9_000_000_000n }).fits, false);
  assert.equal(launchBudget({ ...base, launchBalance: 11_000_000_000n, solBuyLamports: 7_000_000_000n }).fits, false);
  const after = launchBudget({ ...base, deployed: true, initialized: true, keeperBalance: 500_000_000n, uploaderBalance: 100_000_000n, treasuryBalance: rent(0), launchBalance: 6_000_000_000n });
  assert.ok(after.fits);
  assert.ok(after.net < 100_000_000n);
  const interrupted = launchBudget({ ...base, launchBalance: 5_000_000_000n, openBufferLamports: 4_100_000_000n, solBuyLamports: 0n, tokenBuyLamports: 0n, soBytes: 400_000 });
  assert.ok(interrupted.fits);
});

test("guards: flags, redaction", () => {
  assert.deepEqual([...parseArgs(["--a", "1", "--b", "--c=2"]).entries()], [["a", "1"], ["b", true], ["c", "2"]]);
  const r = redact("failed at https://x.quiknode.pro/secret/ with api-key=abc");
  assert.ok(!r.includes("secret") && !r.includes("abc"));
  assert.equal(runMode(new Map()).execute, false);
  assert.ok(runMode(new Map([["rehearsal", true]])).statePath.includes(".rehearsal"));
});

const scripts = ["mainnet-fund.ts", "mainnet-deploy.ts", "mainnet-init.ts"];
test("no RPC variable but MAINNET_RPC_URL counts; SOLANA_RPC is not a fallback", () => {
  const r = run("mainnet-fund.ts", [], { SOLANA_RPC: "https://example.invalid" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /MAINNET_RPC_URL is not set/);
});
test("--execute alone refuses; --rehearsal can't combine with the mainnet flag", () => {
  for (const f of scripts) {
    const r = run(f, ["--execute"], { MAINNET_RPC_URL: "https://example.invalid" });
    assert.equal(r.status, 1, f);
    assert.match(r.stderr, /--mainnet-i-understand/, f);
  }
  const r = run("mainnet-fund.ts", ["--rehearsal", "--mainnet-i-understand", "--execute"], { MPB_REHEARSAL_RPC_URL: "http://127.0.0.1:1" });
  assert.match(r.stderr, /exclude each other/);
});
test("init requires the mint", () => {
  const r = run("mainnet-init.ts", [], { MAINNET_RPC_URL: "https://example.invalid" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--mint/);
});
test("failover URLs are redacted", () => {
  process.env.MAINNET_RPC_URL_2 = "https://second.example/secretpath";
  assert.ok(!redact("x https://second.example/secretpath y").includes("secretpath"));
  delete process.env.MAINNET_RPC_URL_2;
});
test("no script loads the treasury or creator key or reads the owner export", () => {
  for (const f of readdirSync(".").filter((x) => /^mainnet-.*\.ts$/.test(x) && !x.endsWith(".test.ts") && x !== "mainnet-lib.ts")) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/loadKey\(mode, "(treasury|creator)"\)/.test(src), f);
    assert.ok(!/OWNER-EXPORT/.test(src), f);
  }
});
test("the lib refuses the treasury and creator keys at the source", () => {
  for (const k of ["treasury", "creator"]) {
    const out = spawnSync("node", ["--input-type=module", "-e", `import { loadKey, runMode } from "./mainnet-lib.ts"; loadKey(runMode(new Map()), "${k}");`], { encoding: "utf8" });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /no script may read/);
  }
});

test("validateMint: SOL or exactly PUMP, mayhem still refused", async () => {
  const { validateMint } = await import("./mainnet-mint.ts");
  const { PublicKey } = await import("@solana/web3.js");
  const { PUMP_PROGRAM_ID, PUMP_QUOTE_MINT, TOKEN_PROGRAM_ID } = await import("@mpb/sdk");
  const mint = new PublicKey("69GLwTLVuwnaeNPjUixo6CSXKkEYeQ2WQrBVwmQKhT4C");
  const creator = new PublicKey("FKKi6ooqW26YyGTTMdBR4zGsGXYSLSEPE9mLZZz6hWmq");
  const mintData = Buffer.alloc(82);
  mintData.writeBigUInt64LE(1_000_000_000_000_000n, 36);
  mintData[44] = 6;
  const check = async (quote: Uint8Array | null, mayhem = false) => {
    const curve = Buffer.alloc(166);
    Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]).copy(curve);
    curve.writeBigUInt64LE(1_073_000_000_000_000n, 8);
    curve.writeBigUInt64LE(30_000_000_000n, 16);
    curve.writeBigUInt64LE(1_000_000_000_000_000n, 40);
    curve.set(creator.toBytes(), 49);
    if (mayhem) curve[81] = 1;
    if (quote) curve.set(quote, 83);
    const conn = {
      getMultipleAccountsInfo: async () => [{ owner: TOKEN_PROGRAM_ID, data: mintData }, { owner: PUMP_PROGRAM_ID, data: curve }],
      getAccountInfo: async () => null,
    };
    return validateMint([conn as never], mint, { expectName: undefined, expectCreator: creator.toBase58() });
  };
  const has = (r: { errors: string[] }, t: string) => r.errors.some((e) => e.includes(t));
  const pump = await check(PUMP_QUOTE_MINT.toBytes());
  assert.equal(pump.quote, "pump");
  assert.equal(pump.spot, null, "PUMP units are not a SOL price");
  assert.ok(!has(pump, "quoted in"));
  const sol = await check(null);
  assert.equal(sol.quote, "sol");
  assert.ok(sol.spot! > 0n);
  const other = await check(new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").toBytes());
  assert.ok(has(other, "only SOL or PUMP"));
  assert.ok(has(await check(PUMP_QUOTE_MINT.toBytes(), true), "mayhem"));
});
