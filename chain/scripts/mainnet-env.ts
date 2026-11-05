/**
 * Prints the Coolify env for the pre-launch switch. No mint in it: services read the mint from the on-chain Config. Read-only; never prints a secret value.
 *   node mainnet-env.ts
 *   node mainnet-env.ts --write-secrets <dir>   writes keeper-secret.json and api-secret.json (mode 600) for `coolify.py PATCH`; printed nowhere.
 * Full runbook: docs/mainnet-cutover.md
 */
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import bs58 from "bs58";
import { TOKEN_INITIAL_SUPPLY, connect, die, loadKey, main, markStep, parseArgs, programId, readState, repoDir, roles, runMode, strArg } from "./mainnet-lib.ts";

main(async () => {
  const args = parseArgs();
  const mode = runMode(args);
  await connect(mode);
  const st = readState(mode);
  const pid = programId(mode).toBase58();
  const alt = st.keeperLookupTable ?? "<KEEPER_LOOKUP_TABLE: run mainnet-keeper-alt>";
  const sh = {
    "api, indexer, keeper": { SOLANA_CLUSTER: "mainnet-beta", PROGRAM_ID: pid, TOKEN_MINT: "<delete it: the devnet mint must not stay>", TOKEN_INITIAL_SUPPLY, SOLANA_RPC: "<secret: the mainnet RPC URL>" },
    "api, indexer": { DATABASE_URL: "<secret: the NEW mainnet database, never pixelburn-db>" },
    api: { IRYS_KEY: "<secret: base58 of keys/mainnet/uploader.json, see --write-secrets>", IRYS_NETWORK: "mainnet", ARWEAVE_GATEWAY: "https://gateway.irys.xyz" },
    keeper: {
      KEEPER_KEYPAIR: `<secret: keys/mainnet/keeper.json, public key ${roles(mode).keeper.toBase58()}, see --write-secrets>`, KEEPER_LOOKUP_TABLE: alt, KEEPER_LIVE: "1", KEEPER_BUYBACK_ENABLED: "1",
      KEEPER_BUYBACK_MIN_CHUNK_LAMPORTS: "50000000", KEEPER_BUYBACK_MAX_CHUNK_LAMPORTS: "1000000000", KEEPER_BUYBACK_MAX_PER_RUN_LAMPORTS: "2000000000", KEEPER_BUYBACK_INTERVAL_MS: "900000", KEEPER_BUYBACK_JITTER_MS: "300000",
      KEEPER_BUYBACK_MAX_PRICE_IMPACT_PCT: "1", KEEPER_BUYBACK_MAX_SPOT_OVER_EMA_PCT: "10", KEEPER_BUYBACK_MAX_RUN_PRICE_MOVE_PCT: "5",
    },
    "web (build-time; needs a rebuild)": { NEXT_PUBLIC_SOLANA_CLUSTER: "mainnet-beta" },
    "web (runtime)": { SOLANA_RPC: "<secret: the mainnet RPC URL>" },
  };
  for (const [app, env] of Object.entries(sh)) {
    console.log(`\n# ${app}`);
    for (const [k, v] of Object.entries(env)) console.log(`${k}=${v}`);
  }
  console.log("\nRemove SOLANA_RPC_HELIUS_KEY from the backend apps unless the key also serves mainnet (it does for Helius: keep it as the websocket and history fallback).");
  const dir = strArg(args, "write-secrets");
  if (dir) {
    mkdirSync(resolve(dir), { recursive: true });
    const real = realpathSync(resolve(dir));
    if (!relative(realpathSync(repoDir), real).startsWith("..")) die(`--write-secrets must be outside the repo: ${real}`);
    const b = (k: string, value: string) => ({ key: k, value, is_preview: false, is_literal: true });
    const put = (name: string, body: unknown) => {
      const f = resolve(real, name);
      writeFileSync(f, JSON.stringify(body), { mode: 0o600 });
      chmodSync(f, 0o600); // `mode` above is ignored when the file already exists
    };
    put("keeper-secret.json", b("KEEPER_KEYPAIR", bs58.encode(loadKey(mode, "keeper").secretKey)));
    put("api-secret.json", b("IRYS_KEY", bs58.encode(loadKey(mode, "uploader").secretKey)));
    console.log(`\nwrote ${dir}/keeper-secret.json and api-secret.json (mode 600). Delete them after use.`);
  }
  if (mode.execute) markStep(mode, "env");
});
